/**
 * Pure logic for reading a sequence of GitHub Actions CI runs and
 * answering two questions per PR: "was it green on the first push?" and
 * "how many red→green bounces did it have?". No `gh`, no `git`, no `fs`
 * in here: only input data, output data — the same separation between
 * pure derivation and I/O that keeps `collect.ts` testable without
 * touching the filesystem or git.
 *
 * No domain logic in here: it only reads the generic shape of a CI run
 * (conclusion, timestamp, branch).
 */

// ---------------------------------------------------------------------------
// Time window — fix for branch name reuse
// ---------------------------------------------------------------------------

export interface TimeWindow {
  /** ISO 8601, inclusive. */
  from: string;
  /** ISO 8601, inclusive. */
  to: string;
}

/**
 * `gh run list --branch <name>` identifies a branch name, not a PR: if the
 * branch was reused by two distinct PRs, both PRs' runs end up in the same
 * list. The fix is to filter by the specific PR's window
 * `[pr.createdAt, pr.mergedAt ?? pr.closedAt ?? now]`, not to trust the
 * branch name alone.
 */
export function filterRunsByWindow<T extends { createdAt: string }>(
  runs: T[],
  window: TimeWindow,
): T[] {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return runs.filter((run) => {
    const createdAt = Date.parse(run.createdAt);
    return createdAt >= from && createdAt <= to;
  });
}

// ---------------------------------------------------------------------------
// CI conclusion classification — green/red/ignored table
// ---------------------------------------------------------------------------

export type RunClassification = 'green' | 'red' | 'ignored';

export interface ClassifiableRun {
  conclusion: string | null;
  createdAt: string;
}

/**
 * `cancelled` is **ignored**, not red: many workflows cancel the previous
 * run on every push to a non-`main` branch (`concurrency:
 * cancel-in-progress`), so a `cancelled` run isn't a judgment on the code,
 * it's the previous run made obsolete by a subsequent push. Treating it as
 * red overestimates red→green bounces.
 *
 * `timed_out`/`action_required`/`startup_failure` are classified as
 * **red** by explicit default: they still represent a negative outcome
 * that required intervention, and treating them as "ignored" for lack of
 * observed cases would make them silently disappear the day they show up.
 *
 * `skipped`/`neutral`/`stale` are ignored: they don't represent a complete
 * judgment on the run.
 *
 * Any other conclusion, including `null` (run still in progress, or never
 * concluded), falls back to the `ignored` default: cautious, because it
 * never enters the sequence used to count transitions or look at the
 * first outcome.
 */
export function classifyRunConclusion(conclusion: string | null): RunClassification {
  switch (conclusion) {
    case 'success':
      return 'green';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
      return 'red';
    case 'cancelled':
    case 'skipped':
    case 'neutral':
    case 'stale':
      return 'ignored';
    default:
      return 'ignored';
  }
}

/**
 * Sorts by ascending `createdAt` and discards `ignored` runs, returning
 * the sequence of only `green`/`red` runs that `greenOnFirstRun` and
 * `redToGreenTransitions` operate on. A PR's "first push" is the first
 * element of this sequence, not the first run overall: a PR whose very
 * first run is `cancelled` by an almost-immediate push is neither green
 * nor red "on first push" — the second run is the one the actual push
 * produced.
 */
export function nonIgnoredSequence<T extends ClassifiableRun>(runs: T[]): T[] {
  return [...runs]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .filter((run) => classifyRunConclusion(run.conclusion) !== 'ignored');
}

/**
 * Green if the first element of the non-ignored sequence is `green`,
 * `null` if the sequence is empty — no usable run: neither green nor red,
 * not computable (for example, a PR opened before any CI existed).
 */
export function greenOnFirstRun(sequence: ClassifiableRun[]): boolean | null {
  if (sequence.length === 0) return null;
  return classifyRunConclusion(sequence[0].conclusion) === 'green';
}

/** Number of red→green transitions in the already-filtered (non-ignored) sequence. */
export function redToGreenTransitions(sequence: ClassifiableRun[]): number {
  let transitions = 0;
  let sawRed = false;
  for (const run of sequence) {
    const isGreen = classifyRunConclusion(run.conclusion) === 'green';
    if (!isGreen) {
      sawRed = true;
    } else if (sawRed) {
      transitions += 1;
      sawRed = false;
    }
  }
  return transitions;
}
