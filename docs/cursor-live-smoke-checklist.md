# Cursor Live Smoke Checklist

## Purpose

Use this manual checklist before releasing Cursor provider/runtime changes. Unit tests and mocks are necessary, but they are not enough for this extension. Always assume every runtime surface is in scope. A release is not ready until every live check below has been observed with `cursor/composer-2.5` through the local working tree.

## Release rule

- Run from a clean working tree except for the intended branch diff.
- Use the local extension under test: `pi -e . --cursor-no-fast --model cursor/composer-2.5`.
- Use a temporary `--session-dir` for every run.
- Do not paste or commit Cursor API keys, raw session contents with secrets, endpoint URLs, or local private paths.
- If a check fails, stop and fix or explicitly mark the release blocked. Do not ship with "optional," "deferred," "mostly," or "probably" checks outstanding.
- Do not narrow the smoke scope to the apparent code diff. Treat provider reality, TUI behavior, bridge behavior, replay behavior, diagnostics safety, abort/cancel cleanup, usage accounting, packaging, and cleanup as in scope for every Cursor provider/runtime release.
- A check is passed only when the visible TUI/output, stderr diagnostics, and persisted JSONL agree with the expected behavior.

## Prerequisites

```bash
export SMOKE_DIR="/tmp/pi-cursor-sdk-live-smoke-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$SMOKE_DIR"
pi -e . --list-models cursor
```

Pass criteria:

- `cursor/composer-2.5` appears in the model list.
- No Cursor key or auth token is printed.
- If `CURSOR_API_KEY` is unavailable and `/login` is not configured, stop and report the live smoke as blocked.

## 1. Basic provider reality check

```bash
PI_CURSOR_SETTING_SOURCES=none \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/basic" \
  --no-tools \
  -p 'Live smoke. Reply exactly: PI_CURSOR_SMOKE_OK' \
  > "$SMOKE_DIR/basic.stdout.txt" \
  2> "$SMOKE_DIR/basic.stderr.txt"
```

Pass criteria:

- Exit code is `0`.
- stdout contains `PI_CURSOR_SMOKE_OK`.
- stderr is empty or contains only expected non-secret diagnostics for the specific test.
- The persisted JSONL has exactly one assistant message with non-negative usage fields and `cacheRead/cacheWrite` equal to `0`.

## 2. Default setting-source startup noise check

```bash
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/default-settings" \
  --no-tools \
  -p 'Default settings smoke. Include PRODUCT=42 in the final answer.' \
  > "$SMOKE_DIR/default-settings.stdout.txt" \
  2> "$SMOKE_DIR/default-settings.stderr.txt"
```

Pass criteria:

- Exit code is `0`.
- stdout includes `PRODUCT=42`.
- stderr is empty.
- No Cursor SDK settings/skills startup logs corrupt stdout or the TUI.

## 3. TUI observation check

Run a real interactive session under tmux:

```bash
SESSION="pi-cursor-sdk-smoke-$(date +%s)"
tmux new-session -d -s "$SESSION" -x 120 -y 40 -- zsh -lc \
  "cd '$PWD' && PI_CURSOR_SETTING_SOURCES=none pi -e . --cursor-no-fast --model cursor/composer-2.5 --session-dir '$SMOKE_DIR/tui' --no-tools 'TUI smoke. Compute 19 + 23. Reply only with SUM=<number>.'"
```

Observe with `tmux capture-pane -pt "$SESSION"` or attach manually.

Pass criteria:

- Footer shows `(cursor) composer-2.5`. With `--cursor-no-fast`, Cursor fast mode is off and the Cursor extension status should not show `cursor fast`; ignore unrelated status text from other extensions.
- Assistant answer appears correctly.
- `/session` shows one user and one assistant message for the simple run.
- Persisted JSONL has one assistant message. If the screen appears duplicated, inspect JSONL before deciding whether it is a rendering bug.
- Kill the tmux session after the check and verify no smoke tmux sessions remain.

## 4. Bridge multi-tool success and failure

```bash
PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 \
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/bridge" \
  -p 'Bridge smoke. Do exactly two tool calls before answering: first call pi__read on ./package.json; second call pi__read on ./definitely-missing-pi-cursor-sdk-smoke-file.txt. Then answer: OK_NAME=<package name>; MISSING_RESULT=<error or success>. Do not use shell.' \
  > "$SMOKE_DIR/bridge.stdout.txt" \
  2> "$SMOKE_DIR/bridge.stderr.txt"
```

Pass criteria:

- stdout includes `OK_NAME=pi-cursor-sdk`.
- Diagnostics include `run_created`, `tools_exposed`, two `request_queued`, two `request_resolved`, and `run_disposed`.
- The missing-file request has `isError: true`.
- Persisted JSONL contains real pi tool calls named `read`, matching `toolResult` messages, and final assistant output.
- Later assistant usage counts consumed tool-result input; no assistant usage has negative values or nonzero cache fields.

## 5. Native replay cards without the pi bridge

```bash
PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_PI_TOOL_BRIDGE=0 \
PI_CURSOR_NATIVE_TOOL_DISPLAY=1 \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/native-replay" \
  -p 'Native replay smoke. Use your Cursor file-reading capability to read ./README.md, then answer README_SEEN=yes if it contains pi-cursor-sdk.' \
  > "$SMOKE_DIR/native-replay.stdout.txt" \
  2> "$SMOKE_DIR/native-replay.stderr.txt"
```

Pass criteria:

- stdout includes `README_SEEN=yes`.
- Persisted JSONL shows an assistant `toolUse` turn with a replayed `read` tool call, a pi `read` `toolResult`, and a final assistant turn.
- Native replay is display-only: it must not re-run Cursor-side mutations or create duplicate pi mutations.

## 6. Diagnostics safety contract

Bridge diagnostics are scrubbed operational logs, not anonymous telemetry.

Allowed fields:

- event name
- run-safe correlation IDs that are not endpoint path components
- bridge/pi tool call IDs derived from the run-safe ID
- hashed Cursor MCP call correlation IDs of the form `cursor-mcp-call-<8 hex chars>`
- exposed pi/MCP tool name pairs
- pending/queued/cancelled counts
- success/error booleans
- rejection kind

Forbidden fields:

- Cursor API keys or auth headers
- bearer tokens, cookies, sessions, or raw credential material
- endpoint URLs, endpoint path components, endpoint tokens, or loopback URLs
- raw tool args
- raw tool results
- stdout/stderr payloads
- file contents
- Cursor settings/skills startup output
- local private session paths in tracked docs

Run a forbidden-material scan over smoke stderr/captures:

```bash
find "$SMOKE_DIR" -type f \( -name '*stderr.txt' -o -name 'capture*.txt' \) -print0 |
  xargs -0 grep -E 'CURSOR_API_KEY|Bearer [A-Za-z0-9._-]+|/cursor-pi-tool-bridge/[^ ]+/mcp|127\.0\.0\.1:[0-9]+/cursor-pi-tool-bridge|apiKey|cookie|session-cookie|secret-token'
```

Pass criteria:

- The grep returns no matches except deliberately planted test strings that are asserted not to appear in serialized diagnostics.
- If tool names themselves are considered sensitive for a release target, do not enable `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` for shared logs. The diagnostics contract intentionally allows tool names.

## 7. Long-running bridge and abort/cancel

This check is release-blocking for every Cursor provider/runtime release.

Use a harmless long-running command and interrupt it after the bridge request is queued:

```bash
PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 \
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 \
pi -e . --cursor-no-fast --model cursor/composer-2.5 \
  --session-dir "$SMOKE_DIR/abort" \
  -p 'Abort smoke. Call pi__bash with command: sleep 30 && echo SHOULD_NOT_PRINT. Do not answer until the tool completes.'
```

Pass criteria:

- Interrupting the run does not leave `sleep 30`, `SHOULD_NOT_PRINT`, `pi`, or bridge-related child processes running.
- Diagnostics either show clean cancellation/disposal or the process exits cleanly without orphaning children.
- Persisted JSONL does not contain a false successful final answer.

## 8. Final structural session scan

After all live runs, scan JSONL structurally instead of reading raw content into a report:

```bash
node <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.env.SMOKE_DIR;
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.jsonl')) files.push(p);
  }
}
walk(root);
let failures = 0;
for (const file of files.sort()) {
  const records = fs.readFileSync(file, 'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse);
  const messages = records.filter((record) => record.type === 'message').map((record) => record.message);
  const assistants = messages.filter((message) => message.role === 'assistant');
  const usage = assistants.map((message) => message.usage).filter(Boolean);
  const badUsage = usage.filter((u) =>
    typeof u.input !== 'number' || u.input < 0 ||
    typeof u.output !== 'number' || u.output < 0 ||
    typeof u.totalTokens !== 'number' || u.totalTokens < 0 ||
    u.cacheRead !== 0 || u.cacheWrite !== 0
  );
  if (usage.length !== assistants.length || badUsage.length > 0) failures += 1;
  console.log(JSON.stringify({ file: path.relative(root, file), assistantCount: assistants.length, usageCount: usage.length, badUsageCount: badUsage.length }));
}
process.exit(failures === 0 ? 0 : 1);
NODE
```

Pass criteria:

- Every assistant message has valid usage.
- Cache fields remain `0`.
- Tool-heavy runs show nonzero output for visible assistant/tool-call activity.
- Split runs count consumed tool-result input once on the following assistant turn.

## 9. Standard local gates

```bash
git diff --check
npm test
npm run typecheck
npm pack --dry-run
```

Pass criteria:

- All commands exit `0`.
- `npm pack --dry-run` includes all new runtime source files and excludes local smoke artifacts, sessions, package tarballs, `.env*`, `.pi/`, `dist/`, and `coverage/`.

## 10. Cleanup

```bash
tmux list-sessions | grep 'pi-cursor-sdk-smoke' || true
rm -rf "$SMOKE_DIR"
```

Pass criteria:

- No smoke tmux sessions remain.
- No smoke child processes remain.
- No smoke artifacts are committed.

## Coverage gaps this checklist makes explicit

Everything in this section is in scope for Cursor provider/runtime releases. These are not accepted as "done" unless the matching live check passes:

- Long-running bridged tool abort/cancel cleanup.
- Native replay cards beyond read, especially shell/edit/write cards, when those renderers change.
- Bridge question UI when `cursor_ask_question` changes.
- MCP timeout override behavior when timeout code changes.
- Ambient Cursor setting-source behavior when startup filtering or local Cursor settings handling changes.
- Model discovery aliases/context variants when model-discovery code or Cursor SDK versions change.

If any surface has no adequate live check, add that check before release instead of assuming mocks cover reality.
