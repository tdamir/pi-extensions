# pi-extensions

A collection of [pi](https://github.com/earendil-works/pi) extensions.

| Extension | Description |
| --- | --- |
| [llama-swap provider](#llama-swap-provider) | Registers [llama-swap](https://github.com/mostlygeek/llama-swap) as an OpenAI-compatible LLM provider with model auto-discovery |
| [handoff](#handoff) | Transfers context to a new focused session instead of a lossy compaction (full or compacted mode) |
| [session-name](#session-name) | Auto-generates a session name from the conversation (fresh excerpt or full cached session), or set it manually |
| [benchmark](#benchmark) | Runs a build requirement against the current model in a per-model working directory to compare LLMs |
| [context-size](#context-size) | `context_size` tool (and `/context-size` command) that reports the current session context usage |

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
- **Token & performance stats** — Taps the raw SSE stream to capture the telemetry the built-in parser drops — llama.cpp's `usage`/`timings` and vLLM's `usage`/`metrics` — and shows it under each assistant message
- **HTML export with stats** — `/export-with-stats` exports the session to HTML with the usage stats included (the built-in `/export` skips them)
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

For every llama-swap turn, the provider captures the raw `usage` and timing SSE fields — llama.cpp's `timings` or vLLM's `metrics` — and stores them as `llama-swap-usage` entries in the session record, placed directly below the corresponding assistant message.

Both server formats are normalized to the same summary:

- **llama.cpp** — `timings` (`prompt_ms`/`prompt_n`, `predicted_ms`/`predicted_n`, `draft_n`/`draft_n_accepted`)
- **vLLM / OpenAI-style** — `metrics` (`time_to_first_token_ms`, `generation_time_ms`, `tokens_per_second`, and `speculative_decoding` counts) plus `usage.prompt_tokens_details.cached_tokens`

In the TUI, each entry renders as a dimmed one-liner, e.g.:

```
⚡ llama-swap prompt 420 tok/s · gen 28.4 tok/s · draft 12/20 · 512→384 tok (256 cached)
```

- **prompt tok/s** — prompt processing speed
- **gen tok/s** — generation speed
- **draft n/m** — speculative-decoding draft acceptance (when applicable)
- **tokens** — prompt→completion tokens, with cached prompt tokens in parentheses

Press the expand key on the entry to see the full raw `usage`/`timings`/`metrics` JSON. Captured records also persist in the session file, so the stats survive across sessions.

Run `/swap-stats` to toggle a panel above the editor with aggregate stats across every captured turn in the current session (request count, total and cached tokens, prompt/generation throughput, draft acceptance, and the five most recent requests). The panel is computed from the session log, so it works across reloads and resumed sessions.

### Exporting the session to HTML

The built-in `/export` command skips `llama-swap-usage` entries, so the stats are missing from the exported HTML. Use `/export-with-stats` instead — it rewrites each usage entry as a visible hook message and runs the built-in HTML exporter:

```
/export-with-stats                  # export to pi-session-<name>.html in the current directory
/export-with-stats path/to/out.html  # export to a specific file
```

Each turn's stats appear in the export as a one-liner under the corresponding assistant message, e.g. `⚡ llama-swap — prompt 420 tok/s · gen 28.4 tok/s · 512→384 tok`.

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

### Suggestion model

By default the name is generated with the **current** model. Use `/session-name-model` to pick a different model (e.g. a cheap local one) — it opens a model picker and saves the choice to `sessionName.model` in `~/.pi/agent/settings.json`:

```
/session-name-model          # pick the suggestion model from a list
/session-name-model show     # show the configured suggestion model
/session-name-model clear    # reset to the current model
```

The picker also offers a `(default) current model` option to clear the setting. If the configured model is no longer available, generation falls back to the current model with a warning.

### Usage

```
/session-name                # generate a name (fresh excerpt, default)
/session-name full             # generate a name from the full session (cached prefix)
/session-name "My Name"        # set the name manually
/session-name show             # show the current session name
/session-name-model [show | clear]   # configure which model generates suggestions
```

Requires interactive (TUI) mode.

## benchmark

Benchmarks the currently selected model by giving it a build requirement and executing it right in the current interactive session.

Each run creates a working directory named after the model (and its active thinking level, if any) under `./benchmarks/`:

```
benchmarks/<provider>_<model>[@<thinking>]/
├── task.md            # the requirement plus run metadata (model, timestamp)
├── workspace/         # intermediate work files while building
└── final/             # final deliverables
```

If the directory already exists (e.g. from an earlier run), a timestamp suffix is appended so runs never collide. The current session is renamed to `<task> - <provider>/<model>[@ <thinking>]` before the run starts, so benchmark sessions are easy to spot in the session selector.

### Usage

```
/benchmark <requirement to build, or a file containing it>
```

If the argument is a path to an existing file (relative to the current directory), the file's content is used as the requirement — handy for sharing one task file across all model runs.

Examples:

```
/benchmark build a python CLI that converts csv files to json
/benchmark tasks/csv-to-cli.md
```

To benchmark several models, select each model (`Ctrl+P` / `/model`) and run `/benchmark` with the same requirement — then compare the `final/` folders of the per-model directories.

## context-size

Reports the current context usage of the active session.

### Features

- **`context_size` tool** — The agent can call it to find out how full the context is: used tokens, the active model's context window, usage percentage, and remaining free tokens. Useful when you ask "how much context is left?" or want the agent to self-check before long tasks
- **`/context-size` command** — Prints the same information as a notification, no LLM involved
- **Graceful degradation** — Reports "unknown" (with the context window) when usage is not yet available, e.g. right after compaction or before the first LLM response

### Output

```
Context usage: 45,231 / 200,000 tokens (22.6%)
Free: 154,769 tokens
```

## Development

```bash
# Install dependencies
npm install

# Run a single extension locally without installing
pi -e ./extensions/llama-swap.ts
pi -e ./extensions/handoff.ts
pi -e ./extensions/session-name.ts
pi -e ./extensions/benchmark.ts
pi -e ./extensions/context-size.ts
```

## License

MIT
