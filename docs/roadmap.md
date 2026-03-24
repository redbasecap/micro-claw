# Roadmap

## Phase 0: Definition

Goal:

- lock the product target,
- document constraints,
- choose model profiles,
- define what "good enough on 32 GB" means.

Exit condition:

- the current document set exists and is agreed on.

## Phase 1: Thin Runner Foundation

Build:

- Ollama connection,
- hosted provider adapter,
- shell command execution,
- file read and patch tools,
- repo scan utilities,
- plain-text session logging.

Exit condition:

- the system can inspect a repo and produce a short task plan.

## Phase 2: Structured Agent Loop

Build:

- planner output schema,
- action schema,
- retry policy,
- stop conditions,
- summary memory artifacts.

Exit condition:

- the system can take a task, plan it, execute a few safe steps, and stop cleanly.

## Phase 3: Coding Capability

Build:

- patch-oriented edit flow,
- code-focused prompts,
- test command discovery,
- verification runner,
- failure classification.

Exit condition:

- Micro Claw can complete simple coding tasks end-to-end on a real repo.

## Phase 4: Model Routing

Build:

- fast profile,
- balanced profile,
- max-32 fallback profile,
- memory-aware routing rules,
- warm model reuse strategy.

Exit condition:

- the agent chooses model profiles based on task type and system pressure.

## Phase 5: Evaluation Harness

Build:

- repeatable task corpus,
- benchmark runner,
- JSON result logging,
- comparison dashboards or summaries,
- release gates for local hardware.

Exit condition:

- claims about quality and speed are backed by task data.

## Phase 6: Developer Experience

Build:

- CLI or TUI,
- config file for model profiles,
- per-project command hints,
- diff previews,
- resumable sessions.

Exit condition:

- the agent is usable as a daily local coding helper.

## Phase 7: Hardening

Build:

- better failure recovery,
- timeout handling,
- safer destructive-command policy,
- memory cleanup,
- observability and audit logs.

Exit condition:

- the system behaves predictably under real developer use.

## Priority Order

The priority is:

1. useful local behavior,
2. reliable coding loop,
3. verification,
4. speed tuning,
5. polish.

That order matters. A polished local agent that cannot actually finish coding tasks is not the target.
