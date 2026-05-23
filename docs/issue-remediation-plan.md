# Open Issue Remediation Plan

Captured 2026-05-23 from GitHub issues on `fitchmultz/pi-cursor-sdk`.

## Open issues inventory

| Issue | Title | Severity | Status in this PR |
|-------|-------|----------|-------------------|
| #17 | Weird prints (ripgrep / ignore mapping SDK noise) | User-facing TUI corruption | Fixed |
| #19 | Consolidate edit diff fallback | Maintainability | Fixed |
| #20 | Stale pi 0.75.3 in investigation doc | Docs hygiene | Fixed |
| #21 | Decompose 1k+ line modules | Structural debt | Fixed |

Closed issues (#1, #2, #13, #15) were already remediated on `main`; no action required.

## Remediation approach

### #17 — Ripgrep / ignore-mapping TUI noise

**Root cause:** `@cursor/sdk` emits stderr/console errors when ripgrep is not configured (`Error initializing ignore mapping for .gitignore`, `Ripgrep path not configured`). These lines were not covered by the existing integrator-noise filter (same class as #13 `[hooks]` noise).

**Fix:** Extend `src/cursor-sdk-output-filter.ts` startup-noise patterns; keep filter installed for the full provider turn.

**Follow-up (not blocking):** `@cursor/sdk` does not export `configureRipgrepPath()`; if SDK adds a public ripgrep bootstrap API, wire absolute `rg` path resolution at extension startup.

### #19 — Canonical edit diff resolver

**Fix:** Add `src/cursor-edit-diff.ts` with ordered fallback `diffString → diff → unifiedDiff → patch`. Use from `cursor-native-tool-display.ts` and `cursor-tool-transcript.ts`. Unit tests in `test/cursor-edit-diff.test.ts`.

### #20 — Investigation doc version drift

**Fix:** Mark `docs/investigations/token-tracking-session-2026-05-21.md` as a point-in-time record (2026-05-21, pi 0.75.3) and note current dev baseline 0.75.5.

### #21 — Module decomposition

Split by ownership boundary (behavior-preserving moves):

| Before | After |
|--------|-------|
| `cursor-provider.ts` (~1276) | `cursor-provider.ts` (~788) + `cursor-provider-live-run-drain.ts` (~449) + `cursor-sdk-output-filter.ts` (~78) |
| `cursor-tool-transcript.ts` (~1264) | orchestrator (~463) + `cursor-transcript-utils.ts` (~261) + `cursor-transcript-tool-formatters.ts` (~636) |
| `cursor-pi-tool-bridge.ts` (~1174) | main (~902) + `cursor-pi-tool-bridge-diagnostics.ts` (~185) + `cursor-pi-tool-bridge-mcp.ts` (~121) |
| `test/cursor-provider.test.ts` (~5151) | scenario-focused test files + `test/helpers/cursor-provider-harness.ts` |

## Validation

- `npm test`
- `npm run typecheck`
- `npm pack --dry-run`

Live smoke (`docs/cursor-live-smoke-checklist.md`) remains recommended before release; not required for this maintainability/docs PR.

## Issue closure mapping

This PR closes #17, #19, #20, and #21 when merged.
