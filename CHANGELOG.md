# Changelog

## Unreleased

### Changed

- Added pi-native `/login` API-key integration for the Cursor provider. Startup discovery now checks pi `--api-key`, the stored `cursor` key in `~/.pi/agent/auth.json`, then `CURSOR_API_KEY`.
- Fallback Cursor models remain available when startup discovery cannot authenticate; once auth is saved, fallback model runs can use the stored key, while `/reload` or restart refreshes the full live Cursor model catalog.
- Improved Cursor activity display by preserving Cursor thinking, streaming Cursor text deltas live, and replaying completed Cursor internal `read`, `bash`, and `ls` activity through pi's native tool rendering path in interactive TTY sessions where possible. Non-interactive runs keep bounded scrubbed transcript output, and raw Cursor call IDs remain omitted.
- Stopped copying Cursor SDK cumulative internal agent/tool/cache token usage into pi usage, preventing false context-overflow and compaction triggers after long Cursor runs.

## 0.1.4 - 2026-05-07

### Fixed

- Restores the GitHub install path to the normal source package layout after the npm-only bundled dependency patch.

## 0.1.3 - 2026-05-07

### Fixed

- Bundled the resolved `@cursor/sdk` runtime dependency tree so npm consumers receive the patched `sqlite3` and `undici` dependency graph used by local verification.

## 0.1.2 - 2026-05-07

### Changed

- Migrated the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`.
- Regenerated the npm lockfile against the current stable dependency graph and cleared moderate audit findings with current transitive overrides.

## 0.1.1 - 2026-05-05

### Fixed

- Use the bundled default context window for newly discovered Cursor models that do not expose a catalog `context` parameter.
- Redact more Cursor SDK error formats, including JSON-style `apiKey`, `token`, `session_id`, and multi-pair cookie values.

### Changed

- Keep local demo-script notes out of the published npm tarball.

## 0.1.0 - 2026-05-04

Initial public release.

### Added

- Cursor provider registration for pi backed by local `@cursor/sdk` agents.
- Cursor model discovery with fallback startup models when discovery is unavailable.
- Context-window model variants such as `cursor/gpt-5.5@1m` and `cursor/gpt-5.5@272k`.
- Pi native thinking-level mapping for Cursor SDK `reasoning`, `effort`, and boolean `thinking` controls when exposed by the SDK.
- Cursor fast-mode controls through `/cursor-fast`, `--cursor-fast`, and `--cursor-no-fast`.
- Image forwarding from the latest user message to Cursor.
- Cursor-side trace output before final text while preserving pi's default footer.
- Local context-window override cache from successful Cursor SDK checkpoint metadata.

### Notes

- All Cursor SDK models are treated as thinking-capable, even when `pi --list-models` shows `thinking=no`; that column only means pi cannot control a thinking parameter for that model.
- Fallback Cursor models are selection-only. Actual Cursor runs require `CURSOR_API_KEY` or pi's `--api-key`.
- Cursor cloud agents, Cursor Max Mode selection, pi tool-schema forwarding, and ambient Cursor setting/rule loading are not supported in this release.
