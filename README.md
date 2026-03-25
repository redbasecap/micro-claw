# Micro Claw

Micro Claw is a local-first mini agent starter that can inspect codebases, plan work, run safe tools, persist compact session artifacts, and verify discovered project commands while staying practical on a 32 GB RAM machine.

The intended runtime is Ollama with quantized local models. A second runtime mode should support API-key providers such as Anthropic-style hosted models while using the absolute minimum local RAM. The design goal is not "largest model possible at any cost"; it is the highest real coding usefulness per watt, per GB, and per second on consumer hardware.

## Current Direction

- Fully local by default.
- Optimized for 32 GB RAM or unified memory.
- Built around quantized and compact Ollama models.
- Supports a low-RAM remote API mode with no local heavyweight model loaded.
- Structured for coding tasks, not just chat.
- Structured around tool use, verification, and fallback behavior.
- Protected by a Secretgate proxy boundary by default.

## Current Build

The repo now includes a runnable TypeScript starter that covers the early architecture phases from the docs:

- repo scan and command discovery,
- deterministic planning contracts,
- local or remote runtime configuration loading,
- Secretgate boundary detection and enforcement,
- disk-backed session artifacts under `.micro-claw/sessions/`,
- a readable always-on agent workspace under `.micro-claw/agent/`,
- shell, file, search, patch, and git tool execution,
- first-class skill scaffolding under `skills/<name>/SKILL.md`,
- verification of discovered build or test commands,
- a CLI entrypoint for `chat`, `scan`, `plan`, `run`, `doctor`, and `heartbeat`.

## One-Command Ollama Setup

If you want local models with one command, run:

```bash
pnpm ollama:setup
```

That command:

- checks that `ollama` is installed,
- starts `ollama serve` if needed,
- pulls the base planner and coder models,
- creates the repo-local profiles `micro-claw-planner` and `micro-claw-coder` from the Modelfiles in `examples/`.

If you also want the large fallback model, use:

```bash
pnpm ollama:setup -- --include-fallback
```

The fallback pull is optional because it is much larger.

If you want to preview the plan without downloading anything:

```bash
pnpm ollama:setup -- --dry-run
```

## Secretgate First

Micro Claw now expects to run behind [Secretgate](https://github.com/secretgate/secretgate). Secretgate documents `secretgate wrap` as the normal launch path for AI tools and documents the proxy and certificate env vars used when you set the boundary up manually.

Build Micro Claw, then launch it through the wrapper:

```bash
pnpm build
./scripts/micro-claw-safe.sh doctor
./scripts/micro-claw-safe.sh chat
./scripts/micro-claw-safe.sh scan --json
./scripts/micro-claw-safe.sh run "inspect this repo and propose the next coding step"
```

If you want to invoke it directly, the supported pattern is:

```bash
secretgate wrap -- node dist/cli.js run "build the project"
```

`doctor` reports whether the Secretgate boundary is active. The normal runtime commands now fail fast if the proxy and certificate env vars are missing or point at the wrong host or port.

## Getting Started

```bash
pnpm install
pnpm bootstrap
pnpm ollama:setup
pnpm build
pnpm test
./scripts/micro-claw-safe.sh agent-profile
./scripts/micro-claw-safe.sh scan --json
./scripts/micro-claw-safe.sh chat
./scripts/micro-claw-safe.sh plan "add a coding loop"
./scripts/micro-claw-safe.sh run "inspect this repo and propose the next step"
```

On first terminal use, Micro Claw now asks two onboarding questions and saves the answers in `.micro-claw/agent/profile.json`:

- what it should be called
- how it should behave

You can also set that directly:

```bash
./scripts/micro-claw-safe.sh agent-profile --name "Clawy" --behavior "brief, helpful, and proactive"
```

If you want to develop without rebuilding each time:

```bash
secretgate wrap -- pnpm dev scan --json
```

Micro Claw now auto-loads `.env.micro-claw` and `.env` from the repo root when they exist.

## Bootstrap And One-Click Start

Create the local env file, config file, and default agent profile:

```bash
pnpm bootstrap
```

If you want the quickest direct-start config for a local demo:

```bash
micro-claw bootstrap --allow-direct
```

That creates:

- `.env.micro-claw`
- `micro-claw.config.yaml`
- `.micro-claw/agent/profile.json`
- `.micro-claw/agent/profile.md`

Fill in at least `TELEGRAM_BOT_TOKEN` in `.env.micro-claw`.

The quickest launcher for the Telegram assistant is now:

```bash
pnpm one-click
```

You can also call the script directly:

```bash
./scripts/micro-claw-one-click.sh
```

The launcher installs dependencies when needed, builds the repo, bootstraps config if missing, and starts the Telegram service through Secretgate when it is available.

## Heartbeat Mode

For around-the-clock operation, Micro Claw now has a heartbeat service that writes:

- `heartbeat.md`
- `.micro-claw/heartbeat.json`

One-shot mode works well for cron:

```bash
./scripts/micro-claw-safe.sh heartbeat --once --verify
```

Long-running mode is better when you want a single resident process instead of repeated cold starts:

```bash
./scripts/micro-claw-safe.sh heartbeat --interval-seconds 300 --verify
```

That loop keeps refreshing the heartbeat files until it receives `SIGINT` or `SIGTERM`. For a real 24/7 setup, run the long-lived heartbeat command under `launchd`, `systemd`, or another service manager. Cron is still a reasonable fallback when a platform service manager is not available.

An example hardened config is in [examples/config.secretgate.yaml](./examples/config.secretgate.yaml).

## Always-On Agent Mode

Micro Claw now has a clearer small-agent workspace that is closer to the "inbox plus status files" feel:

```text
.micro-claw/agent/status.md
.micro-claw/agent/status.json
.micro-claw/agent/tasks/queued/*.md
.micro-claw/agent/tasks/working/*.md
.micro-claw/agent/tasks/done/*.md
.micro-claw/agent/tasks/failed/*.md
```

Each task is a Markdown file with frontmatter, the original prompt, and the latest result summary. That makes the queue inspectable without opening JSON or digging through logs.

Queue a task:

```bash
./scripts/micro-claw-safe.sh agent-submit "create a skill for curl smoke tests"
```

Check status:

```bash
./scripts/micro-claw-safe.sh agent-status
```

Drain the queue once:

```bash
./scripts/micro-claw-safe.sh agent-run-once --verify
```

Run the small agent continuously:

```bash
./scripts/micro-claw-safe.sh agent-start --interval-seconds 300 --verify
```

`agent-start` refreshes the heartbeat, drains queued tasks, and keeps writing the current overview back to `.micro-claw/agent/status.md`. This is the best current path when you want "a little agent that is always there" instead of only one-shot `chat` or `run` calls.
If no profile exists yet and you start it from a real terminal, it will ask for its name and behavior before the first cycle.

## Telegram Assistant

Micro Claw can now run as a small Telegram-based daily assistant with persistent notes, todos, reminders, and normal chat replies.

Start the service:

```bash
micro-claw telegram-start
```

Run a single sync cycle:

```bash
micro-claw telegram-start --once
```

The Telegram service writes:

- `.micro-claw/assistant/state.json`
- `.micro-claw/assistant/state.md`
- `.micro-claw/assistant/status.json`
- `.micro-claw/assistant/status.md`
- `.micro-claw/telegram/state.json`

Supported Telegram commands:

- `/help`
- `/status`
- `/whoami`
- `/note <text>`
- `/notes`
- `/todo <text>`
- `/todos`
- `/done <id-prefix>`
- `/remind in 2h buy milk`
- `/remind today 18:30 call mom`
- `/remind 2026-03-25 09:00 standup`
- `/reminders`

Every other text message is answered through the configured model path, while repo- and execution-focused requests can still flow into the existing Micro Claw repo assistant behavior.

## Chat Mode

Micro Claw now has an interactive REPL:

```bash
./scripts/micro-claw-safe.sh chat
```

If no profile exists yet, chat asks how it should be called and how it should behave before the first conversation starts.

You can also do a one-shot provider-backed prompt:

```bash
./scripts/micro-claw-safe.sh chat "summarize this repo"
```

Actionable prompts automatically switch into tool mode. That means prompts such as "create a folder", "write a file", "run the tests", or "curl this endpoint" will use the built-in tool loop instead of only describing what should happen.
While that loop is running, chat now prints live `progress>` updates so you can see each tool step instead of waiting silently for the final answer.

That also applies to skills. For example:

```bash
./scripts/micro-claw-safe.sh chat "create a skill for curl smoke tests"
```

Micro Claw can now scaffold skills in a simple structure:

```text
skills/<slug>/SKILL.md
```

Skills can also bundle deterministic helpers under `scripts/` and focused docs under `references/`. For shell-oriented skills, Micro Claw can now scaffold helpers that use `cd`, `curl`, `grep`, and `rg`.

If you want the scaffold directly without chat:

```bash
./scripts/micro-claw-safe.sh skill-create "curl smoke tests" --description "Use when the user needs a repeatable curl smoke test workflow."
```

If you want the scaffold to include shell helpers:

```bash
./scripts/micro-claw-safe.sh skill-create "curl smoke tests" --shell-helpers
```

That produces files like:

```text
skills/curl-smoke-tests/SKILL.md
skills/curl-smoke-tests/references/commands.md
skills/curl-smoke-tests/scripts/run.sh
```

The chat and tool loop also now treat `cd`, `curl`, `grep`, and `rg` as normal actionable shell work. Folder-specific shell actions can use the structured `cwd` field or `cd some/path && ...`.

Inside chat, slash commands are available:

- `/profile`
- `/help`
- `/scan`
- `/status`
- `/plan <task>`
- `/run <task>`
- `/search <query>`
- `/read <path>`
- `/exit`
```

## Document Map

- [goal.md](./goal.md): product intent, hard constraints, and success criteria.
- [docs/architecture.md](./docs/architecture.md): system shape and component boundaries.
- [docs/agent-loop.md](./docs/agent-loop.md): the operating loop for planning, acting, and verifying.
- [docs/model-strategy.md](./docs/model-strategy.md): model profiles for 32 GB hardware and routing rules.
- [docs/runtime-modes.md](./docs/runtime-modes.md): local mode versus minimum-RAM API mode.
- [docs/evals.md](./docs/evals.md): how to prove the agent is actually useful.
- [docs/roadmap.md](./docs/roadmap.md): staged build plan.
- [examples/planner.Modelfile](./examples/planner.Modelfile): example planner profile for Ollama.
- [examples/coder.Modelfile](./examples/coder.Modelfile): example coder profile for Ollama.
- [examples/config.min-ram.yaml](./examples/config.min-ram.yaml): example hosted-provider configuration tuned for minimum local RAM.

## Guiding Principles

- One heavyweight model at a time.
- In API mode, zero local heavyweight models at a time.
- Keep context curated instead of blindly large.
- Prefer tool execution plus verification over "thinking longer".
- Treat coding as a loop: inspect, plan, patch, test, reflect.
- Measure speed and task completion on real repositories, not only benchmarks.

## Near-Term Outcome

From this starter, Micro Claw can grow into a small but serious local coding agent with:

- a planner that can decompose work,
- a coder that can produce concrete patches,
- a verifier that runs tests and checks,
- memory that stores summaries instead of whole transcripts,
- fallback profiles that keep the system usable on 32 GB hardware,
- an API-key mode that keeps RAM near the floor by offloading inference.
