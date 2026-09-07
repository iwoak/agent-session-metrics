# agent-session-metrics

Session-level cost and cycle metrics for [Claude Code](https://claude.com/claude-code). It records how much each session cost — turns, tokens, tool calls — and how often the work had to be redone before it merged. It reads no prompt text, no file content, and no command output.

## The problem

Agents produce work quickly, and that speed makes one question easy to skip: how much does an *ask → review → redo* cycle actually cost? A fast cycle repeated three times can cost more than a slow one done once.

This measures the process, not the product the agent is building.

I built it to measure my own. What it told me is written up here: **[Shift Left testing meets AI agents](https://medium.com/@iwo.diana/shift-left-testing-meets-ai-agents-a3161e68a7a5)**. Short version: the cheap check I ran on every push had never once caught a defect in 45 pull requests, while every real failure came from the expensive checks I had made rare.

## What the report looks like

Fake numbers, real shape. `tools/metrics/REPORT.md` is generated, never hand-written — the historical series is that file's Git history.

```
# Agent metrics report

## Collection health

- Sessions known locally (this machine): 3
- Records found on `origin` (`refs/agent-metrics/sessions/*`): 47
- Missing on remote: none

## Per merged PR

| PR | Branch | Sessions | Turns | Cost | Green on first push | Red→green | Cycle time |
|---|---|---|---|---|---|---|---|
| #12 | `feat/export-csv` | 2 | 3 | $4.10 | yes | 0 | 1.2h |
| #14 | `fix/pagination-off-by-one` | 1 | 1 | $0.62 | no | 1 | 6.8h |
| #15 | `chore/upgrade-deps` | 1 | 2 | $2.95 | yes | 0 | 0.4h |

## Per role (agent_type)

| Role | Sessions | Turns | Cost |
|---|---|---|---|
| implementer | 9 | 14 | $22.30 |
| reviewer | 7 | 7 | $8.15 |
| unknown | 5 | 61 | $71.40 |

## Cost not computable

- None: every model seen has a price in `pricing.json`.
```

## What it collects, and what it never does

Every record is derived — counts, names, timestamps. Never a raw transcript. `NOTES.md` explains why.

Each `SessionRecord` (schema in `tools/metrics/collect.ts`) carries:

- **identity**: session id, parent session if it's a sub-agent, agent type, whether it runs in primary, worktree, or remote isolation;
- **time**: start, last update, end, how it ended;
- **git**: branches touched, not commit content;
- **cost**: tokens per model (input, output, cache). No dollar total is stored: it is recalculated from `pricing.json`, so old records stay valid when prices change;
- **activity**: real user turns, assistant messages, calls per tool name (`{"Read": 4, "Bash": 2}`), and the **names** of files read and written.

**Never collected**: prompt text, the content of any file, the output of any command, the diff of any change. A local `hook.log` exists for the hook's own errors and holds no collected data.

## How it works

Three hooks in `.claude/settings.json` call `.claude/hooks/metrics-collect.sh`, which invokes `tools/metrics/collect.ts`:

- **`Stop`** derives a `SessionRecord` from the session transcript and writes it to `.claude/metrics-spool/records/<session_id>.json`, local and git-ignored. It pushes only if five minutes have passed since the last successful push.
- **`SessionEnd`** writes the final state and always pushes.
- **`SessionStart`** sweeps: it pushes records not yet synchronised, recovers orphan sessions that never reached a `Stop`, then enumerates `subagents/*.meta.json` next to the transcript and produces a record for each sub-agent.

Each record is a root commit holding a single `record.json`, on a dedicated ref outside `refs/heads`. Two consequences: concurrent sessions never contend, so `--force` is safe because nothing else writes that ref; and the pushes are invisible to GitHub Actions, whose `push` and `pull_request` triggers only watch `refs/heads` and `refs/tags`.

`pnpm metrics:report` fetches every ref, applies `pricing.json`, queries `gh` for PR and CI status, and writes `tools/metrics/REPORT.md`.

## Installation

There is no installer yet. This is six manual steps, and it assumes you are comfortable editing your own hook configuration.

**1.** Copy `tools/metrics/` and `.claude/hooks/metrics-collect.sh` into your repository, keeping the same relative paths. `collect.ts` resolves the repository root as two levels above itself.

**2.** Install the dependencies. No workspace needed:

```bash
cd tools/metrics
npm install   # or pnpm install / yarn install
```

**3.** Register the three hooks in `.claude/settings.json`. Add these keys under `hooks` if the file already exists:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics-collect.sh SessionStart", "async": true } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics-collect.sh Stop", "async": true } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics-collect.sh SessionEnd", "async": true } ] }
    ]
  }
}
```

**4.** Add `.claude/metrics-spool/` to your `.gitignore`. It is the local spool and must not be committed.

**5.** Put the prices of the models you use in `tools/metrics/pricing.json`. A model with no price lands in an explicit "cost not computable" line in the report, never silently counted as zero.

**6.** Add the script to your `package.json`:

```json
{
  "scripts": {
    "metrics:report": "cd tools/metrics && tsx report.ts"
  }
}
```

## Usage

```bash
# Generate or update tools/metrics/REPORT.md
pnpm metrics:report

# Test suite — blocking before any change to collect.ts or ci-history.ts
cd tools/metrics && npx vitest run
```

`report.ts` queries `gh` (authenticated GitHub CLI) for pull requests and CI runs. If your workflow is not called `CI`:

```bash
METRICS_CI_WORKFLOW="Build and test" pnpm metrics:report
```

## Disabling it

Remove the `SessionStart`, `Stop`, and `SessionEnd` block from `.claude/settings.json`. One block, one file. With no hooks configured the script is never invoked, so `tools/metrics/` and the hook can stay where they are.

## Known limitations

**It reads the shape of the Claude Code transcript as observed when this was written** (late 2026). Field names — `gitBranch`, `requestId`, `toolUseResult`, the shape of `usage` — are not a stable public API. If the format changes, derivation can stop producing correct data without failing: there is no schema validation on input, only defensive access that degrades to `null` or `0` rather than throwing. `collect.spec.ts` is the only safety net, and it catches a renamed field only if that field sits on a branch the tests cover.

**Pricing matches on the exact model string** seen in the transcript, for example `claude-sonnet-5`. An alias or a new version needs its own row, or its cost lands in "not computable".

**`gh` must be authenticated** and the CI workflow must match `METRICS_CI_WORKFLOW` (default `CI`). Without it, `report.ts` fails on the per-PR section rather than silently reporting zero pull requests.

**No historical segmentation.** An earlier version of this tool, in the private repository it was extracted from, split the repository's history into regimes — periods in which "green on first push" meant something different because CI itself had changed: no CI, then CI, then CI with heavy jobs gated on draft state. Boundaries were found by hand and frozen into a snapshot. That part was not extracted, because the boundaries were made of pull request numbers, branch names and commits from that specific repository, not reusable logic. Here the report computes over the whole history in one pass. If your CI has changed in similar ways, the same pattern is worth rebuilding: a constant holding the boundaries, a frozen `history-snapshot.json` for closed periods, live recalculation only for the open one. That work is not included.

**Collection health is local.** The "sessions known locally" line only sees the machine running the report. It cannot detect a session that was never synchronised from anywhere else.

**Worktree isolation is inferred** from a `cwd` containing `/.claude/worktrees/`, a Claude Code path convention rather than a guarantee.

## License

MIT — see `LICENSE`.