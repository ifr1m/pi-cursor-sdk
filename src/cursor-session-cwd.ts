import {
	getCursorSessionCwdFromScope,
	registerCursorSessionScope,
	__testUtils as cursorSessionScopeTestUtils,
} from "./cursor-session-scope.js";
import type { ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";

interface CursorSessionCwdExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
}

/**
 * Pi session cwd when known; falls back to process.cwd() before session_start.
 * Updated on session_start only until pi threads cwd into streamSimple—mid-session cwd
 * changes without a new session_start event are not reflected here.
 */
export function getCursorSessionCwd(): string {
	return getCursorSessionCwdFromScope();
}

export function registerCursorSessionCwd(pi: CursorSessionCwdExtensionApi): void {
	registerCursorSessionScope(pi);
}

export const __testUtils = {
	set: cursorSessionScopeTestUtils.set,
	reset: cursorSessionScopeTestUtils.reset,
};
