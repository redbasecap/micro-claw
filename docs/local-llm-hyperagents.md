# Local LLM And HyperAgents Workflow

## Ollama Mini Model

Use this when you want the simplest local path.

```bash
pnpm local:ollama -- --model qwen3:4b --prompt "/brief"
```

What it does:

- builds Micro Claw if `dist/cli.js` is missing,
- starts `ollama serve` if the API is not reachable,
- pulls the requested model unless `--no-pull` is passed,
- writes `.micro-claw/runtime/local-ollama.yaml`,
- runs the assistant with that config.

Useful variants:

```bash
pnpm local:ollama -- --model qwen3:4b
pnpm local:ollama -- --model llama3.2:3b --prompt "/today"
pnpm local:ollama -- --model qwen3:4b --command assistant-eval
pnpm local:ollama -- --model qwen3:4b --no-pull --prompt "what should I remember?"
```

The generated config has all assistant model roles pointed at the same mini model. If you want to hand tune it, start from `examples/config.local-ollama.yaml`.

## GGUF With llama.cpp

Use this when you have a local `.gguf` file and want to serve it through `llama-server`.

```bash
pnpm local:llamacpp -- --gguf ~/models/your-mini-model.Q4_K_M.gguf --prompt "/brief"
```

What it does:

- starts `llama-server` on `127.0.0.1:8080`,
- sends `llama-server` logs to `.micro-claw/logs/llama-server-8080.log`,
- writes `.micro-claw/runtime/local-llamacpp.yaml`,
- runs Micro Claw through the OpenAI-compatible endpoint,
- sets `LLAMACPP_API_KEY=local` for the Micro Claw child process.

Useful variants:

```bash
pnpm local:llamacpp -- --gguf ~/models/model.Q4_K_M.gguf
pnpm local:llamacpp -- --gguf ~/models/model.Q4_K_M.gguf --ctx 8192 --ngl 99 --prompt "/today"
pnpm local:llamacpp -- --gguf ~/models/model.Q4_K_M.gguf --command assistant-eval
pnpm local:llamacpp -- --gguf ~/models/model.Q4_K_M.gguf --port 8081 --model local-gguf
pnpm local:llamacpp -- --gguf ~/models/model.Q4_K_M.gguf --verbose-server
```

If you already started `llama-server` yourself:

```bash
export LLAMACPP_API_KEY=local
pnpm local:llamacpp -- --no-server --gguf ~/models/model.Q4_K_M.gguf --prompt "/brief"
```

For manual config, start from `examples/config.llamacpp-gguf.yaml`.

## HyperAgents-Locally As A Lab

HyperAgents-Locally supports Ollama, llama.cpp, OpenRouter, MLX, Python/Rust evolution loops, and agent communication loops. Use it as an external lab that consumes Micro Claw eval artifacts; do not run reset/clean-based evolution loops inside the Micro Claw working tree.

First generate an assistant eval:

```bash
pnpm local:ollama -- --model qwen3:4b --command assistant-eval
```

Then package the latest eval for HyperAgents-Locally:

```bash
pnpm hyperagents:package -- --clone --model ollama/qwen3:4b
```

The package command clones `https://github.com/quantumnic/HyperAgents-Locally` into `../HyperAgents-Locally` if needed, writes a safe package under `.micro-claw/hyperagents/`, and prints the exact HyperAgents command to run.

For llama.cpp-backed HyperAgents:

```bash
pnpm hyperagents:package -- --repo ../HyperAgents-Locally --model llamacpp/local-gguf
```
