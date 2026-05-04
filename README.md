# pi-cursor-sdk

pi provider extension backed by `@cursor/sdk` local agents.

## What this is

This package lets pi use Cursor models through the local Cursor SDK while keeping model selection, thinking, context display, and the default footer native to pi.

Current behavior:

- discovers Cursor models with `Cursor.models.list()` when `CURSOR_API_KEY` is set
- registers Cursor models under the `cursor` provider
- registers one pi model per Cursor `context` value, using IDs like `gpt-5.5@1m`
- maps Cursor `reasoning`, `effort`, and boolean `thinking` to pi native thinking levels
- keeps Cursor `fast` as extension state, toggled with `/cursor-fast` or forced for one run with `--cursor-fast` / `--cursor-no-fast`
- shows Cursor fast mode through `ctx.ui.setStatus()` and leaves pi's default footer intact
- creates a fresh local Cursor agent for each pi provider call

## Requirements

- Node.js
- pi
- a Cursor API key exposed as the `CURSOR_API_KEY` environment variable

No global `@cursor/sdk` install is required. This package depends on `@cursor/sdk`, so a normal package install brings in the SDK version the extension was built and tested against.

## Install

### Local development from a checkout

```bash
npm install
pi -e .
```

Pick a model with `/model`, or pass one directly:

```bash
pi -e . --model cursor/gpt-5.5@1m -p "Say ok only."
```

### Pi package install from a package source

Install a local package path:

```bash
pi install /absolute/path/to/pi-cursor-sdk
```

Use the npm source form when installing from npm:

```bash
pi install npm:pi-cursor-sdk
```

## API key

Set `CURSOR_API_KEY` in the environment before starting pi:

```bash
export CURSOR_API_KEY="your-key"
```

Or pass it for one command:

```bash
CURSOR_API_KEY="your-key" pi -e . --model cursor/gpt-5.5@1m -p "Say ok only."
```

Actual Cursor runs require `CURSOR_API_KEY` or pi's `--api-key` option. If model discovery cannot authenticate or reach Cursor, pi may still list fallback Cursor models. A runtime setup/auth error means the key was missing, invalid, unauthorized, or not exported into the pi process.

Do not store the API key in `~/.pi/agent/cursor-sdk.json`; that file is only for non-secret extension state such as Cursor fast defaults. `PATH` is only for executable lookup and should not contain the API key.

## Model IDs

Cursor-only parameters are not encoded into pi model IDs.

For models where `Cursor.models.list()` exposes a `context` parameter, the extension parses that context value directly. For models where the catalog does not include a context parameter, the extension ships a bundled SDK-derived default/non-Max context-window cache generated from `createAgentPlatform().checkpointStore.loadLatest(agentId).tokenDetails.maxTokens`. Successful runs can update a local override cache, but model discovery does not probe models at startup.

Max Mode has larger context windows, but `@cursor/sdk` 1.0.12 does not expose a public `ModelSelection` field that enables Max Mode for these local agent runs. The extension therefore does not advertise Max Mode windows for non-Max model IDs. Add Max-specific pi model IDs only when the SDK exposes an exact Max Mode selector and the implementation uses that selector.

Examples:

- `cursor/composer-2`
- `cursor/gpt-5.5@1m`
- `cursor/gpt-5.5@272k`
- `cursor/claude-opus-4-7@300k`

Rules:

- Cursor `context` becomes a pi-visible model variant because it changes `contextWindow`.
- Cursor `reasoning`, `effort`, and `thinking` map to pi native thinking.
- Cursor `fast` is extension state, not model identity.

## Thinking support

Use pi's native thinking controls:

```bash
pi --model cursor/gpt-5.5@1m --thinking medium -p "Say ok only"
pi --model cursor/gpt-5.5@272k:xhigh -p "Say ok only"
```

The extension builds Cursor SDK params from the selected pi thinking level:

- `reasoning=none|low|medium|high|extra-high`
- `effort=low|medium|high|xhigh|max`
- `thinking=false|true` for boolean thinking models

For Claude models with both `thinking` and `effort`, pi thinking `off` sends `thinking=false` and omits `effort`.

### Why some Cursor models show `thinking=no`

In `pi --list-models`, the `thinking` column means pi can control the model's thinking level with `--thinking`, a final `:medium` model suffix, or shift+tab.

Some Cursor models can still reason internally, and Cursor may still emit thinking deltas for them, even when Cursor does not expose a `reasoning`, `effort`, or `thinking` parameter for the extension to set. Those models show `thinking=no` because there is no pi-controllable Cursor SDK parameter. The extension does not disable Cursor's own default/internal reasoning behavior.

## Fast mode

Use `/cursor-fast` to persistently toggle fast mode for the selected Cursor model when supported.

Fast preferences are stored:

- in the current session with `pi.appendEntry()`
- globally per Cursor base model in `~/.pi/agent/cursor-sdk.json`

For one run, force fast on or off without changing stored preferences:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
pi --model cursor/composer-2 --cursor-no-fast -p "Say ok only"
```

`composer-2` can default to fast. Use `--cursor-no-fast` for a one-shot no-fast `composer-2` run.

When fast is enabled, the default pi footer gets an extension status line:

```text
cursor fast
```

## Images

Images from the latest user message are forwarded to Cursor. Historical images are kept out of the transcript. The extension advertises `text` and `image` input for Cursor models because Cursor's SDK accepts image messages and Cursor models are expected to support them.

## Fallback models

If `CURSOR_API_KEY` is missing or model discovery fails, the extension registers conservative fallback Cursor models with the same native shape and notifies interactive users when possible:

- `composer-2`
- `gpt-5.5@1m`, `gpt-5.5@272k`
- `claude-sonnet-4-6@1m`, `claude-sonnet-4-6@300k`
- `claude-opus-4-7@1m`, `claude-opus-4-7@300k`

Fallback models are only a startup model list. Actual Cursor runs still need `CURSOR_API_KEY` or `--api-key`. If a run fails with a Cursor SDK setup/auth message, verify the key is correct and exported to the same shell or process that starts pi.

## Limits

- local agents only; no Cursor cloud agent support
- Cursor tool calls are not exposed as pi tool calls; Cursor-side tool activity is surfaced as compact trace text before the final answer
- pi tool schemas are not passed through to Cursor
- Cursor text deltas are buffered until Cursor trace/tool activity is complete so the final answer does not appear before its trace
- one fresh Cursor agent per provider call
- ambient Cursor setting/rule layers are not loaded by default because the current Cursor SDK writes setting-load logs directly to terminal output, which corrupts pi's TUI
- Cursor SDK model metadata does not currently expose output token limits, so the extension uses conservative token defaults

## Development

Run checks:

```bash
npm test
npm run typecheck
```

## License

MIT
