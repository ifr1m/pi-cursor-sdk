#!/usr/bin/env bash
# Isolated /tmp install + fail-fast live smoke for pi-cursor-sdk native replay.
#
# Validates packed extension load, plan-strip resync, and absence of "Tool * not found".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/cursor-smoke-shell.sh
. "$ROOT/scripts/lib/cursor-smoke-shell.sh"
SMOKE_LOG_PREFIX=isolated-smoke

REAL_HOME="${REAL_HOME:-$HOME}"
PI_AGENT_DIR="${PI_AGENT_DIR:-$REAL_HOME/.pi/agent}"
AUTH_JSON="${AUTH_JSON:-$PI_AGENT_DIR/auth.json}"
REPO="${REPO:-$ROOT}"
ISOLATED="${ISOLATED:-/tmp/pi-cursor-sdk-isolated-$(date +%Y%m%dT%H%M%S)}"
PI_LIVE_TIMEOUT="${PI_LIVE_TIMEOUT:-45}"
SKIP_LIVE="${SKIP_LIVE:-0}"
SKIP_UNIT="${SKIP_UNIT:-0}"
PI_BIN="${PI_BIN:-pi}"
PI_PATH="${PI_PATH:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin}"

PACK_DIR="$ISOLATED/pack"
EXTRACT_DIR="$ISOLATED/extract"
PROJECT_DIR="$ISOLATED/project"
SESSION_ROOT="$ISOLATED/sessions"
SHIM_DIR="$ROOT/scripts/fixtures/plan-strip-shim"
HOME_DIR="$ISOLATED/home"

print_help() {
	cat <<EOF
Isolated /tmp install smoke for pi-cursor-sdk (native replay + plan-strip resync).

Usage:
  ./scripts/isolated-cursor-smoke.sh
  SKIP_LIVE=1 ./scripts/isolated-cursor-smoke.sh
  PI_LIVE_TIMEOUT=90 ./scripts/isolated-cursor-smoke.sh

Environment:
  REPO                          Repo under test (default: script parent directory).
  ISOLATED                      Artifact root (default: /tmp/pi-cursor-sdk-isolated-<timestamp>).
  REAL_HOME                     Source for auth.json (default: \$HOME).
  AUTH_JSON                     Path to pi auth.json to seed isolated HOME (default: ~/.pi/agent/auth.json).
  PI_LIVE_TIMEOUT               Per live pi check timeout in seconds (default: 45).
  PI_BIN                        pi executable (default: pi on PATH).
  PI_PATH                       PATH for isolated pi runs.
  SKIP_LIVE=1                   Run unit tests + pack only; skip live Cursor calls.
  SKIP_UNIT=1                   Skip repo unit tests (live checks only).
  CURSOR_API_KEY                Optional fallback when auth.json lacks cursor provider.

Prerequisites:
  node, npm, pi, rg, python3 on PATH
  ~/.pi/agent/auth.json with cursor provider OR CURSOR_API_KEY

Exit codes:
  0  all requested checks passed
  1  prerequisite, unit, pack, live smoke, or JSONL replay validation failure
EOF
}

log() { smoke_log "$@"; }
fail() { smoke_fail "$@"; }
seed_pi_agent_home() { smoke_seed_pi_agent_home "$@"; }
has_auth_provider() { smoke_has_auth_provider "$1" "$HOME_DIR/.pi/agent/auth.json"; }
run_with_timeout() { smoke_run_with_timeout_or_fail "$@"; }

validate_replay_jsonl() {
	local dir="$1"
	node "$ROOT/scripts/validate-smoke-jsonl.mjs" --replay-errors-only "$dir"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	print_help
	exit 0
fi

if [[ -f "${SECRETS_FILE:-$REAL_HOME/.secrets}" ]]; then
	set +u
	# shellcheck disable=SC1090
	source "${SECRETS_FILE:-$REAL_HOME/.secrets}"
	set -u
fi

smoke_require_cmd node
smoke_require_cmd npm
smoke_require_cmd rg
smoke_require_cmd python3

mkdir -p "$PACK_DIR" "$EXTRACT_DIR" "$PROJECT_DIR" "$SESSION_ROOT" "$HOME_DIR"
seed_pi_agent_home "$HOME_DIR"

log "isolated root: $ISOLATED"
log "HOME=$HOME_DIR"

if [[ "$SKIP_UNIT" != "1" ]]; then
	log "preflight: repo unit tests"
	run_with_timeout "npm test" 120 bash -lc "cd '$REPO' && npm test"
fi

if [[ "$SKIP_LIVE" == "1" ]]; then
	log "SKIP_LIVE=1 — skipping live pi checks"
	exit 0
fi

if ! has_auth_provider cursor && [[ -z "${CURSOR_API_KEY:-}" ]]; then
	fail "no cursor auth in $HOME_DIR/.pi/agent/auth.json and CURSOR_API_KEY unset"
fi

command -v "$PI_BIN" >/dev/null || fail "PI_BIN not found: $PI_BIN"

log "npm pack from $REPO"
(cd "$REPO" && npm pack --pack-destination "$PACK_DIR" >/dev/null 2>&1)
PACK_TGZ="$(ls -t "$PACK_DIR"/*.tgz | head -1)"
[[ -f "$PACK_TGZ" ]] || fail "missing pack tarball"
tar -xzf "$PACK_TGZ" -C "$EXTRACT_DIR"
[[ -d "$EXTRACT_DIR/package" ]] || fail "extract missing package/ dir"

log "npm install packed extension deps"
run_with_timeout "npm install --omit=dev" 120 bash -lc "cd '$EXTRACT_DIR/package' && npm install --omit=dev >/dev/null 2>&1"

log "pi install -l (clean HOME)"
cp "$REPO/README.md" "$PROJECT_DIR/README.md"
run_with_timeout "pi install" 30 env -i HOME="$HOME_DIR" PATH="$PI_PATH" MISE_DISABLE=1 \
	bash -c "cd '$PROJECT_DIR' && '$PI_BIN' install -l '$EXTRACT_DIR/package' >/dev/null"

run_with_timeout "pi list" 15 env -i HOME="$HOME_DIR" PATH="$PI_PATH" MISE_DISABLE=1 \
	bash -c "cd '$PROJECT_DIR' && '$PI_BIN' list" | rg -q "extract/package" || fail "packed extension not installed"

PI_ENV=(HOME="$HOME_DIR" PATH="$PI_PATH" MISE_DISABLE=1 PI_CURSOR_SETTING_SOURCES=none)
if [[ -n "${CURSOR_API_KEY:-}" ]]; then
	PI_ENV+=(CURSOR_API_KEY="$CURSOR_API_KEY")
fi

log "check: list-models"
LIST_OUT="$ISOLATED/list-models.txt"
run_with_timeout "list-models" 30 env -i "${PI_ENV[@]}" \
	bash -c "cd '$PROJECT_DIR' && '$PI_BIN' --cursor-no-fast --list-models cursor > '$LIST_OUT' 2>&1"
rg -q "composer-2\\.5|composer-2-5" "$LIST_OUT" || fail "composer-2.5 not listed (see $LIST_OUT)"

log "check: basic provider prompt"
BASIC_DIR="$SESSION_ROOT/basic"
mkdir -p "$BASIC_DIR"
run_with_timeout "basic prompt" "$PI_LIVE_TIMEOUT" env -i "${PI_ENV[@]}" \
	bash -c "cd '$PROJECT_DIR' && '$PI_BIN' --cursor-no-fast --model cursor/composer-2.5 --session-dir '$BASIC_DIR' --no-tools -p 'Reply exactly: PI_CURSOR_ISOLATED_OK' > '$ISOLATED/basic.stdout.txt' 2> '$ISOLATED/basic.stderr.txt'"
rg -q "PI_CURSOR_ISOLATED_OK" "$ISOLATED/basic.stdout.txt" || fail "basic prompt missing PI_CURSOR_ISOLATED_OK"
validate_replay_jsonl "$BASIC_DIR"

log "check: native replay"
REPLAY_DIR="$SESSION_ROOT/native-replay"
mkdir -p "$REPLAY_DIR"
run_with_timeout "native replay" "$PI_LIVE_TIMEOUT" env -i "${PI_ENV[@]}" PI_CURSOR_NATIVE_TOOL_DISPLAY=1 \
	bash -c "cd '$PROJECT_DIR' && '$PI_BIN' --cursor-no-fast --model cursor/composer-2.5 --session-dir '$REPLAY_DIR' -p 'Read ./README.md briefly, then answer README_SEEN=yes if it mentions pi-cursor-sdk.' > '$ISOLATED/replay.stdout.txt' 2> '$ISOLATED/replay.stderr.txt'"
validate_replay_jsonl "$REPLAY_DIR"

log "check: plan-strip shim (plan-mode execute reset)"
PLAN_DIR="$SESSION_ROOT/plan-strip"
mkdir -p "$PLAN_DIR"
run_with_timeout "plan-strip replay" "$PI_LIVE_TIMEOUT" env -i "${PI_ENV[@]}" PI_CURSOR_NATIVE_TOOL_DISPLAY=1 \
	bash -c "cd '$PROJECT_DIR' && '$PI_BIN' -e '$SHIM_DIR' --cursor-no-fast --model cursor/composer-2.5 --session-dir '$PLAN_DIR' -p 'After reset, read README.md and answer PLAN_STRIP_OK=yes.' > '$ISOLATED/plan.stdout.txt' 2> '$ISOLATED/plan.stderr.txt'"
validate_replay_jsonl "$PLAN_DIR"

log "PASS isolated install smoke: $ISOLATED"
