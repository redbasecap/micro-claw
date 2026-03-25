#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-.}"
TARGET_URL="${2:-}"
MATCH_TEXT="${3:-}"

cd "$TARGET_DIR"

if [[ -z "$TARGET_URL" ]]; then
  echo "working directory: $(pwd)"
  exit 0
fi

if [[ -n "$MATCH_TEXT" ]]; then
  curl -fsSL "$TARGET_URL" | grep -i -- "$MATCH_TEXT"
  exit 0
fi

curl -fsSL "$TARGET_URL"
