#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/cursor-smoke-shell.sh
. "$ROOT/scripts/lib/cursor-smoke-shell.sh"

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
  - basic non-interactive prompt (retry-empty-output; strict output assertion)
  - default ambient settings prompt (strict; no retry)
  - simple non-interactive math prompt (strict; no retry)
  - interactive TUI math/footer polling with cleanup
  - RPC steering after native replay tool execution (tmux-isolated)
  - diagnostics safety scan
  - JSONL assistant usage validation

Not covered here:
  bridge MCP, standalone native replay, abort/cancel, packaging, full checklist sections 4-9

Options:
  -h, --help                    Show this help.

Exit codes:
  0  all partial checks passed
  1  prerequisite, smoke, safety, or JSONL validation failure
EOF
}

log() { smoke_log "$@"; }
fail() { smoke_fail "$@"; }
require_cmd() { smoke_require_cmd "$@"; }
run_with_timeout() { smoke_run_with_timeout "$@"; }

tail_file() {
	local file="$1"
	local lines="${2:-80}"
	if [[ -s "$file" ]]; then
		tail -n "$lines" "$file" || true
	else
		printf '<empty: %s>\n' "$file"
	fi
}

assert_file_contains() {
	local name="$1"
	local file="$2"
	local pattern="$3"
	local label="$4"
	if ! rg -q "$pattern" "$file"; then
		printf '[smoke] %s missing %s in %s\n' "$name" "$label" "$file" >&2
		printf '[smoke] %s transcript tail:\n' "$name" >&2
		tail_file "$file" 120 >&2
		fail "$name missing ${label}"
	fi
}

is_empty_retryable_exit() {
	local code="$1"
	local stdout="$2"
	[[ ! -s "$stdout" && ( "$code" == "0" || "$code" == "124" || "$code" == "137" || "$code" == "143" ) ]]
}

run_direct_attempt() {
	local name="$1"
	local timeout_secs="$2"
	local stdout="$3"
	local stderr="$4"
	shift 4
	rm -f "$stdout" "$stderr"

	if run_with_timeout "$timeout_secs" "$@" >"$stdout" 2>"$stderr"; then
		return 0
	fi
	return $?
}

run_direct_fail() {
	local name="$1"
	local code="$2"
	local stdout="$3"
	local stderr="$4"
	local label="$5"
	if [[ "$code" != "0" ]]; then
		cat "$stderr" >&2 || true
		fail "$name exited $code"
	fi
	printf '[smoke] %s missing %s in %s\n' "$name" "$label" "$stdout" >&2
	printf '[smoke] %s stdout tail:\n' "$name" >&2
	tail_file "$stdout" 120 >&2
	printf '[smoke] %s stderr tail:\n' "$name" >&2
	tail_file "$stderr" 80 >&2
	fail "$name missing ${label}"
}

run_direct() {
	local name="$1"
	local timeout_secs="$2"
	local policy="$3"
	local expected_pattern="$4"
	local expected_label="$5"
	shift 5
	local stdout="$SMOKE_DIR/${name}.stdout.txt"
	local stderr="$SMOKE_DIR/${name}.stderr.txt"
	local code=0

	if run_direct_attempt "$name" "$timeout_secs" "$stdout" "$stderr" "$@"; then
		code=0
	else
		code=$?
	fi
	if [[ "$code" == "0" ]] && rg -q "$expected_pattern" "$stdout"; then
		log "$name PASS"
		return 0
	fi

	case "$policy" in
		strict)
			run_direct_fail "$name" "$code" "$stdout" "$stderr" "$expected_label"
			;;
		retry-empty-output)
			local first_stdout="$SMOKE_DIR/${name}.attempt1.stdout.txt"
			local first_stderr="$SMOKE_DIR/${name}.attempt1.stderr.txt"
			if ! is_empty_retryable_exit "$code" "$stdout"; then
				run_direct_fail "$name" "$code" "$stdout" "$stderr" "$expected_label"
			fi
			mv "$stdout" "$first_stdout" 2>/dev/null || true
			mv "$stderr" "$first_stderr" 2>/dev/null || true
			log "$name retrying once after empty output with exit $code"
			if run_direct_attempt "$name" "$timeout_secs" "$stdout" "$stderr" "$@"; then
				local retry_code=0
				if rg -q "$expected_pattern" "$stdout"; then
					log "$name PASS after retry (first exit $code; first stderr: $first_stderr)"
					return 0
				fi
				printf '[smoke] %s retry exited %s but still missed %s\n' "$name" "$retry_code" "$expected_label" >&2
			else
				local retry_code=$?
				printf '[smoke] %s retry exited %s after first empty output exit %s\n' "$name" "$retry_code" "$code" >&2
			fi
			printf '[smoke] %s first stdout tail:\n' "$name" >&2
			tail_file "$first_stdout" 80 >&2
			printf '[smoke] %s first stderr tail:\n' "$name" >&2
			tail_file "$first_stderr" 80 >&2
			printf '[smoke] %s retry stdout tail:\n' "$name" >&2
			tail_file "$stdout" 120 >&2
			printf '[smoke] %s retry stderr tail:\n' "$name" >&2
			tail_file "$stderr" 80 >&2
			fail "$name retry failed after empty output"
			;;
		*)
			fail "$name unknown run_direct policy: $policy (expected strict or retry-empty-output)"
			;;
	esac
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

run_tui_math_footer_poll() {
	local name="$1"
	local timeout_secs="$2"
	shift 2
	local session="pi-cursor-smoke-${name}-$$"
	local capture="$SMOKE_DIR/${name}.capture.txt"
	local script
	local command
	command="$(quote_command "$@")"
	rm -f "$capture"

	printf -v script 'cd %q || exit 97
exec %s
' "$ROOT" "$command"
	tmux new-session -d -s "$session" -x 120 -y 40 -- "$SHELL_BIN" -lc "$script"
	TMUX_SESSIONS+=("$session")

	local elapsed=0
	local missing=""
	while true; do
		tmux capture-pane -pt "$session" >"$capture" 2>/dev/null || true
		missing=""
		rg -q "SUM=42" "$capture" || missing="${missing} SUM=42"
		rg -q "\\(cursor\\) composer-2\\.5" "$capture" || missing="${missing} footer (cursor) composer-2.5"
		if [[ -z "$missing" ]]; then
			tmux kill-session -t "$session" 2>/dev/null || true
			log "$name PASS"
			return 0
		fi

		sleep 2
		elapsed=$((elapsed + 2))
		if (( elapsed >= timeout_secs )); then
			tmux kill-session -t "$session" 2>/dev/null || true
			printf '[smoke] %s timed out after %ss; missing:%s\n' "$name" "$timeout_secs" "$missing" >&2
			printf '[smoke] %s capture tail:\n' "$name" >&2
			tail_file "$capture" 120 >&2
			fail "$name timed out waiting for TUI evidence"
		fi
	done
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
log "partial live smoke: prereq, basic, default-settings, noninteractive-math, tui, steering, diagnostics, jsonl"

if ! PI_CURSOR_SETTING_SOURCES=none "${PI_BASE[@]}" --list-models cursor 2>"$SMOKE_DIR/prereq.stderr.txt" | tee "$SMOKE_DIR/prereq.models.txt" | rg -q "composer-2\\.5"; then
	if ! model_listed "$SMOKE_DIR/prereq.stderr.txt"; then
		fail "cursor/composer-2.5 not listed"
	fi
fi
log "prereq PASS"

run_direct basic 600 retry-empty-output "PI_CURSOR_SMOKE_OK" "PI_CURSOR_SMOKE_OK" \
	env PI_CURSOR_SETTING_SOURCES=none "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/basic" \
	--no-tools \
	-p 'Live smoke. Reply exactly: PI_CURSOR_SMOKE_OK'

run_direct default-settings 300 strict "PRODUCT=42" "PRODUCT=42" \
	"${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/default-settings" \
	--no-tools \
	-p 'Default settings smoke. Include PRODUCT=42 in the final answer.'

run_direct noninteractive-math 300 strict "SUM=42" "SUM=42" \
	env PI_CURSOR_SETTING_SOURCES=none "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/noninteractive-math" \
	--no-tools \
	-p 'Noninteractive math smoke. Compute 19 + 23. Reply only with SUM=42.'

run_tui_math_footer_poll tui 420 \
	env PI_CURSOR_SETTING_SOURCES=none "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/tui" \
	--no-tools \
	'TUI smoke. Compute 19 + 23. Reply only with SUM=<number>.'

run_tmux steering 420 1 \
	env "SMOKE_SESSION_DIR=$SMOKE_DIR/steering" node "$ROOT/scripts/steering-rpc-smoke.mjs"
rg -q '"steerOk":true' "$SMOKE_DIR/steering.stdout.txt" || fail "steering missing steerOk"
rg -q '"steerChain":true' "$SMOKE_DIR/steering.stdout.txt" || fail "steering missing steerChain"
rg -q "already has active run|AgentBusyError" "$SMOKE_DIR/steering.stdout.txt" "$SMOKE_DIR/steering.stderr.txt" && fail "steering hit AgentBusyError" || true

forbidden_files="$(find "$SMOKE_DIR" -type f \( -name '*stderr.txt' -o -name '*capture*.txt' \) -print0 |
	xargs -0 grep -IlE 'CURSOR_API_KEY|Bearer [A-Za-z0-9._-]+|/cursor-pi-tool-bridge/[^ ]+/mcp|127\.0\.0\.1:[0-9]+/cursor-pi-tool-bridge|apiKey|cookie|session-cookie|secret-token' || true)"
if [[ -n "$forbidden_files" ]]; then
	printf '[smoke] diagnostics safety scan found forbidden material in:\n' >&2
	while IFS= read -r file; do
		[[ -z "$file" ]] && continue
		if [[ "$file" == "$SMOKE_DIR/"* ]]; then
			printf '[smoke]   %s\n' "${file#"$SMOKE_DIR/"}" >&2
		else
			printf '[smoke]   %s\n' "$file" >&2
		fi
	done <<<"$forbidden_files"
	fail "diagnostics safety scan found forbidden material"
fi
log "diagnostics safety PASS"

node "$ROOT/scripts/validate-smoke-jsonl.mjs" "$SMOKE_DIR"
log "jsonl structural scan PASS"
log "partial live smoke checks passed (see --help for uncovered checklist sections)"
