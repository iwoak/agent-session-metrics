/**
 * Minimal wrappers around `gh` (GitHub CLI): PR metadata, CI runs, and a
 * PR's commits. Used by `report.ts` to compute cost/turns per PR and
 * "green on first push" / red→green bounces. One fetch at a time, no
 * concurrency: this tool runs on demand, never on the critical path.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function repoRoot(): string {
  return resolve(moduleDir(), '../..');
}

export interface PrMeta {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  isDraft: boolean;
}

export interface RawCiRun {
  databaseId: number;
  conclusion: string | null;
  createdAt: string;
  headBranch: string;
  headSha: string;
  event: string;
}

export interface CommitLite {
  authoredDate: string;
}

/**
 * Sorted by ascending `number`: `gh pr list` doesn't guarantee a stable
 * order across invocations (typically by recent activity, which can
 * change without the PRs' state changing), and this feeds the report's
 * determinism.
 */
export function fetchAllPrs(): PrMeta[] {
  const out = execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'all',
      '--json',
      'number,createdAt,mergedAt,closedAt,headRefName,isDraft',
      '--limit',
      '1000',
    ],
    { cwd: repoRoot(), maxBuffer: 1024 * 1024 * 64 },
  ).toString();
  return (JSON.parse(out) as PrMeta[]).sort((a, b) => a.number - b.number);
}

/**
 * A single call for the entire history: cheaper than `gh run list
 * --branch <name>` repeated per PR. The filter by the specific PR's time
 * window is applied afterward, in memory (`filterRunsByWindow`).
 */
export function fetchAllCiRuns(workflowName: string): RawCiRun[] {
  const out = execFileSync(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      workflowName,
      '--json',
      'databaseId,conclusion,createdAt,headBranch,headSha,event',
      '--limit',
      '500',
    ],
    { cwd: repoRoot(), maxBuffer: 1024 * 1024 * 64 },
  ).toString();
  return JSON.parse(out) as RawCiRun[];
}

/** Only runs tied to a `pull_request` event: `push`/`workflow_dispatch` don't belong to any PR. */
export function groupRunsByBranch(runs: RawCiRun[]): Map<string, RawCiRun[]> {
  const map = new Map<string, RawCiRun[]>();
  for (const run of runs) {
    if (run.event !== 'pull_request') continue;
    const list = map.get(run.headBranch) ?? [];
    list.push(run);
    map.set(run.headBranch, list);
  }
  return map;
}

/**
 * Needed because a merged PR's branch is often deleted by GitHub after the
 * merge: at that point `origin/<branch>` no longer resolves locally, and
 * "first commit after main" computed from `git log` comes back `null` for
 * almost every historical PR. Commit data instead remains available from
 * the API until GitHub garbage-collects the objects.
 */
export function fetchPrCommits(prNumber: number): CommitLite[] {
  const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'commits', '--jq', '.commits'], {
    cwd: repoRoot(),
  }).toString();
  return JSON.parse(out) as CommitLite[];
}

export function firstCommitDate(commits: CommitLite[]): string | null {
  if (commits.length === 0) return null;
  return commits.reduce(
    (min, commit) => (Date.parse(commit.authoredDate) < Date.parse(min) ? commit.authoredDate : min),
    commits[0].authoredDate,
  );
}
