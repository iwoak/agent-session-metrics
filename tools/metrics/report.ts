#!/usr/bin/env tsx
/**
 * Generates `tools/metrics/REPORT.md` from the records on
 * `refs/agent-metrics/sessions/*`: cost, turns, collection health, and —
 * for each merged PR — whether CI passed on the first push and how many
 * red→green bounces it had before merging.
 *
 * Steps, in the same order as the code:
 * 1. fetch all `refs/agent-metrics/sessions/*` refs in one shot;
 * 2. read each `record.json` via `git show`;
 * 3. cost from `pricing.json`, per model — a model with no price ends up
 *    in an explicit aggregate, never in a silent recalculation to zero;
 * 4. `gh pr list` (all PRs, one shot) + `gh run list` (all CI runs, one
 *    shot) — the fix for branch name reuse (PR time window, not just
 *    branch name) applies here;
 * 5. cycle time: branch's first commit outside `main` → `mergedAt`;
 * 6. aggregation per role and per PR following the attribution rule (no
 *    double counting on multi-branch sessions);
 * 7. collection health: sessions known locally vs. records on the remote;
 * 8. writing `REPORT.md`, committed — generated, never hand-written.
 *
 * This file doesn't import anything from the rest of whatever repository
 * hosts it: it only reads git, `gh`, and this tool's own files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionRecord, TokenTotals } from './collect.js';
import {
  filterRunsByWindow,
  greenOnFirstRun,
  nonIgnoredSequence,
  redToGreenTransitions,
} from './ci-history.js';
import {
  fetchAllCiRuns,
  fetchAllPrs,
  fetchPrCommits,
  firstCommitDate,
  groupRunsByBranch,
  type PrMeta,
  type RawCiRun,
} from './gh.js';

/**
 * Name of the GitHub Actions workflow to query with `gh run list
 * --workflow <name>` — must match the `name:` field at the top of the
 * workflow's YAML file. Configurable because not every repository calls
 * its own workflow "CI".
 */
const CI_WORKFLOW_NAME = process.env.METRICS_CI_WORKFLOW ?? 'CI';

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function repoRoot(): string {
  return resolve(moduleDir(), '../..');
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot() }).toString();
}

// ---------------------------------------------------------------------------
// 1-2. Fetching refs and reading records
// ---------------------------------------------------------------------------

/**
 * A single round-trip: the refspec brings every remote
 * `refs/agent-metrics/sessions/<id>` under `refs/remotes/agent-metrics/<id>`
 * locally.
 */
function fetchSessionRefs(): void {
  execFileSync(
    'git',
    ['fetch', 'origin', '+refs/agent-metrics/sessions/*:refs/remotes/agent-metrics/*', '--prune'],
    { cwd: repoRoot(), stdio: 'ignore' },
  );
}

function listLocalSessionRefs(): string[] {
  try {
    return git(['for-each-ref', '--format=%(refname)', 'refs/remotes/agent-metrics/'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readRecordFromRef(ref: string): SessionRecord | null {
  try {
    return JSON.parse(git(['show', `${ref}:record.json`])) as SessionRecord;
  } catch {
    return null;
  }
}

function loadAllRecords(): SessionRecord[] {
  fetchSessionRefs();
  const refs = listLocalSessionRefs();
  const records: SessionRecord[] = [];
  for (const ref of refs) {
    const record = readRecordFromRef(ref);
    if (record) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// 3. Cost from pricing.json
// ---------------------------------------------------------------------------

interface ModelPrice {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

interface PricingTable {
  as_of: string;
  source: string;
  currency: string;
  prices_per_million_tokens: Record<string, ModelPrice>;
}

function loadPricing(): PricingTable {
  return JSON.parse(readFileSync(join(moduleDir(), 'pricing.json'), 'utf8')) as PricingTable;
}

function costOfTokens(tokens: TokenTotals, price: ModelPrice): number {
  return (
    (tokens.input / 1_000_000) * price.input +
    (tokens.output / 1_000_000) * price.output +
    (tokens.cache_creation / 1_000_000) * price.cache_write +
    (tokens.cache_read / 1_000_000) * price.cache_read
  );
}

/**
 * Sums only models with a known price; models without a price come back
 * separately in `missingModels`, never silently computed as zero.
 */
function costOfRecord(
  record: SessionRecord,
  pricing: PricingTable,
): { usd: number; missingModels: string[] } {
  let usd = 0;
  const missingModels: string[] = [];
  for (const [model, tokens] of Object.entries(record.tokens_by_model)) {
    const price = pricing.prices_per_million_tokens[model];
    if (!price) {
      missingModels.push(model);
      continue;
    }
    usd += costOfTokens(tokens, price);
  }
  return { usd, missingModels };
}

// ---------------------------------------------------------------------------
// 5. Cycle time
// ---------------------------------------------------------------------------

/**
 * First commit after `main`, ISO 8601. `git log` on `origin/<branch>`
 * fails when GitHub has deleted the branch after the merge (common): `gh
 * pr view <number> --json commits` returns commit data even for a deleted
 * branch, because it comes from the API, not the local git filesystem.
 * `null` only if the PR number no longer resolves via `gh` — a known, rare
 * limitation, not an error worth throwing over.
 */
function firstCommitAfterMain(prNumber: number): string | null {
  try {
    return firstCommitDate(fetchPrCommits(prNumber));
  } catch {
    return null;
  }
}

function cycleTimeHours(firstCommitIso: string | null, mergedAtIso: string | null): number | null {
  if (!firstCommitIso || !mergedAtIso) return null;
  const start = Date.parse(firstCommitIso);
  const end = Date.parse(mergedAtIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return (end - start) / (60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// 6. Aggregation per role and per PR — attribution rule
// ---------------------------------------------------------------------------

interface RecordCost {
  record: SessionRecord;
  usd: number;
  missingModels: string[];
}

interface PrRow {
  pr: PrMeta;
  records: RecordCost[];
  ci: { greenOnFirstPush: boolean | null; redToGreenTransitions: number };
  cycleTimeHours: number | null;
}

interface Aggregation {
  perPr: PrRow[];
  multiBranch: RecordCost[];
  withoutPr: RecordCost[];
  perRole: Map<string, { count: number; turns: number; usd: number }>;
}

/**
 * Session→PR attribution rule: a single-branch session goes to the PR
 * with that `headRefName` — only this case enters the per-PR table. A
 * multi-branch session is excluded from that table and counted **only
 * once** in the separate bucket, never once per branch.
 *
 * CI per PR: `runsByBranch` carries **all** of the repository's CI runs,
 * grouped by branch — a single `gh run list` instead of one per PR. The
 * filter by PR time window (not just branch name) resolves branch reuse
 * across distinct PRs.
 */
function aggregate(
  records: RecordCost[],
  prs: PrMeta[],
  runsByBranch: Map<string, RawCiRun[]>,
  nowIso: string,
): Aggregation {
  const prByBranch = new Map(prs.map((pr) => [pr.headRefName, pr]));
  const perPrRecords = new Map<number, RecordCost[]>();
  const multiBranch: RecordCost[] = [];
  const withoutPr: RecordCost[] = [];
  const perRole = new Map<string, { count: number; turns: number; usd: number }>();

  for (const rc of records) {
    const role = rc.record.agent_type ?? 'unknown';
    const roleAgg = perRole.get(role) ?? { count: 0, turns: 0, usd: 0 };
    roleAgg.count += 1;
    roleAgg.turns += rc.record.turns;
    roleAgg.usd += rc.usd;
    perRole.set(role, roleAgg);

    if (rc.record.branches_seen.length > 1) {
      multiBranch.push(rc);
      continue;
    }
    const branch = rc.record.branch_start;
    const pr = branch ? prByBranch.get(branch) : undefined;
    if (!pr) {
      withoutPr.push(rc);
      continue;
    }
    const list = perPrRecords.get(pr.number) ?? [];
    list.push(rc);
    perPrRecords.set(pr.number, list);
  }

  const perPr: PrRow[] = [];
  for (const pr of prs) {
    const prRecords = perPrRecords.get(pr.number);
    if (!prRecords || prRecords.length === 0) continue;
    const window = { from: pr.createdAt, to: pr.mergedAt ?? pr.closedAt ?? nowIso };
    const sequence = nonIgnoredSequence(filterRunsByWindow(runsByBranch.get(pr.headRefName) ?? [], window));
    perPr.push({
      pr,
      records: prRecords,
      ci: { greenOnFirstPush: greenOnFirstRun(sequence), redToGreenTransitions: redToGreenTransitions(sequence) },
      cycleTimeHours: cycleTimeHours(firstCommitAfterMain(pr.number), pr.mergedAt),
    });
  }

  return { perPr, multiBranch, withoutPr, perRole };
}

// ---------------------------------------------------------------------------
// 7. Collection health
// ---------------------------------------------------------------------------

function claudeProjectsDir(): string {
  return join(process.env.HOME ?? '', '.claude', 'projects');
}

/** Same `cwd` sanitization used by Claude Code for the project folder name. */
function sanitizedCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Sessions (main and sub-agents) known on **this** machine, same project
 * directory the report runs from — same criterion as `SessionStart`'s
 * sweep in `collect.ts`. Declared limitation: it doesn't see a session
 * that was never written locally on any reachable machine.
 */
function localKnownSessionIds(): Set<string> {
  const dir = join(claudeProjectsDir(), sanitizedCwd(repoRoot()));
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.jsonl')) ids.add(entry.slice(0, -'.jsonl'.length));
    const subDir = join(dir, entry, 'subagents');
    if (!existsSync(subDir)) continue;
    for (const sub of readdirSync(subDir)) {
      if (sub.endsWith('.jsonl')) ids.add(sub.slice(0, -'.jsonl'.length));
    }
  }
  return ids;
}

interface Health {
  localCount: number;
  remoteCount: number;
  missingOnRemote: string[];
}

function computeHealth(localIds: Set<string>, records: SessionRecord[]): Health {
  const remoteIds = new Set(records.map((r) => r.session_id));
  return {
    localCount: localIds.size,
    remoteCount: records.length,
    missingOnRemote: [...localIds].filter((id) => !remoteIds.has(id)).sort(),
  };
}

// ---------------------------------------------------------------------------
// 8. Markdown
// ---------------------------------------------------------------------------

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function hours(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(1)}h`;
}

function bool(n: boolean | null): string {
  return n === null ? '—' : n ? 'yes' : 'no';
}

function renderReport(
  aggregation: Aggregation,
  health: Health,
  pricing: PricingTable,
  missingPriceCounts: Map<string, number>,
  nowIso: string,
): string {
  const lines: string[] = [];
  lines.push('# Agent metrics report');
  lines.push('');
  lines.push(
    '_Generated by `pnpm metrics:report` — do not edit by hand. The historical series is this file\'s Git history (`git log -p tools/metrics/REPORT.md`)._',
  );
  lines.push('');

  lines.push('## Collection health');
  lines.push('');
  lines.push(`- Sessions known locally (this machine): ${health.localCount}`);
  lines.push(`- Records found on \`origin\` (\`refs/agent-metrics/sessions/*\`): ${health.remoteCount}`);
  if (health.missingOnRemote.length === 0) {
    lines.push('- Missing on remote: none');
  } else {
    lines.push(`- Missing on remote (${health.missingOnRemote.length}): ${health.missingOnRemote.map((id) => `\`${id}\``).join(', ')}`);
  }
  lines.push('');
  lines.push(
    '_Declared limitation: this line only sees sessions still present locally on this machine — it doesn\'t detect a session that was never synchronized anywhere._',
  );
  lines.push('');

  lines.push('## Per merged PR');
  lines.push('');
  if (aggregation.perPr.length === 0) {
    lines.push('_No single-branch session attributable to a PR found so far._');
  } else {
    lines.push('| PR | Branch | Sessions | Turns | Cost | Green on first push | Red→green | Cycle time |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const row of aggregation.perPr) {
      const turns = row.records.reduce((sum, r) => sum + r.record.turns, 0);
      const cost = row.records.reduce((sum, r) => sum + r.usd, 0);
      lines.push(
        `| #${row.pr.number} | \`${row.pr.headRefName}\` | ${row.records.length} | ${turns} | ${usd(cost)} | ${bool(row.ci.greenOnFirstPush)} | ${row.ci.redToGreenTransitions} | ${hours(row.cycleTimeHours)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Per role (agent_type)');
  lines.push('');
  if (aggregation.perRole.size === 0) {
    lines.push('_No record collected yet._');
  } else {
    lines.push('| Role | Sessions | Turns | Cost |');
    lines.push('|---|---|---|---|');
    for (const [role, agg] of [...aggregation.perRole.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${role} | ${agg.count} | ${agg.turns} | ${usd(agg.usd)} |`);
    }
  }
  lines.push('');

  lines.push('## Multi-branch sessions (excluded from the per-PR table)');
  lines.push('');
  lines.push(
    '_Attribution rule: a session that touched more than one branch counts only once here, never once per branch — avoids double counting on the per-PR total._',
  );
  lines.push('');
  if (aggregation.multiBranch.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| session_id | Branch path | Cost |');
    lines.push('|---|---|---|');
    for (const rc of aggregation.multiBranch) {
      lines.push(`| \`${rc.record.session_id}\` | ${rc.record.branches_seen.join(' → ')} | ${usd(rc.usd)} |`);
    }
  }
  lines.push('');

  lines.push('## Sessions without an associated PR');
  lines.push('');
  if (aggregation.withoutPr.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| session_id | Branch | Cost |');
    lines.push('|---|---|---|');
    for (const rc of aggregation.withoutPr) {
      lines.push(`| \`${rc.record.session_id}\` | ${rc.record.branch_start ?? '—'} | ${usd(rc.usd)} |`);
    }
  }
  lines.push('');

  lines.push('## Cost not computable');
  lines.push('');
  if (missingPriceCounts.size === 0) {
    lines.push('_None: every model seen has a price in `pricing.json`._');
  } else {
    for (const [model, count] of [...missingPriceCounts.entries()].sort()) {
      lines.push(`- missing price for \`${model}\`: ${count} records`);
    }
  }
  lines.push('');

  lines.push('## Metadata');
  lines.push('');
  lines.push(`- Generated: ${nowIso}`);
  lines.push(`- \`pricing.json\` updated as of: ${pricing.as_of} (${pricing.source})`);
  lines.push('');

  return lines.join('\n');
}

function main(): void {
  const nowIso = new Date().toISOString();
  const pricing = loadPricing();
  const records = loadAllRecords();
  const recordCosts: RecordCost[] = records.map((record) => {
    const { usd: cost, missingModels } = costOfRecord(record, pricing);
    return { record, usd: cost, missingModels };
  });

  const missingPriceCounts = new Map<string, number>();
  for (const rc of recordCosts) {
    for (const model of rc.missingModels) {
      missingPriceCounts.set(model, (missingPriceCounts.get(model) ?? 0) + 1);
    }
  }

  const prs = fetchAllPrs();
  const runsByBranch = groupRunsByBranch(fetchAllCiRuns(CI_WORKFLOW_NAME));
  const aggregation = aggregate(recordCosts, prs, runsByBranch, nowIso);
  const health = computeHealth(localKnownSessionIds(), records);

  const markdown = renderReport(aggregation, health, pricing, missingPriceCounts, nowIso);
  writeFileSync(join(moduleDir(), 'REPORT.md'), markdown);
}

main();
