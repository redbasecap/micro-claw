# OpenClaw Study Notes

## Snapshot

- Repository studied: `https://github.com/openclaw/openclaw`
- Observation date: 2026-03-24
- Observed default branch: `main`
- Observed root package version: `2026.3.24`
- License: MIT

Important correction: this repository is not the old Captain Claw game engine project. The current `openclaw/openclaw` repo is a large personal AI assistant platform with a local gateway, CLI, plugin SDK, multi-channel messaging integrations, web control UI, and native apps.

## What OpenClaw Actually Is

OpenClaw is best understood as a local control plane plus a large extension ecosystem.

Core product shape:

- a CLI entrypoint (`openclaw ...`)
- a long-running gateway server
- a WebSocket control plane plus HTTP surfaces
- a plugin/runtime system
- channel adapters for many messaging systems
- a control UI served from the gateway
- device and native app integrations for macOS, iOS, and Android

The repo is much broader than what `micro-claw` needs. The right lesson is not to clone the whole product. The right lesson is to copy the boundaries that make the system extensible.

## Top-Level Monorepo Shape

High-value directories:

| Path | Role | Relevance to `micro-claw` |
| --- | --- | --- |
| `src/` | Main runtime, CLI, gateway, plugins, channels, agent plumbing | Very high |
| `ui/` | Vite + Lit control UI | Low for first rebuild |
| `extensions/` | Plugin and provider packages, plus channel integrations | Medium, mainly for architecture patterns |
| `packages/` | Supporting packages and compatibility surfaces | Low to medium |
| `apps/` | Native apps for macOS, iOS, Android | Low for first rebuild |
| `docs/` | Product and subsystem docs | Medium |
| `skills/` | Bundled skills | Low for first rebuild |
| `test/` and `*.test.ts` | Unit, contract, integration, live, e2e tests | High for learning quality strategy |

Broad source areas inside `src/`:

- `src/cli/`
- `src/gateway/`
- `src/plugins/`
- `src/plugin-sdk/`
- `src/channels/`
- `src/agents/`
- `src/config/`
- `src/sessions/`
- `src/security/`
- `src/memory/`

## Tooling And Build Stack

### Languages

Primary language:

- TypeScript

Also present:

- Swift
- Kotlin
- shell
- some JavaScript
- some Go and Python utilities

### Runtime And Package Management

From the README:

- Node 24 recommended
- Node 22.16+ supported
- `pnpm` is the preferred source-build workflow

### Workspace Layout

`pnpm-workspace.yaml` shows a workspace rooted at:

- `.`
- `ui`
- `packages/*`
- `extensions/*`

### Build System

The root build is centered on `tsdown` via `tsdown.config.ts`.

Key points:

- the build emits the core CLI/runtime entries
- plugin SDK subpaths are emitted as stable distributable entries
- bundled plugins and bundled hooks are included in the same build graph
- some heavy or lazy runtime modules are preserved as stable output entrypoints

This is an important design choice. OpenClaw is not just bundling one app. It is producing a host runtime plus stable import surfaces for plugins and compatibility layers.

### UI

The control UI in `ui/` uses:

- Vite
- Lit
- Vitest

### Tests

Testing is Vitest-heavy, with many separate lanes:

- full test runner via `node scripts/test-parallel.mjs`
- channel-focused lane
- extension-focused lane
- contract-focused lane
- live and e2e suites

Contributor baseline from `CONTRIBUTING.md`:

```bash
pnpm build && pnpm check && pnpm test
```

Useful source-build commands from the README:

```bash
pnpm install
pnpm ui:build
pnpm build
pnpm openclaw onboard --install-daemon
pnpm gateway:watch
```

## Startup And Boot Flow

The real startup path matters because it shows how OpenClaw separates bootstrapping from runtime logic.

### CLI Entry Chain

1. `openclaw.mjs`
2. `src/entry.ts`
3. `src/cli/run-main.ts`
4. `src/cli/program/build-program.ts`
5. lazily registered CLI commands
6. gateway command path into `src/cli/gateway-cli/run.ts`
7. `startGatewayServer(...)` in `src/gateway/server.impl.ts`

### What `openclaw.mjs` Does

The outer wrapper checks the runtime, tries to resolve the built entrypoint, and handles lightweight help/version cases before deeper startup.

Lesson: keep packaging concerns and built-entry discovery outside the main TypeScript runtime when possible.

### What `src/entry.ts` Does

`src/entry.ts` is the outer wrapper. It handles:

- environment normalization
- process title setup
- compile cache enablement
- warning filtering
- Windows argv normalization
- profile argument parsing
- container-target handling
- root help/version fast paths
- optional CLI respawn before the main CLI runs

Lesson: OpenClaw keeps early process concerns in a dedicated entry wrapper instead of polluting the actual command runtime.

### What `src/cli/run-main.ts` Does

`runCli()` is the real CLI dispatcher. It handles:

- container routing
- dotenv loading
- runtime version guard
- structured console capture
- lazy loading of the CLI program
- lazy registration of the primary command
- conditional plugin CLI registration

Lesson: command registration is intentionally lazy. That keeps startup smaller and avoids loading the entire system for simple invocations.

### What `src/index.ts` Does

`src/index.ts` is dual-purpose:

- if run as main, it behaves as a legacy CLI entry
- if imported as a library, it exposes selected library bindings

Lesson: OpenClaw preserves legacy entry compatibility while moving package exports to a narrower library surface. That is useful if `micro-claw` ever wants both CLI and embeddable API modes.

## Gateway Architecture

The gateway is the system core.

At a high level:

- CLI starts the gateway
- gateway loads config and startup auth state
- gateway loads plugins and channel integrations
- gateway starts HTTP and WebSocket surfaces
- gateway exposes methods, events, and UI surfaces
- channels and plugins feed work back into the gateway request system

The most reusable structural idea is:

- one long-running process
- one main port
- one request dispatcher
- multiple transports and integrations converging on the same core handlers

### `src/gateway/server.impl.ts`

This is the main assembly file.

Based on the imports and the inspected sections, it is responsible for coordinating:

- config loading and migration
- startup auth bootstrap
- secrets activation
- control UI asset resolution
- plugin runtime creation
- plugin loading
- channel manager creation
- node registry
- session tracking
- cron services
- health state
- hooks
- model catalog loading
- Tailscale exposure
- maintenance timers
- startup logging
- update checks
- skill refresh listeners

Lesson: the gateway assembly layer is large, but it is still composition-root code. The actual behavior is pushed into many focused modules. `micro-claw` should copy this shape even if the number of modules is much smaller.

### HTTP Surface: `src/gateway/server-http.ts`

The HTTP layer handles more than a health check. It includes:

- health and readiness probes
- control UI serving
- OpenAI-compatible or response-like HTTP routes
- plugin HTTP routes
- webhook or hook ingress
- tool invocation HTTP endpoints
- session history and session kill routes
- canvas-related routes
- per-surface auth handling

Lesson: HTTP is an adjunct surface around the same control plane, not a separate app.

### WebSocket Surface: `src/gateway/server-ws-runtime.ts`

The WS runtime is intentionally thin. It delegates to a connection handler and supplies:

- clients
- auth/rate-limit configuration
- gateway method registry
- event broadcast function
- request context builder

Lesson: keep the transport layer thin. Put business logic in shared request handlers so HTTP, WS, and internal dispatch can converge.

### Request Dispatch: `src/gateway/server-methods.ts`

The deeper scan confirmed that request dispatch is centralized in `src/gateway/server-methods.ts`.

That is where OpenClaw appears to converge:

- authz and scope checks
- gateway method dispatch
- core handlers
- plugin-provided handlers

Lesson: for `micro-claw`, a single internal request contract is more important than whether the first transport is CLI, HTTP, or WS.

### Gateway CLI To Server

`src/cli/gateway-cli/run.ts` eventually calls:

```ts
startGatewayServer(port, {
  bind,
  auth: authOverride,
  tailscale: tailscaleOverride,
})
```

That command path also enforces auth requirements before allowing non-loopback binds.

Lesson: bind policy and auth policy are coupled at startup, not left to convention.

## Plugin Runtime And SDK

OpenClaw has a strong separation between:

- the host implementation
- the plugin runtime facade
- the public plugin SDK types and exports

### `src/plugins/runtime/index.ts`

`createPluginRuntime()` returns a runtime object with facades such as:

- `config`
- `agent`
- `subagent`
- `system`
- `media`
- `imageGeneration`
- `webSearch`
- `tools`
- `channel`
- `events`
- `logging`
- `state`

Some expensive parts are lazy:

- `tts`
- `mediaUnderstanding`
- `stt`
- `modelAuth`

Important architectural detail:

- gateway subagent runtime can be process-global and late-bound
- unavailable runtime methods fail explicitly when used outside the right context

Lessons:

- the runtime object is a clean host-to-plugin contract
- heavy capabilities are lazy-loaded
- context-specific features fail closed when no request scope exists

### `src/plugins/loader.ts`

The deeper scan identified dynamic plugin loading in `src/plugins/loader.ts`, using in-process module loading rather than a separate plugin host process.

Lesson: for `micro-claw`, start with a static registry and only add dynamic loading after the runtime contract has stabilized.

### `src/plugin-sdk/index.ts`

The top-level SDK surface is intentionally small. It mainly exports:

- types
- a few helpers
- selected registration functions

Lesson: keep the root SDK narrow. Put detailed helpers on subpaths. This reduces import sprawl and boundary leaks.

### `src/extensionAPI.ts`

This is a legacy compatibility bridge. It warns that `openclaw/extension-api` is deprecated and forwards a limited set of host helpers.

Lesson: if `micro-claw` changes plugin boundaries later, keep a thin compatibility layer instead of letting old plugins import internals forever.

## Plugin Registry And Channel Model

OpenClaw’s plugin model is not just “load tools.” The registry tracks many extension types.

### `src/plugins/registry.ts`

The registry structure includes:

- tools
- hooks
- typed hooks
- channels
- channel setup helpers
- providers
- speech providers
- media-understanding providers
- image-generation providers
- web-search providers
- gateway handlers
- HTTP routes
- CLI registrars
- services
- commands
- conversation-binding handlers
- diagnostics

Lesson: the plugin registry is the internal source of truth for extension wiring.

### `src/channels/plugins/registry.ts`

Channel plugins are resolved from the active plugin registry and cached by registry version.

That means:

- channels are treated as plugins
- channel lookup is derived data, not a separate registry to maintain by hand
- plugin reload or registry changes can invalidate cached channel lists

Lesson: if `micro-claw` supports even one or two channels later, model them as plugins or adapters inside one registry, not as a separate special-case subsystem.

### `src/channels/plugins/types.ts`

The channel type surface is extensive and broken into many adapter interfaces. Even without reading every adapter file, the export surface shows the design:

- channel lifecycle
- outbound sending
- grouping/threading
- security
- pairing
- setup
- directory resolution
- command handling
- message actions
- capabilities reporting

Lesson: channel complexity is real. For a small rebuild, do not copy the whole surface. Keep the idea of an adapter boundary, but start with a much smaller interface.

### `src/gateway/server-channels.ts`

The gateway-side channel manager handles:

- account startup and shutdown
- runtime snapshots
- restart policies with backoff
- manual stop state
- health monitor toggles
- per-channel and per-account runtime state

Lesson: channel lifecycle management is its own subsystem. It should not be mixed directly into generic gateway request handling.

## Internal Dispatch Pattern Worth Copying

`src/gateway/server-plugins.ts` contains an important pattern:

- plugins can dispatch work back into gateway methods
- WebSocket request scope is used when available
- non-WS paths can fall back to a stored gateway context
- synthetic internal clients can be created with explicit scopes

This is a strong pattern for `micro-claw`.

Why it matters:

- one core request handler can serve UI, CLI, internal plugins, and future automation
- auth and scopes can stay explicit
- plugins do not need direct access to all host internals

## What To Defer

Do not copy these into the first serious `micro-claw` implementation:

1. dynamic plugin discovery and loading
2. many channels or multi-account channel support
3. pairing and allowlist security workflows
4. hot reload and restart supervision complexity
5. Tailscale, remote exposure, and mobile node features
6. native apps, canvas, browser control, and voice features
7. OpenAI-compatible HTTP surfaces before the core request path is stable

## Quality Strategy Worth Copying

OpenClaw’s test and validation strategy is one of the most reusable lessons in the repo.

Patterns worth copying:

- a single contributor baseline: `build + check + test`
- specialized lanes for expensive or integration-heavy surfaces
- explicit contract tests for shared interfaces
- many colocated unit tests near the code
- separate live and e2e suites for unstable external integrations

`micro-claw` should do the same on a smaller scale:

- unit tests for planner, tool contracts, and patch logic
- integration tests for repo scan and shell execution
- a small number of end-to-end tasks against fixture repos

## What To Rebuild For `micro-claw`

Do copy these ideas:

1. A thin boot wrapper before the main CLI runtime.
2. Lazy command registration.
3. One gateway or orchestrator composition root.
4. A narrow runtime contract for plugins or tools.
5. Internal request dispatch that can be reused by CLI, HTTP, and plugins.
6. Lazy loading of heavy capabilities.
7. Test lanes split by surface area.

Do not copy these early:

1. Dozens of channels.
2. Native apps.
3. Web control UI.
4. Tailscale and remote exposure.
5. Voice, canvas, browser control, or mobile node support.
6. The full plugin SDK export surface.
7. Compatibility layers for legacy plugins before the first plugin system even exists.

## Minimal OpenClaw-Inspired Build Plan For `micro-claw`

Recommended first subset:

### Phase 1

- local CLI
- repo scanner
- planner/coder/verifier loop
- shell and patch tools
- structured memory summaries

### Phase 2

- local long-running orchestrator process
- explicit request handler interface
- one internal plugin registry
- one or two tool plugins

### Phase 3

- optional HTTP or WS control plane
- optional UI
- optional external integrations

That order preserves the best OpenClaw lesson: define strong seams first, then scale features behind those seams.

## Concrete Source Files To Re-Read

Best files for a second pass:

- `README.md`
- `CONTRIBUTING.md`
- `package.json`
- `pnpm-workspace.yaml`
- `tsdown.config.ts`
- `vitest.config.ts`
- `ui/package.json`
- `src/entry.ts`
- `src/index.ts`
- `src/cli/run-main.ts`
- `openclaw.mjs`
- `src/cli/program/build-program.ts`
- `src/cli/program/command-registry.ts`
- `src/cli/gateway-cli/run.ts`
- `src/gateway/server.impl.ts`
- `src/gateway/server.ts`
- `src/gateway/server-http.ts`
- `src/gateway/server-ws-runtime.ts`
- `src/gateway/server/ws-connection.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server-channels.ts`
- `src/gateway/server-plugins.ts`
- `src/plugins/loader.ts`
- `src/plugins/runtime/index.ts`
- `src/plugins/registry.ts`
- `src/plugin-sdk/index.ts`
- `src/extensionAPI.ts`
- `src/channels/plugins/index.ts`
- `src/channels/plugins/registry.ts`
- `src/channels/plugins/types.ts`

Useful docs for a second pass:

- `docs/gateway/index.md`
- `docs/gateway/network-model.md`
- `docs/concepts/architecture.md`
- `docs/plugins/architecture.md`
- `docs/plugins/sdk-overview.md`
- `docs/plugins/sdk-runtime.md`
- `docs/plugins/sdk-channel-plugins.md`

## Bottom Line

OpenClaw is useful to study not because `micro-claw` should imitate its product scope, but because it demonstrates a scalable shape:

- boot wrapper
- lazy CLI
- composition-root gateway
- runtime contract for extensions
- channel adapters behind a registry
- shared request dispatch
- strong verification culture

If `micro-claw` copies those boundaries while staying radically smaller, it will learn the right lessons from OpenClaw without inheriting the monorepo’s weight.
