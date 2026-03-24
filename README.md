# Micro Claw

Micro Claw is a docs-first blueprint for a local-first mini agent that can inspect codebases, plan work, edit files, run commands, and iterate on failures while staying practical on a 32 GB RAM machine.

The intended runtime is Ollama with quantized local models. A second runtime mode should support API-key providers such as Anthropic-style hosted models while using the absolute minimum local RAM. The design goal is not "largest model possible at any cost"; it is the highest real coding usefulness per watt, per GB, and per second on consumer hardware.

## Current Direction

- Fully local by default.
- Optimized for 32 GB RAM or unified memory.
- Built around quantized and compact Ollama models.
- Supports a low-RAM remote API mode with no local heavyweight model loaded.
- Capable of coding tasks, not just chat.
- Structured around tool use, verification, and fallback behavior.

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

If the repo follows these docs, Micro Claw should grow into a small but serious local coding agent with:

- a planner that can decompose work,
- a coder that can produce concrete patches,
- a verifier that runs tests and checks,
- memory that stores summaries instead of whole transcripts,
- fallback profiles that keep the system usable on 32 GB hardware,
- an API-key mode that keeps RAM near the floor by offloading inference.
