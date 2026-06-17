# Cursor SDK 1.0.19 Upgrade + customTools Migration: Plan

## Goal

Upgrade `@cursor/sdk` from 1.0.18 to 1.0.19 (compat-clean), then migrate pi's tool bridge from a per-run loopback **HTTP MCP server** to the SDK's native in-process **`local.customTools`**, preserving the existing live-run routing invariant (Cursor tool call → real pi `toolCall` → matching pi `toolResult` → resolve), abort/cancellation, diagnostics, and display behavior. Verification bar: full matrix (typecheck + unit + live smoke + platform-smoke across macOS/ubuntu/windows-native).

## Background

### SDK delta (1.0.18 → 1.0.19)
New version `@cursor/sdk@1.0.19` published 2026-06-15. The repo already has audited 1.0.19 types under `.debug/cursor-sdk-audit-1019/1.0.19/`.

- **ConnectRPC transport seam** — the SDK root dependency list dropped `@connectrpc/connect-node` and added `@connectrpc/connect-web`, but `dist/esm/transport.d.ts` says the Node path still dynamically imports `@connectrpc/connect-node`; `connect-web` is the SDK's Bun/Deno fetch transport. pi runs this provider in Node, so Phase A should add `@connectrpc/connect-node@1.7.0` as a direct runtime dependency and keep the existing Node stack classification/suppression logic. Do **not** add speculative `connect-web` production matching unless a supported Node pi run actually surfaces `connect-web` stacks.
- **SQLite export moved** to subpath `@cursor/sdk/sqlite`; `sqlite3` dropped from SDK root deps. The extension does **not** import `SqliteLocalAgentStore` in `src/` (it uses `createAgentPlatform().checkpointStore` at `src/cursor-provider-turn-finalize.ts:14-25`), so likely no direct break. Phase A removes the pre-upgrade `overrides.sqlite3: 6.0.1` only after a dependency-tree check proves it dead. Verify `createAgentPlatform` checkpoint reads still work post-upgrade.
- **Low-impact deltas (no work item):** `engines.node` `>=18`→`>=22.13` (already satisfied), `exports` now include `default`, native platform packages bump to 1.0.19, new `LocalAgentOptions.enableAgentRetries?` flag.

### Native customTools API (available since 1.0.18)
- `LocalAgentOptions.customTools?: Record<string, SDKCustomTool>` (`node_modules/@cursor/sdk/dist/esm/options.d.ts:139`) at `Agent.create`, and `LocalSendOptions.customTools` at send (replaces create-time tools for that run). Lives nested under `local`, not top-level beside `mcpServers`.
- `SDKCustomTool = { description?: string; inputSchema?: Record<string,SDKJsonValue>; execute(args, ctx) => SDKCustomToolResult | Promise<...> }`. Map **key is the tool name** (no `name` field). `inputSchema` is plain JSON Schema. Result can be string / JSON / `{ content, isError?, structuredContent? }`.
- The SDK registers them as a synthetic MCP server named **`custom-user-tools`**; the model invokes them through the same `GetMcpTools`/`CallMcpTool` path. Custom tools reach subagents.
- **Gaps vs current bridge:** `SDKCustomToolContext` exposes only `toolCallId` — **no abort signal**. Local-only (cloud throws). No max-tool / naming-rule documented beyond key-as-name.

### Current bridge architecture (what migration must preserve)
Per-run loopback HTTP MCP server (`StreamableHTTPServerTransport`), server name `pi_tools`, started in `src/cursor-pi-tool-bridge-run.ts:93-98, 231-250`; wired via `mcpServers` into `Agent.create` at `src/cursor-session-agent.ts:371-377`. It does **not** call pi `execute()` directly — it queues a request, emits a real pi `toolCall` through the live-run drain (`src/cursor-provider-live-run-drain.ts:210-235`), waits for the matching `toolResult`, and resolves the MCP pending promise (`src/cursor-pi-tool-bridge-run.ts:153-165`). Cross-cutting concerns it owns: env gates, snapshot/surface-hash that keys the agent pool (`src/cursor-session-agent.ts:150-164`), abort/cancellation (`src/cursor-pi-tool-bridge-abort.ts`, MCP `extra.signal`), scrubbed diagnostics, MCP timeout override (`src/cursor-mcp-timeout-override.ts`), and bridge-owned display suppression.

### Prior art / process
- **Decision reversal:** `docs/plans/cursor-provider-bridge-feedback-2026-05-21.md:194-200` records a non-goal "no direct calls to pi tool `execute()` from the bridge" and a stance to **keep the MCP bridge**. This plan overrides "keep the MCP bridge" but the live-run routing invariant (no direct `execute()`) must be preserved — `customTools.execute` should still queue into the live run, not call pi tools directly.
- SDK bumps historically touch package/lock, `src/cursor-fallback-models.generated.ts` (via `npm run refresh:cursor-snapshots`), provider/session/bridge adapters, package-metadata tests, docs, and CHANGELOG (`CHANGELOG.md` 1.0.14–1.0.18 entries). Canonical gate: `npm run smoke:platform:all` (`AGENTS.md:147,160-163`).
- CHANGELOG convention: `## Unreleased` then `## x.y.z - YYYY-MM-DD`, Keep-a-Changelog buckets (`Added`/`Changed`/`Fixed`/`Maintainer`); SDK bumps recorded under `### Changed` with exact version.

## Approach

Two phases, shipped as two releases, to isolate dependency risk from architectural risk.

**Phase A — compat-clean 1.0.19 bump.** Pure dependency upgrade: bump the SDK pin, add the SDK's Node-only dynamic `@connectrpc/connect-node` transport dependency directly, confirm the checkpoint path still resolves under the SQLite subpath move, refresh model snapshots only if the catalog changed. No behavior change. Ship and validate before touching the bridge.

**Phase B — native customTools migration.** Do not start wiring until OQ1/OQ2 are answered. Add a customTools adapter selected by an env flag, keeping the HTTP MCP bridge as a fallback for one migration window (owner + removal date recorded). The `execute` callback **reuses the existing queue-and-await contract** — it enqueues a `CursorPiBridgeToolRequest` and awaits the matching pi `toolResult`, never calling pi `execute()` directly, preserving the documented live-run routing invariant. Keep agent creation thin by extracting the branch into `resolveCursorPiToolSurface()` (returning either `{ customTools }` or `{ mcpServers, bridgeRun }`) instead of growing inline `if (flag)` logic in `src/cursor-session-agent.ts`. Flip the default to customTools only after the full gate (unit + live + platform matrix) passes; remove the HTTP path at the end of the window. The env flag exists because the migration loses the MCP `extra.signal` abort path and changes the synthetic server identity (`pi_tools` → `custom-user-tools`), both of which need live validation before becoming the only path.

## Work Items

### Phase A — Compat bump

1. **Bump `@cursor/sdk` 1.0.18 → 1.0.19.** Update `package.json:111-113` and `package-lock.json` (real install, not hand-edit). Run `npm run refresh:cursor-snapshots`; commit `src/cursor-fallback-models.generated.ts` / `src/bundled-context-windows.ts` only if the catalog changed. Also verify `createAgentPlatform().checkpointStore.loadLatest` (`src/cursor-provider-turn-finalize.ts:14-25`) still resolves under the SQLite subpath move, and prune `overrides.sqlite3` from `package.json` only if a dependency-tree check proves it dead. *Done when:* `npm install` clean, `npm run typecheck` green, `test/cursor-sdk-lazy-import.test.ts` passes.
2. **Preserve Node ConnectRPC provenance with a direct Node transport pin.** Add `@connectrpc/connect-node@1.7.0` because SDK 1.0.19 still dynamically imports it in Node, leave `src/cursor-provider-errors.ts` and `src/cursor-sdk-process-error-guard.ts` on their existing `connect-node` stack contract, and document why `connect-web` is out of scope for supported Node pi runs. *Done when:* package metadata tests assert the SDK pin, the direct Node transport pin, installed `connect-node`/`connect-web` version alignment, and the removed sqlite override; live pi runs no longer fail with a missing `@connectrpc/connect-node` package.
3. **Metadata, changelog, Phase A gate.** Update `test/package-metadata.test.ts` if it asserts SDK version/engines/exports; add a `### Changed` CHANGELOG entry (1.0.19 + direct Node ConnectRPC transport pin). *Done when:* the **Phase A validation gate** passes.

### Phase B — customTools migration

Ordered to respect the real dependency chain (wire → capture events → correlate → suppress); see Open Questions for the two decisions that gate this order.

4. **Build the customTools adapter.** New module converting the bridge snapshot to `Record<string, SDKCustomTool>`: map key = pi tool name, `description` from `src/cursor-bridge-contract.ts`, `inputSchema` from `normalizeMcpInputSchema` (`src/cursor-pi-tool-bridge-mcp.ts:8-12`). Reuse `buildCursorPiToolBridgeSnapshot()` (`src/cursor-pi-tool-bridge-snapshot.ts`) as the single capability source. *Done when:* unit test maps a sample tool surface to valid `SDKCustomTool` entries.
5. **Select + wire the implementation at agent creation.** Resolve OQ2 (create-time vs per-send) first — it sets the adapter's output shape and is a hard gate before coding this item. Add `resolveCursorPiToolSurface()` as the single agent-creation seam, returning either `local.customTools` options or the existing HTTP MCP `mcpServers`/`bridgeRun` pieces so `src/cursor-session-agent.ts` does not gain inline dual-path branching. Default: create-time `local.customTools` added to the `Agent.create` assembly (`src/cursor-session-agent.ts:371-377`, nested under `local`), gated by an env flag choosing customTools vs the HTTP bridge run, preserving the surface-hash pool key (`src/cursor-session-agent.ts:150-164`). *Done when:* `test/cursor-provider-bridge-session.test.ts` covers both flag states and pool reuse.
6. **Capture native customTools event shapes.** Run `npm run debug:sdk-events` against a customTools call and confirm whether it emits the same pi `toolCall`/MCP events the live-run drain and name-based detection rely on. This empirical answer gates the correlation and suppression work below. *Done when:* captured event shapes are recorded in the plan/investigation notes.
7. **Wire `execute` to the queue-and-await contract.** Start only after Item 6 captures event shapes and OQ1 confirms the abort/cancellation design. The correlation handle is **`piToolCallId`**, not the SDK `toolCallId` from `execute`'s context. `execute(args, ctx)` mints/obtains a `piToolCallId`, registers a pending entry keyed on it (`src/cursor-pi-tool-bridge-run.ts:144,155,170`), emits the live-run `toolCall` carrying that id, and awaits `resolveToolResults` keyed on it — never calling pi `execute()` directly. Map the pi `toolResult` to `SDKCustomToolResult`, defining how `isError`/`structuredContent` map vs the existing `{ content, isError }` MCP path (`src/cursor-pi-tool-bridge-run.ts:157-161`). *Done when:* a provider test drives a tool call end-to-end through the live-run drain with the HTTP server disabled, including an error result.
8. **Adjust display suppression + timeout scope.** Bridge-call detection keys on the **tool-name set** (`containsKnownMcpToolName`, `src/cursor-pi-tool-bridge-mcp.ts:98-114`), not the server name — and pi tool names survive the migration, so the change here is likely small; pin down exactly what keys suppression today using the Item 6 capture, then adjust minimally. Scope `src/cursor-mcp-timeout-override.ts` to external MCP only (in-process customTools need no bridge-tool timeout patch). Adapt scrubbed diagnostics (`src/cursor-pi-tool-bridge-diagnostics.ts`). *Done when:* replay/display tests pass; bridge-owned calls stay hidden.
9. **Confirm/repair abort coverage (resolves OQ1 before execute wiring).** `SDKCustomToolContext` has no `AbortSignal`. Confirm cancellation via existing turn/live-run paths (`src/cursor-provider-turn-send.ts`, `src/cursor-live-run-coordinator.ts:462-485`, `bridgeRun.cancel()`, `src/cursor-pi-tool-bridge-abort.ts`) before Item 7's enqueue path is implemented. If Item 6/live smoke reveals a pre-execution cancellation gap, design and add the pre-dispatch cancellation hook before any `execute` cutover. *Done when:* OQ1 is closed in the plan, the execute path includes the chosen cancellation behavior, and long-running-abort live smoke shows pending calls rejected with no leaked processes.
10. **Cut over + clean up.** Flip the default to customTools after the gate passes; revisit `test/cursor-sdk-lazy-import.test.ts` if HTTP/MCP runtime deps are removed; record an owner + removal date for the HTTP fallback; add a `### Changed` CHANGELOG entry. *Done when:* the full **Phase B validation gate** passes.

## Verification

Both phases end on the canonical gate (`AGENTS.md:147,160-163`):
- `npm run typecheck` · `npm test` · `npm run smoke:live` (or `scripts/tmux-live-smoke.sh`) · `npm run smoke:platform:all` (macOS/ubuntu/windows-native).
- Auth-unavailable means **blocked**, not done. Phase B additionally requires live evidence of: bridged tool success, abort/cancel cleanup, and bridge-owned display suppression under the customTools path.

## Open Questions
- **OQ2 — create-time vs per-send customTools (hard gate for Item 5 and all later wiring).** Plan defaults to create-time to preserve the surface-hash pool key. If any flow must change the active tool surface mid-session without a new pooled agent, per-send `LocalSendOptions.customTools` is required and the adapter must emit per-send options instead. Confirm before wiring.
- **OQ1 — pre-execution abort gap (hard gate for Items 7–9).** Whether existing turn/live-run paths fully replace the lost MCP `extra.signal` is empirical. The Item 6 event capture and abort live smoke answer it; if a gap exists, the pre-dispatch hook must be designed before `execute` enqueue wiring, not after.

## References
- npm: https://www.npmjs.com/package/@cursor/sdk · registry: https://registry.npmjs.org/@cursor/sdk
- Cursor SDK docs: https://cursor.com/docs/sdk/typescript · June changelog: https://cursor.com/changelog/sdk-updates-jun-2026
- In-repo: `.debug/cursor-sdk-audit-1019/1.0.19/` (audited types), `.debug/cursor-sdk-audit/dts-diff-summary.txt`, `node_modules/@cursor/sdk/dist/esm/{options,agent,custom-tools}.d.ts`
