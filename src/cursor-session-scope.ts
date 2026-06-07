import type { ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";

interface CursorSessionScopeExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
}

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";
const EPHEMERAL_SESSION_SCOPE_PREFIX = "__ephemeral__:";

type CursorSessionScopeChangeHandler = (previousScopeKey: string) => void;

const state = {
	sessionCwd: process.cwd(),
	sessionFile: undefined as string | undefined,
	sessionId: undefined as string | undefined,
};

let scopeChangeHandler: CursorSessionScopeChangeHandler | undefined;

/**
 * Pi session file when known; used to scope reused Cursor SDK agents to one pi session.
 */
export function getCursorSessionFile(): string | undefined {
	return state.sessionFile;
}

/**
 * Stable scope key for session-agent pooling. Falls back to a process-local anonymous key
 * before the first session_start (tests and early startup).
 */
export function getCursorSessionScopeKey(): string {
	if (state.sessionFile) return state.sessionFile;
	if (state.sessionId) return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${state.sessionId}`;
	return ANONYMOUS_SESSION_SCOPE_KEY;
}

/**
 * Pi session cwd when known; falls back to process.cwd() before session_start.
 * Updated on session_start only until pi threads cwd into streamSimple—mid-session cwd
 * changes without a new session_start event are not reflected here.
 */
export function getCursorSessionCwd(): string {
	return state.sessionCwd;
}

function setCursorSessionScope(cwd: string, sessionFile: string | undefined, sessionId?: string): void {
	state.sessionCwd = cwd;
	state.sessionFile = sessionFile;
	state.sessionId = sessionId;
}

function resetCursorSessionScope(): void {
	state.sessionCwd = process.cwd();
	state.sessionFile = undefined;
	state.sessionId = undefined;
}

export function onCursorSessionScopeKeyChange(handler: CursorSessionScopeChangeHandler): void {
	scopeChangeHandler = handler;
}

export function registerCursorSessionScope(pi: CursorSessionScopeExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		const previousScopeKey = getCursorSessionScopeKey();
		setCursorSessionScope(
			ctx.cwd,
			ctx.sessionManager?.getSessionFile?.() ?? undefined,
			ctx.sessionManager?.getSessionId?.() ?? undefined,
		);
		if (previousScopeKey !== getCursorSessionScopeKey()) {
			scopeChangeHandler?.(previousScopeKey);
		}
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	EPHEMERAL_SESSION_SCOPE_PREFIX,
	set: setCursorSessionScope,
	reset: resetCursorSessionScope,
};
