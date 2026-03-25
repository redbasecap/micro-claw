#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "dist/cli.js is missing. Run 'pnpm build' first." >&2
  exit 1
fi

exec secretgate wrap -- node "$ROOT/dist/cli.js" "$@"
