# Agent Loop

## Objective

Micro Claw should act like a disciplined local operator. The loop should be short, inspectable, and hard to derail.

## Canonical Loop

1. Intake
   Convert the user request into a task summary, constraints, and a definition of done.
2. Scan
   Inspect the repository or workspace and collect only the context needed for the first move.
3. Plan
   Produce a short ordered plan with verification attached to each meaningful step.
4. Act
   Execute one concrete step: read, search, patch, run, or summarize.
5. Verify
   Check whether the action had the expected effect.
6. Reflect
   If the result failed or drifted, compress the lesson into a short failure note.
7. Continue or Stop
   Either take the next step, retry once with better context, or stop with an explicit gap.

## Coding Loop Variant

For coding tasks, the loop becomes:

1. Find the relevant files.
2. Build a mental map of the local code area.
3. Propose the smallest viable change.
4. Apply the patch.
5. Run the most relevant verification command.
6. If failure occurs, inspect the exact error before asking the model to retry.
7. Stop when the change is validated or when the remaining uncertainty is explicit.

## Planning Contract

The planner should output a compact JSON-like structure with fields such as:

```json
{
  "task_summary": "Add or change X",
  "constraints": [
    "Stay local-first",
    "Do not touch unrelated files"
  ],
  "steps": [
    {
      "id": "scan",
      "action": "inspect relevant files",
      "success_signal": "target files and commands identified"
    },
    {
      "id": "patch",
      "action": "apply focused code or doc change",
      "success_signal": "diff matches requested outcome"
    },
    {
      "id": "verify",
      "action": "run project-specific checks",
      "success_signal": "checks pass or failure is clearly classified"
    }
  ],
  "stop_condition": "request is satisfied and verified"
}
```

The exact schema can evolve, but the agent should always reason in explicit steps rather than freeform rambling.

## Tool Use Rules

- Read before writing.
- Search before summarizing.
- Prefer a focused patch over full-file rewrites.
- Verify after every meaningful code change.
- Never call a task done without evidence.

## Context Rules

- Use summaries for large files.
- Trim dead context aggressively.
- Carry forward repo facts, not full conversations.
- Keep the active prompt specific to the current action.

## Retry Policy

Micro Claw should not loop forever.

Default policy:

- first failure: inspect and retry with tighter context,
- second similar failure: change tactic or downgrade the task scope,
- third similar failure: stop and surface the blocker clearly.

## Completion Standard

A task can be marked complete only when:

- the requested edit or output exists,
- the relevant check has been attempted,
- the result is explained clearly,
- any remaining risk is named instead of hidden.

## Why This Loop Fits Small Local Models

Compact local models struggle when they must do everything in one shot. They perform much better when:

- the next action is explicit,
- tool outputs are factual,
- large contexts are summarized,
- verification catches weak first attempts,
- the system can retry with a better prompt instead of a bigger model.
