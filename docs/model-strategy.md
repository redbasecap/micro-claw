# Model Strategy For 32 GB Local Operation

## Goal

Use Ollama-hosted local models or hosted API providers to get the strongest practical coding agent behavior on a 32 GB machine while keeping the system responsive.

The key idea is model profiles, not model dogma. Micro Claw should be able to swap between fast, balanced, aggressive, and minimum-RAM remote profiles depending on the task and memory headroom.

## Design Rules

- Keep only one heavyweight model loaded at a time.
- In remote API mode, keep zero local heavyweight models loaded.
- Use quantized models by default.
- Prefer smaller context windows in practice, even when the model supports more.
- Use retrieval and summaries to reduce prompt bloat.
- Fall back gracefully instead of crashing when memory is tight.

## Recommended Profiles

### 1. Fast Control Profile

Use for:

- classification,
- short planning,
- summaries,
- low-risk chat,
- low-memory fallback.

Example models:

- `phi4-mini:3.8b`
- `qwen3:4b`

Why:

- very small footprint,
- good reasoning-per-GB,
- suitable as an always-available control plane.

### 2. Balanced Coding Profile

Use for:

- most day-to-day coding tasks,
- patch generation,
- code explanation,
- focused bug fixing,
- short to medium repo work.

Example models:

- `qwen2.5-coder:14b`
- `deepseek-coder-v2:16b`

Why:

- this size class fits comfortably on a 32 GB machine,
- it leaves headroom for the OS, editor, terminal, test processes, and embeddings,
- it is strong enough to outperform tiny models on real code edits.

### 3. Max-32 Profile

Use for:

- difficult coding tasks,
- repo-level reasoning bursts,
- harder repair loops,
- tasks where latency can be traded for quality.

Example models:

- `qwen3-coder:30b`
- `qwen2.5-coder:32b`
- `qwen3:30b`

Why:

- these are still plausible on a 32 GB target if used one at a time,
- they push local quality much further than 7B to 14B models,
- they should be treated as burst modes, not permanent background residents.

### 4. Minimum-RAM Remote Profile

Use for:

- the lowest possible local RAM usage,
- API-key access to hosted coding models,
- quality-sensitive tasks where local inference is unnecessary,
- laptops or desktops already under memory pressure.

Examples:

- Anthropic-hosted coding model via API key,
- another hosted model behind a provider adapter,
- a gateway service that exposes a remote model without local weights.

Why:

- no local model weights need to be resident,
- RAM goes to tools and the active workspace instead of inference,
- the local process can stay thin and responsive.

## Practical Fit On 32 GB

Based on current Ollama model sizes, this is the useful planning range:

| Model | Ollama size | Good role |
| --- | ---: | --- |
| `phi4-mini:3.8b` | 2.5 GB | always-on fallback, short planning |
| `qwen3:4b` | 2.5 GB | fast planner, routing, summaries |
| `qwen2.5-coder:7b` | 4.7 GB | lightweight coder |
| `qwen2.5-coder:14b` | 9.0 GB | balanced primary coder |
| `deepseek-coder-v2:16b` | 8.9 GB | balanced long-context coder |
| `qwen3:30b` | 19 GB | aggressive reasoning burst |
| `qwen3-coder:30b` | 19 GB | aggressive coding burst |
| `qwen2.5-coder:32b` | 20 GB | max local coding mode |

These sizes suggest a clear rule: a 32 GB machine should usually run one main model plus tools, not several medium or large models simultaneously.

If a hosted API is acceptable, the stronger rule is even simpler: run no local model at all.

## Default Recommendation

If only one profile is implemented first, start here:

- planner or router: `qwen3:4b`
- main coder: `qwen2.5-coder:14b`
- fallback when quality matters most: `qwen3-coder:30b`

This is the best initial balance between speed, memory safety, and coding usefulness.

If the user wants the lowest RAM usage above all else, override this default and use remote API mode with no local model.

## When To Use Which Profile

### Stay Small

Choose the fast profile when:

- the step is mostly orchestration,
- the agent is only summarizing or classifying,
- the repo slice is small,
- a heavier model would not materially improve the step.

### Use Balanced

Choose the balanced profile when:

- the task changes code,
- there is a real diff to produce,
- tests or type checks will follow,
- speed still matters.

### Escalate To Max-32

Escalate only when:

- a balanced model already failed,
- the task spans multiple files or subtle logic,
- long-range repo reasoning matters,
- the machine has enough free memory right now.

### Switch To Remote Minimum-RAM Mode

Choose remote API mode when:

- an API key is present,
- the user prefers near-minimum RAM use,
- local model startup is wasteful for the task,
- hosted quality is preferred over offline independence.

## Context Strategy

Do not give the model the entire repo just because a model advertises a huge context window.

Instead:

- feed a repo summary,
- provide only the touched files,
- include grep or search results,
- include the exact failing error,
- add the plan and current step,
- keep the active coding context narrow.

This matters more for local performance than chasing the absolute largest context number.

It also matters in remote mode because smaller local memory use depends on smaller local buffers, not only on remote inference.

## Suggested Ollama Parameters

For coding profiles, start conservative:

- `temperature`: `0.1` to `0.3`
- `top_p`: `0.85` to `0.95`
- `num_ctx`: `16384` or `32768` unless a larger context is clearly needed
- repeat penalties: mild, not aggressive

The goal is stable edits, not creative prose.

For remote mode, apply the same principle:

- stream responses,
- cap max output tokens,
- keep only a compact working set in memory,
- avoid response caching unless it is disk-backed.

## Routing Policy

Use the smallest profile that can plausibly succeed.

Escalate by evidence:

- failure after a correct tool result,
- weak patch quality,
- inability to maintain multi-file consistency,
- repeated misunderstanding of repo structure.

Downgrade by evidence:

- memory pressure,
- high latency with little quality gain,
- trivial tasks,
- repeated success on the current step type with a smaller model.

Remote mode is not only a quality choice. It is also the strictest RAM-saving mode and should be selected immediately when memory minimization is the top priority.

## Important Operational Rule

Micro Claw should separate logical roles from loaded models.

Planner, coder, and verifier are roles. On a 32 GB system they may map to:

- one small always-ready planner,
- one swap-in coder,
- one hosted provider with different system prompts,
- or even one single shared model with different system prompts.

That flexibility is what makes the design realistic.
