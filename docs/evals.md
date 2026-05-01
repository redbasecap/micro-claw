# Evaluation Plan

## Purpose

Micro Claw should be judged by task completion on local hardware, not by vague claims that it is "agentic".

The evaluation suite should answer:

- Can it finish real tasks?
- Can it do so on 32 GB hardware?
- Is the speed still acceptable?
- Does tool use improve results?
- Which model profile is the best default?

## Hardware Baseline

Every meaningful benchmark run should record:

- machine type,
- RAM or unified memory,
- CPU and GPU details if relevant,
- Ollama version,
- active model tag,
- runtime mode: local or remote,
- context size,
- warm or cold start,
- task runtime.

Without that, results are not comparable.

## Core Benchmark Categories

### 1. Repo Understanding

Tasks:

- identify framework and package manager,
- locate entry points,
- summarize important modules,
- discover test and build commands.

Pass criteria:

- summary is materially correct,
- commands discovered are executable,
- hallucinated files are zero or near zero.

### 2. Small Coding Tasks

Tasks:

- rename a symbol,
- add a config flag,
- adjust a prompt or template,
- fix a simple bug in one file.

Pass criteria:

- diff is correct,
- change is scoped,
- relevant verification passes.

### 3. Medium Coding Tasks

Tasks:

- modify multiple files coherently,
- update docs with code,
- add a small feature,
- fix a failing test and related logic.

Pass criteria:

- plan exists,
- patch compiles or passes tests,
- explanation matches the actual diff.

### 4. Repair Loop Quality

Tasks:

- intentionally provide a task that usually fails on first try,
- measure whether the agent can inspect the failure and recover.

Pass criteria:

- retry is grounded in the error,
- second attempt is materially better than the first,
- the agent does not loop blindly.

### 5. Speed And Interactivity

Measure:

- cold start time,
- warm start time,
- first-token latency,
- full task latency,
- user-visible idle time between steps.

Pass criteria:

- the system remains usable as an interactive developer tool,
- larger models are only used when quality gain justifies the delay.

### 6. Memory Use

Measure:

- peak resident memory of the Micro Claw process,
- peak resident memory of child processes,
- whether Ollama or another local runtime was started,
- memory delta between idle and active task execution.

Pass criteria:

- in remote API mode, no local model runtime is started unless explicitly requested,
- remote mode uses materially less RAM than local inference mode,
- memory growth stays bounded over repeated tasks.

### 7. Always-On Assistant Behavior

Tasks:

- generate briefings from todos, reminders, schedules, and memory,
- recall durable curated memories,
- expose removable memory ids,
- report due inbox work without sending duplicate notifications.

Pass criteria:

- `/brief`, `/today`, `/review`, and `/inbox` return structured, useful summaries,
- curated memories are visible and removable by id prefix,
- command behavior is shared between Telegram and TUI,
- assistant eval artifacts are written under `.micro-claw/evals/assistant/`.

HyperAgents-style self-improvement should consume these assistant eval artifacts from a disposable worktree or external lab repo. Do not point a reset/clean-based evolution loop at the main Micro Claw working tree.

## Quality Signals To Record

- task success or failure,
- number of retries,
- number of tool calls,
- verification status,
- wall-clock duration,
- peak memory usage,
- model used,
- context size,
- user correction needed after completion.

## Comparison Matrix

Every release should compare at least:

- fast profile only,
- balanced profile only,
- balanced plus max fallback,
- local mode versus remote minimum-RAM mode,
- chat-only mode versus tool-using mode.
- assistant command behavior across small local assistant profiles.

This will show whether the architecture is actually improving outcomes.

## Minimum Release Gate

Do not call Micro Claw "coding-capable" unless it can:

- complete a meaningful set of small coding tasks locally,
- pass a medium-task subset with verification,
- recover from some failures,
- stay operational on the 32 GB target.

## Evaluation Philosophy

Smaller local models can look weak in raw benchmarks and still win in practice if the system:

- retrieves good context,
- uses structure,
- verifies aggressively,
- routes intelligently,
- avoids oversized prompts.

Micro Claw should optimize for that system-level win.
