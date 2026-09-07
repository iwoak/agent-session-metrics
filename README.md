# agent-session-metrics

Collects, for every interactive session of [Claude Code](https://claude.com/claude-code)
and for every sub-agent it launches, how much it cost in turns, tokens and
API calls — never the content of prompts, files, or tool output — and
generates a report on the agent-assisted development process: how much a
cycle costs, how often CI passes on the first try, how many red→green
bounces are needed before merging.

## The problem

Agents produce work quickly, and that speed hides a question almost no one
answers with data: how much does an "ask the agent → review → redo" cycle
really cost? A fast cycle that has to be redone three times can cost more
than a slow one done well once, and without measuring, the two cases can't
be told apart. This tool collects the data needed to do that, from the
process side — not the product the agent is building.

## What it collects, and what it deliberately doesn't

**A design constraint, not an implementation detail**: every record is
derived — counts, names, timestamps — never a raw transcript. See
`NOTES.md` for why.

Every record (`SessionRecord`, schema in `tools/metrics/collect.ts`) carries:

- **identity**: session id, parent session if it's a sub-agent, agent type,
  whether it runs in primary/worktree/remote isolation;
- **time**: start, last update, end, how it ended;
- **git**: branches touched (not commit content);
- **cost**: tokens per model (input/output/cache), never a dollar total
  saved — it's recalculated from `pricing.json`;
- **activity**: number of real user turns, assistant messages, calls per
  tool name (`{"Read": 4, "Bash": 2}`), **names** of files read and written
  (never their content).

**Never collected**: prompt text, the content of a file read or written,
the output of a command, the diff of a change. A local log (`hook.log`)
exists only for the hook's own errors, never for collected data.

## How it works

Three hooks in `.claude/settings.json` (`SessionStart`/`Stop`/`SessionEnd`)
call `.claude/hooks/metrics-collect.sh`, which invokes `tools/metrics/collect.ts`:

- **`Stop`** derives a `SessionRecord` from the session transcript and
  writes it to `.claude/metrics-spool/records/<session_id>.json` (local,
  git-ignored). It pushes to `refs/agent-metrics/sessions/<session_id>`
  only if at least 5 minutes have passed since the last successful push.
- **`SessionEnd`** writes the final state and always pushes.
- **`SessionStart`** does a sweep: pushes local records not yet
  synchronized and recovers "orphan" sessions (that never reached a
  `Stop`). It then also enumerates `subagents/*.meta.json` next to the
  transcript and produces a record for each sub-agent.

Every record is a **root** commit with a single file (`record.json`), on a
dedicated ref outside `refs/heads`: zero contention between concurrent
sessions (`--force` is safe because no one else writes to that ref), and
invisible to GitHub Actions' `push`/`pull_request` triggers, which only
look at `refs/heads` and `refs/tags`.

`pnpm metrics:report` (or the equivalent in your package manager) does a
`git fetch` of all refs, applies `pricing.json`, queries `gh` for PR and CI
status, and writes `tools/metrics/REPORT.md` — generated, never
hand-written, like a lockfile: the historical series is that file's Git
history.

## Installation

1. Copy `tools/metrics/` and `.claude/hooks/metrics-collect.sh` into your
   repository, keeping the same relative paths (`collect.ts` resolves the
   repository root as two levels above itself).
2. Install the dependencies — only this tool's own, no workspace needed:

  ```bash
  cd tools/metrics
  npm install   # or pnpm install / yarn install
   ```

3. Register the three hooks in `.claude/settings.json` (just this
   fragment, not the whole file — if you already have one, add these keys
   under `hooks`):

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics-collect.sh SessionStart",
               "async": true
             }
           ]
         }
       ],
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics-collect.sh Stop",
               "async": true
             }
           ]
         }
       ],
       "SessionEnd": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/metrics-collect.sh SessionEnd",
               "async": true
             }
           ]
         }
       ]
     }
   }
   ```

4. Add `.claude/metrics-spool/` to your `.gitignore`: it's the local
   spool, it must not be committed.
5. Update `tools/metrics/pricing.json` with the prices of the models you
   use — a model with no price ends up in an explicit aggregate in the
   report ("cost not computable"), never silently calculated as zero.
6. Add to your repository's `package.json` (or run directly):

   ```json
   {
     "scripts": {
       "metrics:report": "cd tools/metrics && tsx report.ts"
     }
   }
   ```

## Usage

```bash
# Generate/update tools/metrics/REPORT.md
pnpm metrics:report

# Test suite — blocking before any change to collect.ts or ci-history.ts
cd tools/metrics && npx vitest run
```

`report.ts` queries `gh` (GitHub CLI, already authenticated) for the list
of PRs and CI runs. If your GitHub Actions workflow isn't called `CI`, set
`METRICS_CI_WORKFLOW`:

```bash
METRICS_CI_WORKFLOW="Build and test" pnpm metrics:report
```

## Disabling the collector

Remove the `SessionStart`/`Stop`/`SessionEnd` block from
`.claude/settings.json` — one block, one file. No need to touch
`tools/metrics/` or the hook: with no hooks configured, the script is
never invoked.

## Known limitations

- **Reads the shape of the Claude Code transcript observed at the time
  this tool was written** (late 2026): field names (`gitBranch`,
  `requestId`, `toolUseResult`, the shape of `usage`) are not a stable
  public API. If the format changes, the derivation can silently stop
  producing correct data — there's no schema validation on the input,
  only defensive access that degrades to `null`/`0` instead of throwing.
  `collect.spec.ts` is the only safety net: if a field is renamed, the
  test only notices if it touches one of the branches it covers.
- **Only one pricing model at a time, by exact name**: `pricing.json`
  indexes by the exact model string seen in the transcript
  (`claude-sonnet-5`). An alias or a new model version requires a new row,
  otherwise it ends up in "cost not computable".
- **`gh` must be authenticated and the CI workflow must be named as
  configured** (`METRICS_CI_WORKFLOW`, default `CI`): without it,
  `report.ts` fails on the "per PR" part — there's no silent fallback to
  zero PRs.
- **No historical segmentation.** An earlier version of this tool (in the
  private repository it was extracted from) segmented the repository's
  history into "regimes" — periods in which the meaning of "green on
  first push" changed because CI itself had changed (no CI → CI without
  gating → CI with gating on drafts) — with boundaries discovered by hand
  and frozen into a snapshot. That part **was not extracted**: the
  boundaries were made of PR numbers, branches and real commits from that
  specific repository, not reusable logic. If your repository has gone
  through similar changes in its own CI process, the report here computes
  metrics over the entire history in one pass, without distinguishing
  between them — a reasonable extension is to add your own segmentation
  following the same pattern (a constant with the boundaries, a frozen
  `history-snapshot.json` file for closed periods, live recalculation only
  for the open one), but that's work left to whoever adopts the tool, not
  included here.
- **Local collection health**: the "sessions known locally" line only
  sees this machine. It doesn't detect a session that was never
  synchronized anywhere.
- **Worktree isolation**: `isolation: "worktree"` is recognized from a
  `cwd` that contains `/.claude/worktrees/` — a Claude Code path
  convention, not guaranteed forever.

## Sample report

Fake numbers, but in the real shape of `tools/metrics/REPORT.md`:

```markdown
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

## License

MIT — see `LICENSE`.
