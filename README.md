# pi-extensions

A collection of [pi](https://github.com/earendil-works/pi) extensions.

| Extension | Description |
| --- | --- |
| [llama-swap provider](#llama-swap-provider) | Registers [llama-swap](https://github.com/mostlygeek/llama-swap) as an OpenAI-compatible LLM provider with model auto-discovery |
| [handoff](#handoff) | Transfers context to a new focused session instead of a lossy compaction (full or compacted mode) |
| [session-name](#session-name) | Auto-generates a session name from the conversation (fresh excerpt or full cached session), or set it manually |

## Installation

Install the full collection via `pi install`:

```bash
pi install git:github.com/tdamir/pi-extensions
```

To try it without installing, use the `--extension` flag:

```bash
pi --extension git:github.com/tdamir/pi-extensions
```

## llama-swap provider

Registers [llama-swap](https://github.com/mostlygeek/llama-swap) as an OpenAI-compatible LLM provider.

It dynamically discovers available models from your local llama-swap instance at startup and makes them available to the pi coding agent.

### Features

- **Auto-discovery** — Fetches the full model list from llama-swap's `/models` API on load
- **OpenAI-compatible** — Uses the `openai-completions` API format, so it works with any OpenAI-style client
- **Smart inference** — Detects reasoning models (e.g. `*-think`, `*.think`) and vision capabilities from model metadata (`capabilities.vision` or `architecture.input_modalities`)
- **Pinned reasoning effort** — Models with a `:{level}` suffix (e.g. `qwen3-coder:medium`) are pinned to that thinking level; all other levels are hidden for them
- **Token & performance stats** — Taps the raw SSE stream to capture llama.cpp's `usage` and `timings` fields (dropped by the built-in parser) and shows them under each assistant message
- **Configurable URL** — Set your llama-swap server address via settings or the `/llama-swap-url` command
- **Hot-reload** — Changes apply automatically on `/reload`

### Prerequisites

- [pi](https://github.com/earendil-works/pi) installed
- [llama-swap](https://github.com/mostlygeek/llama-swap) running on your network

### Configuration

#### Setting the llama-swap URL (required)

The provider **requires** a configured base URL. If `llamaSwap.baseUrl` is not set, the provider is not registered (you'll see a notice in the console at startup).

To set it:

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

#### Project-scoped configuration

Use `-l` with `pi install` to write to `.pi/settings.json` (project scope) instead:

```bash
pi install -l git:github.com/tdamir/pi-extensions
```

This is useful for sharing configuration with your team.

### Token & performance stats

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

### llama-swap model configuration

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

#### Reasoning-effort model variants

If llama-swap exposes fixed-effort model variants with a `:{level}` suffix (`off`, `low`, `medium`, or `xhigh`, e.g. `qwen3-coder:medium`), the provider pins each variant to its matching thinking level and hides the others, so you can switch effort by switching models.

### Usage

After installation and a `/reload`, models from your llama-swap instance will be available as the `llama-swap` provider in pi. Select it like any other provider when chatting with the agent.

## handoff

Transfers context from the current session to a new, focused session. Instead of compacting (which is lossy), handoff extracts what matters for your next task and creates a new session with a generated prompt.

### Modes

- **Compact (default):** `/handoff <goal>` sends the latest compaction summary plus the entries kept after compaction (if the session was compacted), with a dedicated summarizer system prompt. A much smaller context than the full session — cheaper to process.
- **Full:** `/handoff full <goal>` (or `--full`) sends the entire session verbatim with the active system prompt and tools replicated, so it leverages provider-side prompt caching; subsequent calls benefit from cache hits on the shared conversation prefix. 

### Usage

```
/handoff [full] <goal for new thread>
```

Examples:

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff full check other places that need this fix
```

The generated prompt appears as a draft in the editor so you can review or edit it before starting the new session. The new session tracks the current session as its parent.

Requires interactive (TUI) mode.

## session-name

Auto-generates a session name from the conversation context using the current model. The generated name is placed in the input as `/name <suggestion>` — press Enter to confirm or edit first.

### Strategies

- **Fresh (default):** `/session-name` sends only a short excerpt of the first user messages — a cheap, clean request with no cached prefix.
- **Full:** `/session-name full` sends the entire session with the active system prompt and tools, so it leverages provider-side prompt caching; subsequent calls benefit from cache hits on the shared conversation prefix.

### Usage

```
/session-name                # generate a name (fresh excerpt, default)
/session-name full             # generate a name from the full session (cached prefix)
/session-name "My Name"        # set the name manually
/session-name show             # show the current session name
```

Requires interactive (TUI) mode.

## Development

```bash
# Install dependencies
npm install

# Run a single extension locally without installing
pi -e ./extensions/llama-swap.ts
pi -e ./extensions/handoff.ts
pi -e ./extensions/session-name.ts
```

## License

MIT
