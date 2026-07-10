import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { resetSessionCursorAgent } from "./cursor-session-agent.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import { runWithCursorSdkCompactionPrepGuard } from "./cursor-sdk-process-error-guard.js";

/**
 * Prepare the pooled Cursor session agent for pi compaction summarization.
 * Releases any scoped live-run drain state still tied to the pooled agent, waits
 * for in-flight run.wait() tracking to settle, then disposes the pool entry so
 * summarization acquires a clean SDK agent.
 */
export async function prepareCursorSessionForCompaction(
	scopeKey: string = getCursorSessionScopeKey(),
): Promise<void> {
	await runWithCursorSdkCompactionPrepGuard(async () => {
		while (true) {
			const run = cursorLiveRuns.getActiveForScope(scopeKey);
			if (!run || run.disposed) break;
			await cursorLiveRuns.release(run);
		}
		await resetSessionCursorAgent(scopeKey, { awaitIdle: true });
	});
}
