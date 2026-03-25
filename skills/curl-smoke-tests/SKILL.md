---
name: curl-smoke-tests
description: "Use when the user needs curl smoke tests."
---

# curl smoke tests

Use this skill when the task needs a repeatable shell workflow.

## Workflow

1. Confirm the target folder, URL, file pattern, and expected output.
2. Use the shell tool with either `cwd` or `cd <dir> && ...` when work must happen in another folder.
3. Use `curl` for HTTP checks and `grep` or `rg` for focused matching.
4. Keep reusable command sequences in `scripts/` so future runs stay deterministic.
5. Report the exact command that ran and the meaningful output or failure.

## Bundled Helpers

- `scripts/run.sh` is a starter wrapper for `cd` plus `curl` or text matching checks.
- `references/commands.md` contains copyable command patterns for `cd`, `curl`, `grep`, and `rg`.

## Notes

- Prefer `rg` over `grep -R` for repo searches when available.
- Use `curl -fsSL` for smoke tests so HTTP failures do not look successful.
