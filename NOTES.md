# NOTES.md — design decisions

The non-obvious reasons behind this tool's choices. Not a changelog: it's
updated when a decision changes, not when a line changes.

## Why every record is derived, never a raw transcript

The collector could have simply copied each session's JSONL transcript
somewhere accessible. It would have been simpler to write and richer in
data. It was deliberately discarded: a transcript contains every prompt,
every file read in full, every command run, every tool output — that is,
exactly the work content a session produces, often proprietary, sometimes
with secrets that end up by mistake in a command or a file that was read.

A derived record (`SessionRecord` in `collect.ts`) carries only what's
needed to answer "how much did this cycle cost, and with what outcome":
counts, names (of tools, files, models, branches), timestamps. It's not a
compromise on the richness of collected data made out of implementation
laziness: it's the difference between a tool anyone can turn on for their
own working repository without having to trust where their prompts end
up, and one that no one actually turns on because the risk outweighs the
benefit. The derivation happens **before** any data leaves the machine —
`deriveSessionRecord` is pure, runs on the local transcript, and only the
result is written and pushed.

## Why raw tokens travel together with the cost, not just the dollar total

`SessionRecord` doesn't save "$4.10": it saves `tokens_by_model`, i.e. the
four raw numbers (input/output/cache write/cache read) for each model
seen. The dollar cost is computed downstream, in `report.ts`, by reading
`pricing.json`.

The reason is that model prices change — sometimes they drop, sometimes a
model is retired and replaced — and a record that had frozen the cost at
collection time would have stayed true only for the day it was written.
With raw tokens saved, updating `pricing.json` and re-running `pnpm
metrics:report` recalculates *the entire* history with today's prices,
without having to touch or regenerate a single record. Price is the only
thing that ages; tokens don't.

An explicit consequence, not a detail: a model that appears in records but
has no row in `pricing.json` doesn't produce a silent zero cost — it ends
up in "cost not computable" in the report, along with a count of how many
records it affects. A wrong cost due to missing data is worse than an
absent, declared cost.

## Why local writes are decoupled from pushing

Every hook always writes the current state to the local spool
(`.claude/metrics-spool/records/<id>.json`), but only pushes under certain
conditions (`isPushDue` in `collect.ts`): `Stop` only past a 5-minute
threshold since that session's last successful push, `SessionEnd` always,
`SessionStart`'s sweep only for records changed since their last push.

Deriving an updated state from a growing transcript is almost free:
re-reading JSONL lines and summing counters costs milliseconds even for a
long session. Pushing isn't: it's a network write, with a Git commit to
build and a `git push` to complete, and doing it on every single turn
would multiply traffic to the remote by the number of turns of each active
session, most of which repeat a state nearly identical to the previous
one. Deriving often and pushing on a threshold keeps the first cost cheap
without making the second one disappear into a log nobody watches:
`SessionEnd` still guarantees that the final state always arrives, even if
no threshold ever triggered during the session.

## Why this version doesn't segment history into regimes

An earlier version of this tool computed three metrics derived from `gh`
(green on first push, red→green bounces, cycle time) and segmented them
over periods in which their meaning changed, because the repository's CI
process had changed underneath them — for example: before any CI existed,
"green on first push" isn't computable, not "false"; after a PR opened as
a draft started running only a subset of checks, "the first full run"
stopped coinciding with "the first push".

The idea — that a metric's meaning can change when the process that
measures it changes, and that this should be made explicit instead of
pretending the historical series was always comparable — remains valid in
general. But its implementation in that repository wasn't reusable logic:
it was a constant with real dates, PR numbers and branch names from that
specific repository, verified by hand one by one. Bringing it here would
have meant either inventing a fake segmentation (which would have proven
nothing) or leaving in data that belongs to another repository's history.
Neither was acceptable, so that part was not extracted: `report.ts`, in
this repository, computes the three metrics over the entire available
history, without segmenting it. Anyone adopting this tool who goes through
a similar change in their own CI process can add their own segmentation
following the same pattern — it's described as a possible extension in
`README.md`, not included here.

## Why a dedicated Git ref per session, outside `refs/heads`

Every record lives as a standalone root commit on
`refs/agent-metrics/sessions/<session_id>`, not in a branch or a
repeatedly updated file. Two properties follow from this together, not one
at a time: zero contention between concurrent sessions writing at the same
time (each session only touches its own ref, so `--force` is safe — there
is no other writer to collide with), and invisibility to GitHub Actions'
`push`/`pull_request` triggers, which by construction only look at
`refs/heads/*` and `refs/tags/*`. The second property is what avoids
having to maintain a hand-synchronized `paths-ignore` in every CI workflow
of the repository that adopts the tool: the ref is simply outside their
field of view.

This isn't an assumption taken on faith: before building the rest of the
mechanism around this idea, it was verified with a real push that GitHub
accepts and retains an arbitrary ref outside those two namespaces. "Git
accepts arbitrary refs" is true in theory; if GitHub Pages, code search, or
an Action trigger had behaved differently in practice, the entire design
would have had to be revisited.
