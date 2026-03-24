# Runtime Modes

## Purpose

Micro Claw should support two clear execution modes:

- local inference mode for offline operation,
- remote API mode for the absolute minimum local RAM footprint.

The user should be able to switch modes intentionally. The system should not silently start a local model if API mode is enabled.

## Mode 1: Local Inference

Use this mode when:

- offline capability matters,
- Ollama models are installed,
- 32 GB local hardware is available,
- local privacy is the main priority.

Behavior:

- route tasks to local Ollama model profiles,
- keep only one heavyweight local model loaded at a time,
- use local summaries and local tools,
- accept higher RAM usage in exchange for offline independence.

## Mode 2: Minimum-RAM Remote API

Use this mode when:

- an API key is available,
- the user wants Anthropic-style or other hosted model quality,
- the machine should use as little RAM as possible,
- local inference is unnecessary.

Behavior:

- never auto-start Ollama,
- never preload a local LLM,
- stream provider responses instead of buffering full outputs in memory,
- keep session state compact and disk-backed where practical,
- keep only the orchestrator, tool layer, and active request in RAM.

## Minimum-RAM Rules

When remote API mode is active, Micro Claw should enforce these rules:

1. No local inference by default
   If `provider.mode=remote`, do not load Ollama or any local model unless the user explicitly overrides it.
2. No resident vector database by default
   Start with grep, file summaries, and lightweight disk-backed indexes before adding in-memory retrieval systems.
3. No duplicate transcript buffers
   Keep one compact working summary plus the last required messages, not multiple copies of the full conversation.
4. Stream everything
   Stream model output, command output, and log writes when possible.
5. Persist summaries to disk
   Repo maps, failure notes, and command discoveries should be written as compact artifacts instead of kept indefinitely in RAM.
6. Lazy file loading
   Load file contents only for the active step and release them after summarization.
7. One active provider request at a time
   Avoid concurrent long outputs unless a measurable gain justifies the memory cost.

## Recommended Remote Architecture

In remote API mode, the local process should be thin:

- orchestrator,
- provider adapter,
- tool executor,
- compact summary memory,
- logger.

It should not become a second hidden inference stack.

## Provider Adapter Requirements

The provider layer should support:

- API key from environment or config,
- streaming responses,
- request timeouts,
- retry with backoff,
- hard max token limits,
- explicit provider selection,
- cheap fallback model selection when available.

This keeps the runtime predictable and avoids accidental large-memory behavior in the client process.

## Prompt And Context Policy In API Mode

Even with a remote model, Micro Claw should still optimize for low local RAM:

- build prompts from summaries, not raw transcript dumps,
- include only touched files and relevant failures,
- cap the number of returned tool results,
- compress old plan steps into short notes,
- avoid caching giant response objects.

## Operational Goal

In remote API mode, most RAM should belong to the operating system, editor, shell, and active tools, not to model weights or giant prompt caches.

That is the correct interpretation of "absolute minimum local RAM".
