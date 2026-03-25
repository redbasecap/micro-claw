# Shell Command Patterns

Run inside another folder:

```bash
cd path/to/workdir && pwd
```

Use the structured shell tool with `cwd` when available:

```json
{"tool":"shell","input":{"cwd":"path/to/workdir","command":"pwd"}}
```

Fetch a page and search for expected text:

```bash
curl -fsSL https://example.com | grep -i "expected text"
```

Search the repo quickly:

```bash
rg -n "TODO|FIXME" .
```
