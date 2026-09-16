#!/bin/sh
# Catch unresolved identifiers. bun build only transpiles, so it happily emits a call
# to a function that does not exist; tsc without deps still reports TS2304/TS2552.
cd "$(dirname "$0")/work" || exit 1
out=$(tsc --noEmit --skipLibCheck --target es2022 --module esnext --moduleResolution bundler \
  extensions/subagents/index.ts extensions/subagents/agents.ts 2>&1)
bad=$(printf '%s\n' "$out" | grep -E "TS2304|TS2552|TS2551" )
if [ -n "$bad" ]; then printf 'TÊN KHÔNG PHÂN GIẢI ĐƯỢC:\n%s\n' "$bad"; exit 1; fi
echo "NAMES OK"
