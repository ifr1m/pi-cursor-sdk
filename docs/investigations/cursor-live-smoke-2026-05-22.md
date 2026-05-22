# Cursor Live Smoke Verification — 2026-05-22

## Scope

Manual live smoke verification for PR #10 on branch `implement/cursor-provider-bridge-feedback`, using the local working tree with:

```bash
pi -e . --cursor-no-fast --model cursor/composer-2.5
```

## Abort/cancel verification

The release-blocking abort/cancel check was re-run with a bridged `pi__bash` command:

```bash
sleep 300 && echo SHOULD_NOT_PRINT
```

Observed before interruption:

- Real `/bin/bash -c sleep 300 && echo SHOULD_NOT_PRINT` child process.
- Real `sleep 300` child process.
- Bridge diagnostics showed the request queued for `pi__bash`.

Observed after Ctrl-C:

- No matching child processes remained.
- `SHOULD_NOT_PRINT` did not appear in stdout.
- Bridge diagnostics showed the request rejected as `cancelled`.
- The tmux session ended.

## Note

This file records dated branch evidence. The evergreen release checklist lives in `docs/cursor-live-smoke-checklist.md`.
