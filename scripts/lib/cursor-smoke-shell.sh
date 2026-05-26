# Shared maintainer smoke shell helpers (timeout, logging, auth seeding).
# Source from top-level smoke scripts: . "$(dirname "$0")/lib/cursor-smoke-shell.sh"

: "${SMOKE_LOG_PREFIX:=smoke}"
SMOKE_KILL_GRACE_SECS="${SMOKE_KILL_GRACE_SECS:-2}"

smoke_log() {
	printf '[%s] %s\n' "$SMOKE_LOG_PREFIX" "$*"
}

smoke_fail() {
	printf '[%s] FAIL: %s\n' "$SMOKE_LOG_PREFIX" "$*" >&2
	exit 1
}

smoke_require_cmd() {
	command -v "$1" >/dev/null 2>&1 || smoke_fail "missing required command: $1"
}

# Run a command with a wall-clock timeout. Prefer GNU/BSD timeout; fall back to a
# process-group kill watcher with TERM then KILL (same semantics as tmux live smoke).
smoke_run_with_timeout() {
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
		sleep "$SMOKE_KILL_GRACE_SECS"
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

# Run with timeout; map exit 124/137/143 to a smoke_fail timeout message.
smoke_run_with_timeout_or_fail() {
	local label="$1"
	local timeout_secs="$2"
	shift 2
	smoke_log "$label (timeout ${timeout_secs}s)"
	if smoke_run_with_timeout "$timeout_secs" "$@"; then
		return 0
	fi
	local rc=$?
	case "$rc" in
		124|137|143) smoke_fail "$label timed out after ${timeout_secs}s" ;;
		*) smoke_fail "$label exited $rc" ;;
	esac
}

smoke_seed_pi_agent_home() {
	local home="$1"
	local auth_json="${2:-${AUTH_JSON:-${REAL_HOME:-$HOME}/.pi/agent/auth.json}}"
	local models_src="${3:-${PI_AGENT_DIR:-${REAL_HOME:-$HOME}/.pi/agent}/models.json}"
	mkdir -p "$home/.pi/agent"
	if [[ -f "$auth_json" ]]; then
		cp "$auth_json" "$home/.pi/agent/auth.json"
		chmod 600 "$home/.pi/agent/auth.json"
		smoke_log "seeded $home/.pi/agent/auth.json"
	else
		smoke_log "WARN: no auth.json at $auth_json"
	fi
	if [[ -f "$models_src" ]]; then
		cp "$models_src" "$home/.pi/agent/models.json"
	fi
}

smoke_has_auth_provider() {
	local provider="$1"
	local auth_path="$2"
	python3 - "$provider" "$auth_path" <<'PY'
import json, sys
provider, path = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path))
except FileNotFoundError:
    sys.exit(1)
sys.exit(0 if provider in data and data[provider] else 1)
PY
}
