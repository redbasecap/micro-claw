#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required for the one-click launcher." >&2
  exit 1
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  pnpm install
fi

pnpm build

if [[ ! -f "$ROOT/micro-claw.config.yaml" && ! -f "$ROOT/micro-claw.config.yml" && ! -f "$ROOT/micro-claw.config.json" ]]; then
  node "$ROOT/dist/cli.js" bootstrap --allow-direct
fi

if command -v secretgate >/dev/null 2>&1; then
  exec secretgate wrap -- node "$ROOT/dist/cli.js" telegram-start "$@"
fi

exec node "$ROOT/dist/cli.js" telegram-start "$@"
