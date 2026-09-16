#!/bin/sh
# Run the reproducible strict type-check and regression suite.
set -eu
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found: the check cannot run, so it must not pass." >&2
  exit 1
fi

npm run check
