#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_DIR="${SMOKE_DIR:-/tmp/pi-cursor-sdk-live-smoke-$(date +%Y%m%dT%H%M%S)}"
SHELL_BIN="${SHELL:-/bin/bash}"

PI_BASE=(
	pi -e "$ROOT"
	--cursor-no-fast
	--model cursor/composer-2.5
)

TMUX_SESSIONS=()

cleanup() {
	local session
	for session in "${TMUX_SESSIONS[@]:-}"; do
		tmux kill-session -t "$session" 2>/dev/null || true
	done
}
trap cleanup EXIT

print_help() {
	cat <<EOF
Partial live smoke runner for pi-cursor-sdk (subset of docs/cursor-live-smoke-checklist.md).

Usage:
  ./scripts/tmux-live-smoke.sh
  SMOKE_DIR=/tmp/pi-cursor-smoke ./scripts/tmux-live-smoke.sh

Environment:
  SMOKE_DIR                     Artifact directory. Defaults to /tmp/pi-cursor-sdk-live-smoke-<timestamp>.
  CURSOR_API_KEY                Required for live Cursor runs.

Prerequisites:
  pi, node, rg, tmux on PATH
  timeout or gtimeout optional; bash process-group kill fallback is used when absent

Coverage:
  - prereq model listing
  - basic non-interactive prompt
  - default ambient settings prompt
  - simple non-interactive math prompt (not visual TUI coverage)
  - RPC steering after native replay tool execution (tmux-isolated)
  - diagnostics safety scan
  - JSONL assistant usage validation

Not covered here:
  visual/interactive TUI observation, bridge MCP, standalone native replay, abort/cancel, packaging, full checklist sections 3-9

Options:
  -h, --help                    Show this help.

Exit codes:
  0  all partial checks passed
  1  prerequisite, smoke, safety, or JSONL validation failure
EOF
}

log() {
	printf '[smoke] %s\n' "$*"
}

fail() {
	printf '[smoke] FAIL: %s\n' "$*" >&2
	exit 1
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

run_with_timeout() {
	local timeout_secs="$1"
	shift
	if command -v timeout >/dev/null 2>&1; then
		timeout "$timeout_secs" "$@"
		return $?
	fi
	if command -v gtimeout >/dev/null 2>&1; then
		gtimeout "$timeout_secs" "$@"
		return $?
	fi

	local restore_monitor=0
	case $- in
		*m*) ;;
		*)
			restore_monitor=1
			set -m
			;;
	esac

	"$@" &
	local pid=$!
	(
		sleep "$timeout_secs"
		kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
		sleep 2
		kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
	) &
	local watcher=$!
	local code=0
	if wait "$pid"; then
		code=0
	else
		code=$?
	fi
	kill "$watcher" 2>/dev/null || true
	wait "$watcher" 2>/dev/null || true
	if (( restore_monitor )); then
		set +m
	fi
	return "$code"
}

run_direct() {
	local name="$1"
	local timeout_secs="$2"
	shift 2
	local stdout="$SMOKE_DIR/${name}.stdout.txt"
	local stderr="$SMOKE_DIR/${name}.stderr.txt"
	rm -f "$stdout" "$stderr"

	if run_with_timeout "$timeout_secs" "$@" >"$stdout" 2>"$stderr"; then
		log "$name PASS"
	else
		local code=$?
		cat "$stderr" >&2 || true
		fail "$name exited $code"
	fi
}

quote_command() {
	local quoted=()
	local arg
	for arg in "$@"; do
		printf -v arg '%q' "$arg"
		quoted+=("$arg")
	done
	printf '%s ' "${quoted[@]}"
}

run_tmux() {
	local name="$1"
	local timeout_secs="$2"
	local dump_stderr_on_fail="$3"
	shift 3
	local session="pi-cursor-smoke-${name}-$$"
	local marker="$SMOKE_DIR/${name}.done"
	local stdout="$SMOKE_DIR/${name}.stdout.txt"
	local stderr="$SMOKE_DIR/${name}.stderr.txt"
	local command
	local script
	command="$(quote_command "$@")"
	rm -f "$marker" "$stdout" "$stderr"

	printf -v script 'cd %q || exit 97
%s> %q 2> %q
code=$?
printf '\''%%s\n'\'' "$code" > %q
' "$ROOT" "$command" "$stdout" "$stderr" "$marker"
	tmux new-session -d -s "$session" -- "$SHELL_BIN" -lc "$script"
	TMUX_SESSIONS+=("$session")

	local elapsed=0
	while [[ ! -f "$marker" ]]; do
		sleep 2
		elapsed=$((elapsed + 2))
		if (( elapsed >= timeout_secs )); then
			tmux capture-pane -pt "$session" >"$SMOKE_DIR/${name}.capture.txt" || true
			tmux kill-session -t "$session" 2>/dev/null || true
			fail "$name timed out after ${timeout_secs}s (see ${name}.capture.txt)"
		fi
	done

	local code
	code="$(cat "$marker")"
	tmux kill-session -t "$session" 2>/dev/null || true
	if [[ "$code" != "0" ]]; then
		if [[ "$dump_stderr_on_fail" == "1" ]]; then
			cat "$stderr" >&2 || true
		fi
		fail "$name exited $code"
	fi
	log "$name PASS"
}

model_listed() {
	local file="$1"
	rg -q "composer-2\\.5" "$file"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	print_help
	exit 0
fi

require_cmd pi
require_cmd node
require_cmd rg
require_cmd tmux

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
	fail "CURSOR_API_KEY is required"
fi

mkdir -p "$SMOKE_DIR"
printf '%s\n' "$SMOKE_DIR" >"$SMOKE_DIR/smoke-dir.txt"

log "SMOKE_DIR=$SMOKE_DIR"
log "partial live smoke: prereq, basic, default-settings, noninteractive-math, steering, diagnostics, jsonl"

if ! PI_CURSOR_SETTING_SOURCES=none "${PI_BASE[@]}" --list-models cursor 2>"$SMOKE_DIR/prereq.stderr.txt" | tee "$SMOKE_DIR/prereq.models.txt" | rg -q "composer-2\\.5"; then
	if ! model_listed "$SMOKE_DIR/prereq.stderr.txt"; then
		fail "cursor/composer-2.5 not listed"
	fi
fi
log "prereq PASS"

run_direct basic 300 \
	env PI_CURSOR_SETTING_SOURCES=none "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/basic" \
	--no-tools \
	-p 'Live smoke. Reply exactly: PI_CURSOR_SMOKE_OK'
rg -q "PI_CURSOR_SMOKE_OK" "$SMOKE_DIR/basic.stdout.txt" || fail "basic missing PI_CURSOR_SMOKE_OK"

run_direct default-settings 300 \
	"${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/default-settings" \
	--no-tools \
	-p 'Default settings smoke. Include PRODUCT=42 in the final answer.'
rg -q "PRODUCT=42" "$SMOKE_DIR/default-settings.stdout.txt" || fail "default-settings missing PRODUCT=42"

run_direct noninteractive-math 300 \
	env PI_CURSOR_SETTING_SOURCES=none "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/noninteractive-math" \
	--no-tools \
	-p 'Noninteractive math smoke. Compute 19 + 23. Reply only with SUM=42.'
rg -q "SUM=42" "$SMOKE_DIR/noninteractive-math.stdout.txt" || fail "noninteractive math missing SUM=42"

run_tmux steering 420 1 \
	env "SMOKE_SESSION_DIR=$SMOKE_DIR/steering" node "$ROOT/scripts/steering-rpc-smoke.mjs"
rg -q '"steerOk":true' "$SMOKE_DIR/steering.stdout.txt" || fail "steering missing steerOk"
rg -q '"steerChain":true' "$SMOKE_DIR/steering.stdout.txt" || fail "steering missing steerChain"
rg -q "already has active run|AgentBusyError" "$SMOKE_DIR/steering.stdout.txt" "$SMOKE_DIR/steering.stderr.txt" && fail "steering hit AgentBusyError" || true

find "$SMOKE_DIR" -type f \( -name '*stderr.txt' -o -name '*capture*.txt' \) -print0 |
	xargs -0 grep -E 'CURSOR_API_KEY|Bearer [A-Za-z0-9._-]+|/cursor-pi-tool-bridge/[^ ]+/mcp|127\.0\.0\.1:[0-9]+/cursor-pi-tool-bridge|apiKey|cookie|session-cookie|secret-token' &&
	fail "diagnostics safety scan found forbidden material" || true
log "diagnostics safety PASS"

node "$ROOT/scripts/validate-smoke-jsonl.mjs" "$SMOKE_DIR"
log "jsonl structural scan PASS"
log "partial live smoke checks passed (see --help for uncovered checklist sections)"
