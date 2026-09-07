#!/bin/bash
#
# Minimal wrapper that forwards the hook's stdin to `tools/metrics/collect.ts`.
# Called by `SessionStart`/`Stop`/`SessionEnd` (.claude/settings.json), with a
# single argument: the event name, which `collect.ts` uses to pick the
# branch.
#
# Deliberately not gated on any variable that distinguishes local from
# remote: the collector must behave identically in both environments, so
# this script never makes that distinction (unlike an environment-setup
# hook that a repository adopting this tool might already have).
#
# Zero impact on the critical path: async: true in settings.json runs this
# script in the background, and the last line still guarantees exit 0 — a
# failure here must never be perceived by the agent. The real logic
# (parsing, spool, push) lives in collect.ts, which has its own internal
# safeguard (try/catch + log, never an unhandled error that exits the
# process).

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
TSX_BIN="$PROJECT_DIR/node_modules/.bin/tsx"

if [ -x "$TSX_BIN" ]; then
  cd "$PROJECT_DIR" && "$TSX_BIN" tools/metrics/collect.ts "$1"
fi

exit 0
