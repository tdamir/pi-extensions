# pi-llama-swap-provider

A [pi](https://github.com/earendil-works/pi) package that registers [llama-swap](https://github.com/mostlygeek/llama-swap) as an OpenAI-compatible LLM provider.

It dynamically discovers available models from your local llama-swap instance at startup and makes them available to the pi coding agent.

## Features

- **Auto-discovery** — Fetches the full model list from llama-swap's `/models` API on load
- **OpenAI-compatible** — Uses the `openai-completions` API format, so it works with any OpenAI-style client
- **Smart inference** — Detects reasoning models (e.g. `*-think`, `*.think`) and vision capabilities from model metadata (`capabilities.vision` or `architecture.input_modalities`)
- **Pinned reasoning effort** — Models with a `:{level}` suffix (e.g. `qwen3-coder:medium`) are pinned to that thinking level; all other levels are hidden for them
- **Token & performance stats** — Taps the raw SSE stream to capture llama.cpp's `usage` and `timings` fields (dropped by the built-in parser) and shows them under each assistant message
- **Configurable URL** — Set your llama-swap server address via settings or the `/llama-swap-url` command
- **Hot-reload** — Changes apply automatically on `/reload`

## Prerequisites

- [pi](https://github.com/earendil-works/pi) installed
- [llama-swap](https://github.com/mostlygeek/llama-swap) running on your network

## Installation

Install via `pi install`:

```bash
pi install git:github.com/tdamir/pi-llama-swap-provider
```

To try it without installing, use the `--extension` flag:

```bash
pi --extension git:github.com/tdamir/pi-llama-swap-provider
```

## Configuration

### Setting the llama-swap URL

By default, the provider connects to `http://localhost:9292/v1`. To change it:

1. Run the interactive command:
   ```
   /llama-swap-url
   ```
   Then enter your llama-swap base URL (without `/v1`).

2. Or edit `~/.pi/agent/settings.json` directly:
   ```json
   {
     "llamaSwap": {
       "baseUrl": "http://your-server:8080"
     }
   }
   ```

The provider will automatically append `/v1` to the base URL.

### Project-scoped configuration

Use `-l` with `pi install` to write to `.pi/settings.json` (project scope) instead:

```bash
pi install -l git:github.com/tdamir/pi-llama-swap-provider
```

This is useful for sharing configuration with your team.

## Token & performance stats

For every llama-swap turn, the provider captures llama.cpp's raw `usage` and `timings` SSE fields and stores them as `llama-swap-usage` entries in the session record, placed directly below the corresponding assistant message.

In the TUI, each entry renders as a dimmed one-liner, e.g.:

```
⚡ llama-swap prompt 420 tok/s · gen 28.4 tok/s · draft 12/20 · 512→384 tok (256 cached)
```

- **prompt tok/s** — prompt processing speed
- **gen tok/s** — generation speed
- **draft n/m** — speculative-decoding draft acceptance (when applicable)
- **tokens** — prompt→completion tokens, with cached prompt tokens in parentheses

Press the expand key on the entry to see the full raw `usage`/`timings` JSON. Captured records also persist in the session file, so the stats survive across sessions.

## llama-swap model configuration

This provider relies on llama-swap's `capabilities` section in `config.yaml` to report model metadata such as context length, input modalities, and tool support. Make sure your llama-swap config defines `capabilities` for each model so that information like context window size is properly handled:

```yaml
models:
  "your-model":
    capabilities:
      in:
        - text
        - image
      out:
        - text
      context: 128000
```

See the [llama-swap config example](https://github.com/mostlygeek/llama-swap/blob/main/config.example.yaml) for the full list of available capabilities.

### Reasoning-effort model variants

If llama-swap exposes fixed-effort model variants with a `:{level}` suffix (`off`, `low`, `medium`, or `xhigh`, e.g. `qwen3-coder:medium`), the provider pins each variant to its matching thinking level and hides the others, so you can switch effort by switching models.

## Usage

After installation and a `/reload`, models from your llama-swap instance will be available as the `llama-swap` provider in pi. Select it like any other provider when chatting with the agent.

## Development

```bash
# Install dependencies
npm install

# Run locally without installing
pi -e ./extensions/llama-swap-provider
```

## License

MIT
