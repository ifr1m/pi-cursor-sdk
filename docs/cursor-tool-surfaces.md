# Cursor tool surfaces in pi

pi-cursor-sdk runs Cursor models through the local `@cursor/sdk` agent runtime. A single pi session can expose **three related but different** tool namespaces. This page is the user-facing guide; maintainer replay details live in [Cursor native tool replay](./cursor-native-tool-replay.md).

## The three surfaces

| Surface | Who owns it | Callable by Cursor? | What pi shows |
| --- | --- | --- | --- |
| **Cursor SDK host tools** | Cursor local agent | Yes | Native replay cards (`read`, `bash`, …) or neutral Cursor activity. Representative ToolType list: [SDK ToolType replay matrix](./cursor-native-tool-replay.md#sdk-tooltype-replay-matrix). |
| **Configured Cursor MCP** | Cursor settings / `~/.cursor/mcp.json` | Yes (when loaded) | Neutral **Cursor MCP** activity cards on replay |
| **Pi bridge (`pi__*`)** | pi-cursor-sdk loopback MCP | Yes, when exposed | Real pi tool names (`cursor_ask_question`, extension tools, …) |

**Not callable:** `cursor-replay-*` IDs in JSONL, pi history tool names used only for display, and transcript labels. Cursor must call exposed `pi__*` MCP names for bridged pi tools, not the pi card name.

## Discoverability

- **MCP `listTools`** (and pi's MCP catalog when present) lists **MCP servers only** — for example `pi_tools` with `pi__cursor_ask_question`. It does **not** enumerate Cursor SDK host tools such as `Read` or `Shell`.
- **Bootstrap prompts** include a compact **callable tool surfaces** block (disable with `PI_CURSOR_TOOL_MANIFEST=0`) listing host-tool categories, bridge `pi__*` names for the current run, and a reminder that configured Cursor MCP servers appear at runtime via `listTools`.
- **Incremental prompts** omit the full boundary block but keep a short tail guard; the session agent retains prior bootstrap context.

## Pi bridge vs Cursor native

Default behavior:

- Cursor host tools handle files, shell, grep, edits, tasks, and Cursor-native MCP/plugins.
- The pi bridge exposes **active pi tools** as `pi__*` MCP names when `PI_CURSOR_PI_TOOL_BRIDGE` is enabled (default on).
- Overlapping pi builtins (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`) are **hidden** from the bridge unless `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1`.

`pi-cursor-sdk` always registers `cursor_ask_question` for Cursor models when the bridge is on; Cursor sees `pi__cursor_ask_question`.

```bash
# Disable pi bridge entirely
PI_CURSOR_PI_TOOL_BRIDGE=0 pi --model cursor/composer-2.5

# Expose overlapping pi builtins through the bridge
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 pi --model cursor/composer-2.5

# Disable bootstrap tool manifest
PI_CURSOR_TOOL_MANIFEST=0 pi --model cursor/composer-2.5
```

## Cursor settings vs pi toggles

Disabling or removing an MCP server **only in pi** does not remove Cursor ambient MCP loaded from Cursor config.

| Control | Effect |
| --- | --- |
| `PI_CURSOR_SETTING_SOURCES=all` (default) | Loads user/project Cursor MCP, plugins, rules (`~/.cursor/mcp.json`, etc.) |
| `PI_CURSOR_SETTING_SOURCES=none` | Disables ambient Cursor setting sources for local agents |
| `PI_CURSOR_SETTING_SOURCES=project,plugins` | Narrows which layers load |
| Empty or edited `~/.cursor/mcp.json` | Changes which user MCP servers Cursor connects to |

To reproduce a **minimal** surface (pi-cursor-sdk + Cursor host only), use extension-only install, empty user MCP config, and `PI_CURSOR_SETTING_SOURCES=none` when you do not need Cursor rules/MCP from disk.

## JSONL ID patterns (debugging)

| ID prefix | Meaning |
| --- | --- |
| `cursor-replay-*` | Display-only replay of Cursor SDK activity |
| `cursor-pi-bridge-run-*` | Live pi execution via bridge |

Example mistake: treating `cursor-replay-…` as a tool to invoke. Replay never re-runs work.

## Related docs

- [README — Cursor provider tool contract](../README.md#cursor-provider-tool-contract)
- [Cursor native tool replay](./cursor-native-tool-replay.md)
- [Cursor model UX spec](./cursor-model-ux-spec.md)
