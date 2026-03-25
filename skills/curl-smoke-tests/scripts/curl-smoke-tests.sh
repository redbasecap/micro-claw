#!/usr/bin/env bash
set -euo pipefail

# Wrapper around scripts/run.sh so the skill has a named entrypoint.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run.sh" "$@"
