# pi-cursor-sdk

A pi provider extension that lets pi use Cursor models through the local `@cursor/sdk` agent runtime.

Use this extension if you want Cursor's model catalog inside pi while keeping pi's native model picker, thinking controls where the SDK exposes them, session restore, context display, and default footer UX.

## Quick start

1. Install the package:

```bash
pi install npm:pi-cursor-sdk
```

Or install from GitHub:

```bash
pi install https://github.com/fitchmultz/pi-cursor-sdk
```

2. Start pi with a Cursor model:

```bash
pi --model cursor/composer-2
```

3. In pi, run `/login`, choose `Use an API key`, choose `Cursor`, and paste your Cursor API key.

If pi started without a key, run `/reload` or restart pi after `/login` to refresh the full live Cursor model catalog. Inside pi, use `/model` to choose another Cursor model.

## Requirements

- Node.js 18+
- pi
- a Cursor API key saved through `/login`, available as `CURSOR_API_KEY`, or passed with pi's `--api-key`

No global `@cursor/sdk` install is required. This package depends on `@cursor/sdk`, so normal package installation brings in the SDK version this extension was built and tested against.

## Install

### Global install

```bash
pi install npm:pi-cursor-sdk
```

Alternative GitHub install:

```bash
pi install https://github.com/fitchmultz/pi-cursor-sdk
```

### Project-local install

Use `-l` if you want the package recorded in the current project's `.pi/settings.json` instead of your global pi settings:

```bash
pi install -l npm:pi-cursor-sdk
```

### Try from a local checkout

For development from this repository:

```bash
npm install
pi -e . --model cursor/composer-2
```

## Configure your Cursor API key

Preferred setup:

```bash
pi --model cursor/composer-2
```

Then, inside pi:

1. Run `/login`.
2. Select `Use an API key`.
3. Select `Cursor`.
4. Paste your Cursor API key.
5. The key is saved in pi's native `~/.pi/agent/auth.json`.

If pi started without a key, fallback Cursor models still register so `/login` is reachable. After `/login`, fallback model runs can use the stored key, but `/reload` or a restart is needed to refresh the full live Cursor model catalog discovered from the Cursor SDK.

Environment setup:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/composer-2
```

One-shot setup:

```bash
pi --api-key "your-key" --model cursor/composer-2 --cursor-no-fast -p "Say ok only."
```

Discovery uses pi's native resolution order for this extension: `--api-key`, the stored `cursor` key in `~/.pi/agent/auth.json`, then `CURSOR_API_KEY`.

Do not store the API key in `~/.pi/agent/cursor-sdk.json`. That file is only for non-secret extension state such as Cursor fast defaults. `PATH` is only for executable lookup and should not contain the API key.

## Verify your setup

List Cursor models:

```bash
pi --list-models cursor
```

Expected behavior:

- with a valid key, Cursor models appear under the `cursor` provider
- if discovery cannot authenticate or reach Cursor, pi may still show fallback Cursor models; after adding auth with `/login`, fallback model runs can use the saved key, and `/reload` or restart refreshes the live catalog

Smoke test:

```bash
pi --model cursor/composer-2 --cursor-no-fast -p "Reply with: ok"
```

## Choosing a model

Choose Cursor models interactively with `/model`, or pass a model on the command line:

```bash
pi --model cursor/composer-2
pi --model cursor/gpt-5.5@1m
pi --model cursor/gpt-5.5@272k
pi --model cursor/claude-opus-4-7@300k
```

How to read model IDs:

- `cursor/...` is the Cursor provider registered by this extension
- `@1m`, `@272k`, and `@300k` are context-window variants
- `:medium`, `:high`, and `:xhigh` are pi thinking-level suffixes for models where the Cursor SDK exposes a pi-controllable thinking parameter

Examples with pi thinking controls:

```bash
pi --model cursor/gpt-5.5@1m:medium
pi --model cursor/gpt-5.5@272k:xhigh
pi --model cursor/gpt-5.5@1m --thinking medium
```

Cursor-only parameters are not encoded into pi model IDs. Cursor `context` becomes a pi-visible model variant because it changes pi's native `contextWindow`; Cursor `fast` is extension state, not model identity.

## Thinking support

All Cursor SDK models should be treated as thinking-capable Cursor models. The `thinking` column in `pi --list-models` is narrower: it only means pi can control a Cursor SDK thinking parameter for that model.

For models where Cursor exposes `reasoning`, `effort`, or boolean `thinking` parameters, pi's native thinking controls map to Cursor SDK params:

- `reasoning=none|low|medium|high|extra-high`
- `effort=low|medium|high|xhigh|max`
- `thinking=false|true` for boolean thinking models

For Claude models with both `thinking` and `effort`, pi thinking `off` sends `thinking=false` and omits `effort`.

### Why some Cursor models show `thinking=no`

In `pi --list-models`, `thinking=no` means pi cannot control the model's thinking level with `--thinking`, a final `:medium` model suffix, or shift+tab. It does not mean the Cursor model cannot think.

Some Cursor SDK models do not expose a `reasoning`, `effort`, or `thinking` parameter for the extension to set. Cursor thinking is still enabled/supported by the model, and Cursor may still emit thinking deltas. The extension does not disable Cursor's default reasoning behavior.

## Fast mode

Use `/cursor-fast` to persistently toggle fast mode for the selected Cursor model when the model supports Cursor's `fast` parameter.

Fast preferences are remembered per Cursor base model and stored:

- in the current session with `pi.appendEntry()`
- globally in `~/.pi/agent/cursor-sdk.json`

For one run, force fast on or off without changing saved defaults:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
pi --model cursor/composer-2 --cursor-no-fast -p "Say ok only"
```

`composer-2` can default to fast. Use `--cursor-no-fast` for a one-shot no-fast `composer-2` run. In print mode (`-p`), `--cursor-no-fast` is silent and does not write `~/.pi/agent/cursor-sdk.json`.

In interactive mode, the footer only shows fast mode when fast is enabled:

```text
cursor fast
```

If you do not see `cursor fast`, fast mode is off.

## Images

Images from the latest user message are forwarded to Cursor. Historical images are kept out of the transcript. The extension advertises `text` and `image` input for Cursor models because Cursor's SDK accepts image messages and Cursor models are expected to support them.

## Fallback models

If no key is available from `/login`, `CURSOR_API_KEY`, or `--api-key`, model discovery fails, or discovery returns no models, the extension registers conservative fallback Cursor models and notifies interactive users when possible:

- `composer-2`
- `gpt-5.5@1m`, `gpt-5.5@272k`
- `claude-sonnet-4-6@1m`, `claude-sonnet-4-6@300k`
- `claude-opus-4-7@1m`, `claude-opus-4-7@300k`

Fallback models are a conservative startup model list. Actual Cursor runs still need a key from `/login`, `CURSOR_API_KEY`, or `--api-key`. If you add auth after startup, run `/reload` or restart pi to refresh the full live Cursor model catalog.

## Limits

- **Local Cursor SDK agents only.** This extension does not use Cursor cloud agents.
- **Cursor-side tool use is not exposed as pi tool calls.** You may see a concise Cursor activity trace before the final answer, but you will not get normal pi tool-call rows for Cursor's internal tool activity.
- **Pi tool schemas are not passed through to Cursor.** This extension is a Cursor provider, not a bridge that forwards pi's tool system into Cursor.
- **One fresh Cursor agent is created per provider call.** Cursor agent state is not reused between pi provider calls.
- **Ambient Cursor setting/rule layers are not loaded by default.** The current Cursor SDK writes setting/rule loading logs directly to terminal output, which corrupts pi's TUI, so the extension leaves those layers out.
- **Max Mode is not exposed for these local runs.** The extension only advertises exact context windows supported by the SDK path it uses.
- **Output token limits are conservative.** Cursor SDK model metadata does not currently expose output token limits directly.
- **Token usage is approximate in pi.** Cursor SDK usage events include internal agent/tool/cache work, so the extension reports an approximate replayable pi prompt/output size for context display and compaction decisions.

## Troubleshooting

### I can see Cursor models, but runs fail

You may be seeing fallback startup models or a missing/invalid key. In interactive pi, run `/login`, choose `Use an API key`, choose `Cursor`, paste the key, then run `/reload` or restart pi.

You can also restart pi with a key in the same shell or launcher that starts pi:

```bash
export CURSOR_API_KEY="your-key"
pi --model cursor/composer-2
```

Or run a one-shot command:

```bash
pi --api-key "your-key" --model cursor/composer-2 -p "Say ok only"
```

### `pi --list-models cursor` shows no Cursor models

Confirm the package is installed:

```bash
pi list
```

Then reinstall if needed:

```bash
pi install npm:pi-cursor-sdk
```

### `pi --list-models` shows `thinking=no`

That does not mean the model cannot think. It means the Cursor SDK does not expose a pi-controllable thinking parameter for that model. The model may still think internally and may still emit thinking deltas.

### I do not see `cursor fast` in the footer

Fast mode is currently off. The footer only shows `cursor fast` when fast mode is enabled.

### My Cursor app settings or rules do not seem to apply

They are not loaded by default in this extension. See [Limits](#limits).

## Development

Run checks:

```bash
npm test
npm run typecheck
```

Local development run:

```bash
npm install
CURSOR_API_KEY="your-key" pi -e . --model cursor/composer-2
```

Maintainer design notes live in [`docs/cursor-model-ux-spec.md`](docs/cursor-model-ux-spec.md).

## License

MIT
