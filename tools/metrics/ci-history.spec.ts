/**
 * Blocking test: `ci-history.ts` decides how to classify a sequence of CI
 * runs, not just orchestrate it — the same reason `collect.ts` has
 * `collect.spec.ts`. The cases below are hand-built but modeled on
 * behaviors observed live with `gh run list` during this tool's
 * development (branch reused between two PRs, `cancelled` run from a
 * closely-timed push).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRunConclusion,
  filterRunsByWindow,
  greenOnFirstRun,
  nonIgnoredSequence,
  redToGreenTransitions,
} from './ci-history.js';

describe('filterRunsByWindow — a branch reused by two distinct PRs', () => {
  // `gh run list --branch <name>` would mix the runs of both PRs if the
  // branch had been reused (real case observed in production: two
  // distinct PRs opened in sequence on the same auto-generated branch
  // name). The two runs below represent that scenario.
  const runs = [
    { conclusion: 'success', createdAt: '2026-08-11T06:57:23Z' },
    { conclusion: 'success', createdAt: '2026-08-11T15:32:26Z' },
  ];

  it('the first PR\'s window returns only the first run', () => {
    const filtered = filterRunsByWindow(runs, {
      from: '2026-08-11T06:57:19Z',
      to: '2026-08-11T07:24:27Z',
    });
    expect(filtered).toEqual([{ conclusion: 'success', createdAt: '2026-08-11T06:57:23Z' }]);
  });

  it('the second PR\'s window returns only the second run', () => {
    const filtered = filterRunsByWindow(runs, {
      from: '2026-08-11T15:32:22Z',
      to: '2026-08-11T15:41:53Z',
    });
    expect(filtered).toEqual([{ conclusion: 'success', createdAt: '2026-08-11T15:32:26Z' }]);
  });
});

describe('classifyRunConclusion + redToGreenTransitions — a run cancelled by a closely-timed push', () => {
  // Two runs: `cancelled` followed by `success` two minutes later — a push
  // that arrived while the previous run was in progress caused it to be
  // cancelled (typical of `concurrency: cancel-in-progress` on a non-main
  // branch), not a judgment on the code. Treating `cancelled` as red would
  // count a bounce that never happened: here the expected value is 0.
  const runs = [
    { conclusion: 'cancelled', createdAt: '2026-08-22T10:14:17Z' },
    { conclusion: 'success', createdAt: '2026-08-22T10:16:31Z' },
  ];

  it('`cancelled` is ignored, `success` is green, `failure` is red', () => {
    expect(classifyRunConclusion('cancelled')).toBe('ignored');
    expect(classifyRunConclusion('success')).toBe('green');
    expect(classifyRunConclusion('failure')).toBe('red');
  });

  it('nonIgnoredSequence discards the cancelled run, keeping only the success', () => {
    const sequence = nonIgnoredSequence(runs);
    expect(sequence).toEqual([{ conclusion: 'success', createdAt: '2026-08-22T10:16:31Z' }]);
  });

  it('redToGreenTransitions on the filtered sequence is 0, not 1', () => {
    const sequence = nonIgnoredSequence(runs);
    expect(redToGreenTransitions(sequence)).toBe(0);
    expect(greenOnFirstRun(sequence)).toBe(true);
  });
});

describe('greenOnFirstRun — empty sequence', () => {
  it('returns null, not false, when there is no non-ignored run (e.g. no CI existed yet)', () => {
    expect(greenOnFirstRun([])).toBeNull();
  });
});

describe('redToGreenTransitions — multiple bounces in the same sequence', () => {
  it('counts every red→green transition, not just the first', () => {
    const sequence = [
      { conclusion: 'failure', createdAt: '2026-08-01T00:00:00Z' },
      { conclusion: 'success', createdAt: '2026-08-01T01:00:00Z' },
      { conclusion: 'failure', createdAt: '2026-08-01T02:00:00Z' },
      { conclusion: 'failure', createdAt: '2026-08-01T03:00:00Z' },
      { conclusion: 'success', createdAt: '2026-08-01T04:00:00Z' },
    ];
    expect(redToGreenTransitions(sequence)).toBe(2);
  });
});
