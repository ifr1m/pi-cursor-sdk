# Critique — customTools Migration Plan (1.0.19)

**Scope:** Plan-level critique of `docs/plans/cursor-sdk-1.0.19-upgrade-customtools-migration-2026-06-15.md`. Four asks only: under-specified seams, contradictions/missing deps, over-planning, order-changing questions. Not a rewrite.

## 1. Top 3 under-specified seams (customTools migration)

1. **Correlation handle for queue-and-await is wrong/unspecified.** The pending registry keys on `piToolCallId` (`src/cursor-pi-tool-bridge-run.ts:144,155,170`), but Item 6 frames `execute(args, { toolCallId })` as if the SDK `toolCallId` is the handle. The synthetic `custom-user-tools` call id is **not** the pi tool-call id. The plan never says where the new `piToolCallId` is minted, how `execute` registers its pending promise against it, or how the emitted live-run `toolCall` carries that id. This is the load-bearing seam and it is the vaguest item. **Fix:** specify "execute mints/obtains a `piToolCallId`, registers a pending entry, emits the live-run `toolCall` with that id, awaits `resolveToolResults` keyed on it."
2. **pi `toolResult` → `SDKCustomToolResult` mapping, esp. error signaling.** Item 6 says "reuse content conversion (`cursor-pi-tool-bridge-mcp.ts:72-96`)," but the MCP resolve path returns `{ content, isError }` (`bridge-run.ts:157-161`); `SDKCustomToolResult` adds `structuredContent` and a different error contract. How `isError`/structured content map (and whether the model sees errors identically) is left to guess.
3. **Display-detection premise is stale, deferred to runtime.** Item 9 says detection keys on server name (`pi_tools` → `custom-user-tools`) and cites `isBridgeMcpToolCall` at `cursor-pi-tool-bridge-mcp.ts:98-114` — but that range is `containsKnownMcpToolName`, which matches on the **tool-name set**, not server name. Since pi tool names survive the migration, the actual change needed may be small or different from what Item 9 describes, and it is punted to "empirically captured event shapes." Under-specified what actually keys suppression today.

## 2. Contradictions / missing dependencies

- **Item 6 is ordered before its own prerequisites.** Item 6's "done when … through the live-run drain with the HTTP server disabled" presumes (a) Item 7 has wired `local.customTools` into `Agent.create`, and (b) the event/routing shape from Item 9's `debug:sdk-events` capture is known. As numbered (6 → 7 → 9) the dependency runs backward. Real order: 5 → 7 (wire) → capture events → 6 (correlation/routing) → 9 (suppression).
- **Item 8 duplicates Open Question 1.** Item 8 "confirms" abort coverage and marks done; OQ1 says a pre-dispatch cancellation hook "may be needed." If the gap is real, that hook is unscoped new work that must precede cutover (Item 10) and possibly Item 6 (execute must be cancellable at enqueue). Item 8 cannot be "done" until OQ1 resolves — they are one unresolved item listed twice.
- **Item 7 commits to a choice OQ2 can invalidate.** Item 7 hard-picks create-time `customTools` to preserve the surface-hash pool key (`cursor-session-agent.ts:150-164`); OQ2 says per-send is required if any flow changes tool surface mid-session. The pool-keying answer gates Item 7's shape but is left open.

## 3. Over-planning (cut / merge / simplify)

- **Item 3 → fold into Item 1.** The SQLite-subpath check is verification ("likely no direct break"); the `overrides.sqlite3` prune is optional cleanup. Make it a checkbox under Item 1, not a standalone work item. Defer the prune if the dependency-tree check is non-trivial.
- **Item 8's 5-path enumeration is discovery detail.** Listing five abort paths with file:lines over-specifies for a plan. Compress to "confirm abort via existing turn/live-run paths; if pre-execution gap, add pre-dispatch hook (OQ1)."
- **Background "SDK delta" trim.** `engines.node`, `exports default`, `enableAgentRetries` bullets map to no work item — drop or one-line them. Keep the ConnectRPC and customTools-gap bullets (load-bearing).

## 4. Questions that change implementation ORDER

1. **Do native customTools calls emit the same pi `toolCall`/MCP events the live-run drain and name-based detection rely on?** If no, the `debug:sdk-events` capture (part of Item 9) must run **before** Item 6's routing/correlation work — flips 9 ahead of 6. This is the primary order-changer.
2. **OQ2 — create-time vs per-send.** If any flow needs mid-session surface change, pool-keying redesign and per-send adapter shape move **before** Items 5–7 (adapter must emit per-send options). Answer decides whether pool work precedes adapter work.
3. **OQ1 — pre-execution cancellation gap.** If the gap exists, the pre-dispatch abort hook must be designed **before** Item 6 (execute registers cancellability at enqueue) and before cutover, not after Item 8's confirmation.
