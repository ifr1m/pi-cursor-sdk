# Cursor Model UX Spec

> Maintainer note: this is an internal design and behavior spec for pi-cursor-sdk. If you are trying to install or use the extension, start with the main [README](../README.md) instead.

## Status

Implemented design target. This file describes the intended Cursor model UX and should stay aligned with the current code in `src/`.

Current implementation notes:

- Cursor context variants use `base@context` pi model IDs.
- Cursor `reasoning`, `effort`, and boolean `thinking` parameters are driven by pi native thinking when the Cursor SDK exposes those controls.
- Cursor `fast` is extension state, not model identity.
- Cursor fast status uses `ctx.ui.setStatus()`; the default pi footer remains intact.
- Installed `@cursor/sdk` user messages accept images, and Cursor models are treated as image-capable; registered input metadata is `text` plus `image`.
- `@cursor/sdk` is a package dependency of this extension; users should not need a global SDK install.
- Cursor auth uses pi-native API-key resolution for provider `cursor`: CLI `--api-key`, stored `~/.pi/agent/auth.json` API key from `/login`, then `CURSOR_API_KEY`. The extension config file stores only non-secret Cursor-only state such as fast defaults.
- Local agents do not pass `settingSources` by default because the current Cursor SDK writes setting/rule loading INFO logs directly to terminal output, which corrupts pi's TUI.
- Cursor SDK models are treated as thinking-capable even when pi reports `thinking=no`; that pi column only means the SDK did not expose a pi-controllable thinking parameter for that model.
- Cursor-side thinking remains visible. Cursor internal tool activity is surfaced as bounded pi-like transcript content before final text where possible (for example `read <path>` with file preview or `$ <command>` with output), while avoiding actual pi `toolCall` blocks so pi does not re-execute tools that Cursor already ran. This is intentionally provider-only: the TUI can show readable tool traces, but it cannot show native green tool-result cards or increment tool-call/tool-result counts without a pi core API for non-executing external tool transcripts. Cursor text deltas are treated as intermediate progress unless the final run result is unavailable, so the saved visible answer stays clean while message content order remains trace first, tool transcript, final answer.
- Cursor SDK usage events report cumulative internal agent/tool/cache work, not the replayable pi prompt context. The extension reports approximate prompt/output usage for pi context display and compaction decisions instead of copying raw Cursor SDK usage.
- For models without a catalog `context` parameter, context windows are not hardcoded. The extension ships a bundled SDK-derived default/non-Max cache generated from `createAgentPlatform().checkpointStore.loadLatest(agentId).tokenDetails.maxTokens`. Successful runs can update a local override cache, but model discovery does not probe models at startup.
- Max Mode context windows are distinct from default/non-Max context windows. `@cursor/sdk` 1.0.12 exposes internal protobuf fields named `maxMode`/`max_mode`, but the public `ModelSelection` type and the local executor path do not pass a Max Mode selector for local agent runs. Do not advertise Max Mode context windows unless the SDK catalog exposes an exact parameter/variant or the SDK public API adds a Max Mode selector that the extension actually sends.

## Goal

Make Cursor models feel native in pi by leaning on pi's existing model, thinking, footer, and session behavior instead of building a parallel Cursor parameter system.

Main outcomes:

- `pi --list-models` shows pi-native Cursor models with accurate `contextWindow`, pi-controllable thinking metadata, and conservative defaults where the Cursor SDK does not expose limits or capabilities.
- `shift+tab` is pi's native thinking control and drives Cursor `reasoning` or `effort`.
- Cursor context options are represented as pi-visible model variants when they change native model metadata.
- Cursor-only state, currently `fast`, is controlled by extension commands and shown through native status text.
- The default pi footer remains intact.
- Model capabilities are discovered from the Cursor SDK, not hardcoded per model.

Native tradeoff: context-capable Cursor models intentionally use context-qualified pi model IDs. This gives up one completely clean row per Cursor base model, but it lets pi's native `contextWindow`, footer context usage, context overflow checks, compaction behavior, session restore, model selection, and `--list-models` metadata stay accurate.

## Non-goals

Not building now:

- verbosity support
- custom UI panels
- generic pi model-parameter system for all providers
- full custom footer replacement
- independent Claude `thinking` toggle separate from pi thinking
- multi-parameter CLI suffixes such as `--model cursor/gpt-5.5:medium:272k:fast`

## Source of Truth

Cursor SDK is the source of truth for Cursor model IDs and Cursor-supported parameters.

At startup, the extension calls:

```ts
Cursor.models.list({ apiKey });
```

Discovery resolves `apiKey` in this order:

1. CLI `--api-key`.
2. Stored pi auth for provider `cursor` from `AuthStorage.create().getApiKey("cursor", { includeFallback: false })`.
3. `CURSOR_API_KEY`.

Users can persist the stored key through `/login` -> `Use an API key` -> `Cursor`. If auth is added after startup, fallback models can run once pi resolves the saved key for provider requests, but `/reload` or restart is required to refresh the full live Cursor model catalog.

For each model, use:

- `model.id`
- `model.displayName`
- `model.parameters`
- `model.variants`
- default variant: `variant.isDefault === true`, else first variant

This means new Cursor models and changed Cursor parameters are picked up after reload/restart.

Pi model metadata is also a source of truth for pi-native behavior:

- `ProviderModelConfig.id`
- `ProviderModelConfig.name`
- `ProviderModelConfig.reasoning`: means pi-controllable thinking, not whether a Cursor model is thinking-capable
- `ProviderModelConfig.thinkingLevelMap`
- `ProviderModelConfig.contextWindow`
- `ProviderModelConfig.maxTokens`
- `ProviderModelConfig.input`

If a Cursor parameter changes any of those pi-native fields, model registration must expose that change to pi.

### Refresh Current Cursor Matrix

Run this whenever Cursor releases or changes models:

```bash
node --input-type=module <<'EOF'
import { Cursor } from '@cursor/sdk';

const models = await Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY });
for (const model of models) {
  const options = (model.parameters ?? [])
    .map((param) => `${param.id}: ${param.values.map((value) => value.value).join(', ')}`)
    .join(' | ') || 'none';
  const defaultVariant = model.variants?.find((variant) => variant.isDefault) ?? model.variants?.[0];
  const defaults = defaultVariant?.params?.map((param) => `${param.id}=${param.value}`).join('; ') || 'none';
  console.log(`${model.id}\t${model.displayName}\t${options}\t${defaults}`);
}
EOF
```

## Design Direction

Use native pi abstractions wherever possible:

| Concern | Representation |
|---|---|
| Cursor base model | pi provider model |
| Cursor `context` | pi-visible model variant because it changes `contextWindow` |
| Cursor `reasoning` | pi native thinking via `thinkingLevelMap` |
| Cursor `effort` | pi native thinking via `thinkingLevelMap` |
| Cursor `thinking=false` | pi native `off` |
| Cursor `fast` | extension state, not model identity |
| Footer | default pi footer plus optional extension status |

Reason:

- pi already persists model and thinking selection.
- pi already clamps unsupported thinking levels from `thinkingLevelMap`.
- pi context display, context overflow, and compaction depend on `contextWindow`.
- extension APIs can replace the whole footer but cannot partially mutate the default model text.

## Model Registration

Register a `cursor` provider with `pi.registerProvider()`.

Rules:

- Register one pi model for each Cursor base model when there is no Cursor `context` parameter.
- Register one pi model per Cursor `context` value when the model exposes a `context` parameter.
- Do not encode `reasoning`, `effort`, `thinking`, or `fast` into pi model IDs.
- Prefer stable, readable `@<context>` suffixes that do not conflict with pi's final `:<thinking>` suffix parser.
- Sort Cursor models by base ID, then context value in Cursor SDK order before calling `pi.registerProvider()`. Registration order matters for `/model` display and model cycling; `--list-models` sorts output separately.

Recommended context-variant ID format:

```text
cursor/gpt-5.5@1m
cursor/gpt-5.5@272k
cursor/claude-opus-4-7@1m
cursor/claude-opus-4-7@300k
cursor/composer-2
```

Avoid colon-based context IDs in the first implementation unless this spec is intentionally changed:

```text
cursor/gpt-5.5:1m
cursor/gpt-5.5:1m:medium
```

Those can work technically because pi parses only the final `:<thinking>` suffix, but they overload pi's documented thinking shorthand.

Avoid this old parameter encoding:

```text
cursor/gpt-5.5:context=1m;fast=false;reasoning=medium
cursor/claude-opus-4-7:context=1m;effort=xhigh;thinking=true
```

Reason:

- `@1m` keeps context visually separate from pi's native `:medium` thinking suffix.
- Context variants make `contextWindow` accurate in `--list-models`, the native footer, context overflow checks, and compaction logic.
- `fast` is intentionally not a model variant because it does not affect pi model metadata and would double list noise.

### Metadata Per Registered Model

Each registered model must set:

- `id`: context-qualified pi model ID when needed.
- `name`: human-readable Cursor display name plus context when useful.
- `reasoning`: `true` only if a Cursor `reasoning`, `effort`, or `thinking` parameter can map to pi thinking. This controls pi's thinking UI and `pi --list-models` `thinking` column; it must not be used to claim whether the Cursor model can think internally. Cursor SDK models are thinking-capable even when this is `false`.
- `thinkingLevelMap`: model-specific pi-to-Cursor mapping for pi UI, clamping, persistence, and footer display.
- `contextWindow`: parsed from context variant, else conservative fallback.
- `maxTokens`: conservative explicit value until Cursor SDK exposes output limits.
- `input`: supported input types. The installed Cursor SDK accepts `SDKUserMessage.images`, and Cursor models are expected to support image input, so advertise `["text", "image"]`.
- `cost`: zeroed unless reliable Cursor costs are available.

The extension stores runtime metadata in an internal map keyed by registered pi model ID. That map records the Cursor base model ID, selected context param, default params, and discovered capabilities. `ProviderModelConfig` has no dedicated metadata field, so do not rely on hidden custom fields for this state.

## Dynamic Capabilities

No per-model hardcoded control list.

Infer behavior from discovered params:

| Cursor param | Extension behavior |
|---|---|
| `context` with values | register pi-visible context variants |
| `reasoning` | populate `thinkingLevelMap` |
| `effort` | populate `thinkingLevelMap` |
| `thinking` with `true/false` | map `false` to pi `off`; map `true` to the enabled pi level chosen for boolean-only thinking |
| `fast` with `true/false` | enable fast extension setting |

Unsupported Cursor-only actions are no-op plus a short notification.

Example:

```text
Fast mode not supported by gemini-3.1-pro
```

## Keybindings And Commands

Native pi keybindings:

| Action | Keybinding | Owner |
|---|---:|---|
| Cycle thinking / reasoning / effort | `shift+tab` | pi native `app.thinking.cycle` |
| Select model / context variant | `/model`, `ctrl+l`, scoped model cycling | pi native model selection |

Cursor extension controls:

| Action | Preferred control | Applies when |
|---|---:|---|
| Toggle fast | `/cursor-fast` | model has `fast` |

Do not register a shortcut for `shift+tab`. Pi reserves the native thinking keybinding, and the extension should only influence it through model metadata.

Do not add a context-cycle shortcut in the first pass. Context is a pi model variant, so users should change it through native model selection/cycling.

## Thinking / Reasoning / Effort Mapping

Important distinction:

- **Cursor thinking support** applies to all Cursor SDK models. The extension should assume Cursor models can think and may emit thinking deltas.
- **Pi-controllable thinking** means Cursor exposes a `reasoning`, `effort`, or `thinking` parameter that the extension can set from pi's native thinking level. These models register `reasoning: true` and show `thinking=yes` in `pi --list-models`.
- **Cursor SDK thinking-control gap** means the model can still think, but the SDK does not expose a user-controllable thinking parameter for that model. These models register `reasoning: false` and show `thinking=no` in `pi --list-models` because pi cannot control a level for them. The extension still parses Cursor `thinking-delta` events if they are emitted.

Do not mark a model `reasoning: true` only because it can think. That would make pi show controls such as `--thinking`, `:medium`, and shift+tab even though the extension cannot translate them into Cursor SDK params.

Pi levels:

```text
off, minimal, low, medium, high, xhigh
```

Cursor values vary by model. Build `thinkingLevelMap` from the values Cursor exposes.

Mapping rules:

| pi level | Cursor value preference |
|---|---|
| `off` | `none`, else `off`, else `false`, else unsupported |
| `minimal` | `minimal`, else unsupported |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high`, else `true` for boolean-only thinking |
| `xhigh` | `xhigh`, else `max`, else `extra-high` |

Important details:

- Use `null` for unsupported pi levels so pi hides/skips/clamps them natively.
- Include `xhigh` only when Cursor exposes a real value for it.
- Prefer exact `xhigh` over `max`. Cursor currently exposes both on some Claude models, and exact `xhigh` is the closer native mapping.
- If Cursor exposes `reasoning=none`, map pi `off` to `none`.
- If Cursor exposes `thinking=false`, map pi `off` to `false`.
- `thinkingLevelMap` does not create Cursor SDK params by itself. It only controls pi-native behavior. The Cursor stream implementation must use the active pi thinking level plus the extension's discovered Cursor metadata to build `ModelSelection.params` for `Agent.create()`.

For boolean-only `thinking`, unsupported pi levels must be explicit `null`; otherwise pi treats omitted non-`xhigh` levels as supported. Use this shape unless Cursor exposes richer values:

```ts
{
  off: "false",
  minimal: null,
  low: null,
  medium: null,
  high: "true",
  xhigh: null,
}
```

## Claude Behavior

Some Claude models support both:

```text
thinking=true|false
effort=low|medium|high|xhigh|max
```

Rules:

- Pi `off` sends `thinking=false`.
- Pi enabled levels send `thinking=true` and the mapped `effort`.
- `shift+tab` changes pi thinking, which changes Cursor `effort`.
- There is no separate `thinking` toggle.

Reason:

- This matches pi's single thinking mental model.
- It avoids an independent Cursor `thinking` state that the native footer, CLI, and session thinking persistence cannot represent.
- Users can still disable Claude thinking with pi `off`.

## Context Behavior

If a Cursor model supports `context`, register one pi model variant per context value.

Examples:

```text
cursor/gpt-5.5@272k
cursor/gpt-5.5@1m

cursor/claude-opus-4-7@300k
cursor/claude-opus-4-7@1m

cursor/grok-4.3@200k
cursor/grok-4.3@1m
```

Each variant must:

- have an entry in the extension metadata map that points back to the same Cursor base model ID,
- include the selected Cursor `context` param when calling `Agent.create()`,
- set pi `contextWindow` from that context value,
- share the same `thinkingLevelMap` as the base model unless Cursor reports otherwise.

Reason:

- pi context display and overflow logic must match the actual Cursor context.
- pi has no generic provider-parameter system that can change `contextWindow` while keeping the same model ID.

## Fast Behavior

If a model supports `fast`:

```text
fast=false <-> fast=true
```

Rules:

- `fast` is extension state, not pi model identity.
- Toggle with `/cursor-fast`.
- Store per-session and global per-base-model preferences.
- When calling `Agent.create()`, include the selected `fast` value in Cursor model params.
- Show `fast` through `ctx.ui.setStatus()` when enabled.
- Support a first-pass CLI flag, `--cursor-fast`, to force fast mode for one run when the selected model supports it.

Reason:

- `fast` does not affect pi `contextWindow`, thinking levels, or input support.
- Registering fast/non-fast variants would make `--list-models` noisy without improving native pi behavior.

Status example:

```text
cursor fast
```

## Footer Behavior

Hard requirement:

- Leave pi's default footer intact.
- Do not use `ctx.ui.setFooter()` for the first pass.
- Use `ctx.ui.setStatus()` only for Cursor-only state that pi cannot show natively, such as `fast`.
- Non-cursor models must have no Cursor status.

Reason:

- `ctx.ui.setFooter()` replaces the entire built-in footer.
- pi has no public extension API to mutate only the model text in the default footer.
- Reimplementing the default footer would create drift with pi's native footer behavior.

Expected native footer behavior:

- provider/model is shown by pi from the selected `cursor` model,
- thinking level is shown by pi when `reasoning` is true,
- context usage is computed from `contextWindow`,
- extension status adds only Cursor-only text such as `cursor fast`.

`ctx.ui.setStatus()` adds an extension status line in the default footer. It does not patch the built-in model segment. The native shape is closer to:

```text
...                                      (cursor) gpt-5.5@1m • medium
cursor fast
```

not:

```text
(cursor) gpt-5.5 • 1M • medium • fast
```

## State And Persistence

Match pi's native mental model:

### Native pi state

Let pi persist:

- selected model, including context variant,
- selected thinking level,
- session model restore,
- global default thinking behavior.

### Extension state

The extension persists only Cursor-only state:

- `fast` per session,
- `fast` global default per Cursor base model,
- any future Cursor-only parameter that does not map to pi model metadata.

Use:

- `pi.appendEntry()` for session state that must survive resume/fork/reload,
- an extension-owned global config file for cross-session defaults,
- in-memory state only as a cache rebuilt from persisted state on `session_start`.

### New Install

Use Cursor default variants:

```text
gpt-5.5 -> cursor/gpt-5.5@1m, thinking medium, fast=false
composer-2 -> cursor/composer-2, fast=true
```

### Resume Session

Restore:

- pi model, including context variant,
- pi thinking level,
- session Cursor-only state such as `fast`.

### New Session

Use:

1. pi's selected/default model and thinking level,
2. global saved Cursor-only defaults for the selected base model,
3. else Cursor default variant params.

## CLI / Print Mode

Guaranteed first-pass support:

```bash
pi --model cursor/gpt-5.5@1m --thinking medium
pi --model cursor/gpt-5.5@1m:medium
pi --model cursor/gpt-5.5@272k:xhigh
```

These use pi's native thinking parser. `--thinking` wins over a `:<thinking>` suffix when both are present.

Not first-pass support:

```bash
pi --model cursor/gpt-5.5:medium:272k:fast
```

Reason:

- pi supports one final `:<thinking>` suffix.
- Cursor-only parameters are not generic pi CLI parameters.
- Context is already represented by the registered pi model ID.
- `fast` is controlled by saved extension defaults or the first-pass `--cursor-fast` extension flag.

For print mode:

- no keybindings,
- use selected context model variant,
- use `--thinking` or `:medium` for reasoning/effort,
- use saved global `fast` defaults unless `--cursor-fast` is present.

Fast flag example:

```bash
pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"
```

## Current Discovered Model Capability Examples

Current live Cursor data says:

| Model | Cursor controls | Pi representation |
|---|---|---|
| `default` | none | plain model |
| `composer-2` | fast | plain model + fast extension state |
| `composer-1.5` | none | plain model |
| `gpt-5.5` | context, reasoning, fast | context variants + native thinking + fast state |
| `gpt-5.4` | context, reasoning, fast | context variants + native thinking + fast state |
| `gpt-5.4-mini` | reasoning | plain model + native thinking |
| `gpt-5.4-nano` | reasoning | plain model + native thinking |
| `gpt-5.3-codex` | reasoning, fast | plain model + native thinking + fast state |
| `gpt-5.3-codex-spark` | reasoning | plain model + native thinking |
| `gpt-5.2` | reasoning, fast | plain model + native thinking + fast state |
| `gpt-5.2-codex` | reasoning, fast | plain model + native thinking + fast state |
| `gpt-5.1-codex-max` | reasoning, fast | plain model + native thinking + fast state |
| `gpt-5.1-codex-mini` | reasoning | plain model + native thinking |
| `gpt-5.1` | reasoning | plain model + native thinking |
| `claude-opus-4-7` | thinking, context, effort | context variants + native thinking |
| `claude-opus-4-6` | thinking, context, effort, fast | context variants + native thinking + fast state |
| `claude-opus-4-5` | thinking | plain model + native thinking |
| `claude-sonnet-4-6` | thinking, context, effort | context variants + native thinking |
| `claude-sonnet-4-5` | thinking, context | context-qualified model + native thinking |
| `claude-sonnet-4` | thinking, context | context-qualified model + native thinking |
| `claude-haiku-4-5` | thinking | plain model + native thinking |
| `grok-4.3` | context | context variants |
| `grok-4-20` | thinking | plain model + native thinking |
| `gemini-3.1-pro` | none | plain model |
| `gemini-3-flash` | none | plain model |
| `gemini-2.5-flash` | none | plain model |
| `gpt-5-mini` | none | plain model |
| `kimi-k2.5` | none | plain model |

If Cursor later adds `fast`, `context`, `reasoning`, or `effort` to a model, the extension picks it up dynamically.

## Detailed Examples

### `composer-2`

Initial Cursor default:

```text
pi model: cursor/composer-2
Cursor params: fast=true
pi thinking: off
Cursor status: cursor fast
```

Toggle fast:

```text
Cursor params: fast=false
Cursor status: cleared
```

`shift+tab`: no-op because the model is not reasoning-capable.

### `gpt-5.5`

Initial Cursor default:

```text
pi model: cursor/gpt-5.5@1m
Cursor params: context=1m; reasoning=medium; fast=false
pi thinking: medium
Cursor status: cleared
```

After selecting the 272k variant:

```text
pi model: cursor/gpt-5.5@272k
Cursor params: context=272k; reasoning=medium; fast=false
pi contextWindow: 272000
```

After fast toggle:

```text
Cursor params: context=272k; reasoning=medium; fast=true
Cursor status: cursor fast
```

After `shift+tab` to xhigh:

```text
pi thinking: xhigh
Cursor params: context=272k; reasoning=extra-high; fast=true
```

### `gpt-5.3-codex`

Initial Cursor default:

```text
pi model: cursor/gpt-5.3-codex
Cursor params: reasoning=high; fast=true
pi thinking: high
Cursor status: cursor fast
```

After `shift+tab` to low:

```text
pi thinking: low
Cursor params: reasoning=low; fast=true
```

No context variant.

### `claude-opus-4-7`

Initial Cursor default:

```text
pi model: cursor/claude-opus-4-7@1m
Cursor params: thinking=true; context=1m; effort=xhigh
pi thinking: xhigh
```

After selecting the 300k variant:

```text
pi model: cursor/claude-opus-4-7@300k
Cursor params: thinking=true; context=300k; effort=xhigh
pi contextWindow: 300000
```

After `shift+tab` to high:

```text
pi thinking: high
Cursor params: thinking=true; context=300k; effort=high
```

After `shift+tab` to off:

```text
pi thinking: off
Cursor params: thinking=false; context=300k
```

### `grok-4.3`

Supports context only.

```text
cursor/grok-4.3@1m
cursor/grok-4.3@200k
```

Fast toggle: no-op.

`shift+tab`: no-op because the model is not reasoning-capable.

## Validation Plan

Before calling done:

1. Unit tests:
   - context-variant model IDs
   - dynamic capability discovery
   - context variant registration and decoding
   - fast extension state and status behavior
   - `reasoning` mapping
   - `effort` mapping
   - boolean `thinking` maps to pi `off` / enabled levels
   - pi `xhigh` preference order: `xhigh`, then `max`, then `extra-high`
   - session restore for Cursor-only state
   - global default state for Cursor-only state
   - unsupported no-op notifications

2. Runtime checks:
   - `pi --list-models cursor`
   - confirm context variants show expected `context` column
   - launch interactive with Cursor
   - verify default pi footer remains unchanged
   - verify Cursor `fast` status appears only when enabled
   - verify non-cursor footer/status unchanged
   - verify `shift+tab` uses pi native thinking
   - verify context changes through native model selection
   - verify resume restores model, thinking, and Cursor-only state

3. Print mode:
   - `pi --model cursor/gpt-5.5@1m:medium -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@272k --thinking xhigh -p "Say ok only"`
   - `pi --model cursor/gpt-5.5@1m --cursor-fast -p "Say ok only"`
   - confirm requests use selected context, pi thinking, and fast flag state
