import type { ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";

interface CursorSessionScopeExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
}

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";

type CursorSessionScopeChangeHandler = (previousScopeKey: string) => void;

const state = {
	sessionCwd: process.cwd(),
	sessionFile: undefined as string | undefined,
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
	return state.sessionFile ?? ANONYMOUS_SESSION_SCOPE_KEY;
}

export function getCursorSessionCwdFromScope(): string {
	return state.sessionCwd;
}

function setCursorSessionScope(cwd: string, sessionFile: string | undefined): void {
	state.sessionCwd = cwd;
	state.sessionFile = sessionFile;
}

function resetCursorSessionScope(): void {
	state.sessionCwd = process.cwd();
	state.sessionFile = undefined;
}

export function onCursorSessionScopeKeyChange(handler: CursorSessionScopeChangeHandler): void {
	scopeChangeHandler = handler;
}

export function registerCursorSessionScope(pi: CursorSessionScopeExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		const previousScopeKey = getCursorSessionScopeKey();
		setCursorSessionScope(ctx.cwd, ctx.sessionManager?.getSessionFile?.() ?? undefined);
		if (previousScopeKey !== getCursorSessionScopeKey()) {
			scopeChangeHandler?.(previousScopeKey);
		}
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	set: setCursorSessionScope,
	reset: resetCursorSessionScope,
};
