# Goal For Micro Claw

## Mission

Build a local-first mini agent that can do real software work on a developer machine without depending on cloud inference.

Micro Claw should be able to:

- inspect a repository,
- understand a task,
- plan a sequence of actions,
- edit code and docs,
- run tests or commands,
- detect failure,
- retry with better context,
- explain what it changed.

## Hard Constraints

- The default deployment target is a machine with 32 GB RAM or unified memory.
- The runtime should work with Ollama and quantized local models.
- The runtime should also support an API-key provider mode that keeps local RAM near the minimum by not loading local model weights.
- The system should stay useful even when only compact or "minified" models are available.
- The agent must be able to operate offline after models are installed.
- Coding capability is a first-class feature, not an optional add-on.
- The architecture must allow one large model at a time instead of assuming multi-model concurrency.

## Product Standard

Micro Claw is not trying to imitate a giant frontier agent by pretending. It should instead be excellent at a narrower local problem:

- medium-depth repository inspection,
- focused coding tasks,
- controlled tool execution,
- deterministic patch generation,
- short feedback loops,
- pragmatic self-correction.

## What "Max Capability On 32 GB" Means

For this project, "max capability" means:

- the strongest coding performance that still feels responsive on 32 GB hardware,
- routing between small, medium, and aggressive local profiles,
- keeping latency low enough that the agent remains interactive,
- using summaries, retrieval, and verification to compensate for smaller models.

It does not mean loading the largest possible model and making the rest of the machine unusable.

## Primary Capabilities

1. Repo awareness
   Scan files, detect project shape, summarize important modules, and keep compact memory artifacts.
2. Task planning
   Turn vague requests into ordered substeps with stop conditions and validation criteria.
3. Coding
   Propose patches, make edits, explain intent, and stay within task boundaries.
4. Verification
   Run tests, linters, type checks, or smoke checks before claiming success.
5. Recovery
   When a patch fails, inspect the failure, revise the plan, and retry.
6. Local operation
   Use local tools and local models by default, with no cloud dependency required for baseline function.
7. Thin remote mode
   When using hosted providers such as Anthropic-style APIs, run as a thin client that minimizes RAM and avoids local inference.

## Non-Goals

- Competing with remote frontier models on giant repository reasoning.
- Keeping full raw chat history forever.
- Running several large models in memory at once on a 32 GB machine.
- Loading a local heavyweight model when remote API mode is selected and no local fallback is required.
- Acting without verification on risky shell or file operations.
- Optimizing first for benchmark screenshots instead of real task completion.

## Success Criteria

Micro Claw is successful when it can reliably do the following on a 32 GB machine:

- open a medium repository and produce a useful structural summary,
- complete small coding tasks end-to-end without manual copy-paste,
- finish common repo operations with acceptable latency,
- recover from at least some failed first attempts,
- maintain better results with tool use than with chat-only behavior,
- switch to smaller profiles when resources are tight instead of failing hard.
- switch into thin remote mode when an API key is available and lowest RAM usage is preferred.

## Acceptance Targets

- Warm-start first token should feel interactive for the active profile.
- Simple documentation or one-file fixes should usually complete in one pass.
- Multi-file changes should include a written plan and a verification step.
- The agent should prefer a tested smaller model profile over an unstable larger one.
- In remote API mode, the agent should keep local memory low by avoiding local model loads, large caches, and in-memory indexes unless they prove necessary.
- Every "done" state should include evidence: command output, test result, or explicit verification gap.

## Design Rule

If there is a tradeoff between raw model size and end-to-end task completion, choose the design that completes more real tasks on 32 GB hardware.
