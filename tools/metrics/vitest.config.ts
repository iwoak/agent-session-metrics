import { defineConfig } from 'vitest/config';

/**
 * `collect.spec.ts` and `ci-history.spec.ts` are blocking: they verify the
 * pure derivation against real (sanitized) fixtures and hand-built cases.
 * No real filesystem/git involved here — the I/O of `collect.ts` and
 * `report.ts` is verified manually, not by this suite.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['*.spec.ts'],
  },
});
