import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { applyCursorApproximateUsage } from "./cursor-usage-accounting.js";
import { hasUsableText } from "./cursor-record-utils.js";
import {
	abandonSessionCursorAgent,
	drainCursorLiveRunTurn,
	flushPendingCursorLiveRunTraceEventsToStream,
	settleCursorLiveToolBatch,
} from "./cursor-provider-live-run-drain.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import {
	buildIncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcomeInput,
} from "./cursor-incomplete-tool-visibility.js";
import {
	classifyCursorRunEmission,
	getCursorRunAbortMessage,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";
import type {
	CursorProviderTurnPrepared,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnSend,
} from "./cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";

export interface EmitCursorLiveTurnParams {
	params: CursorProviderTurnRunnerParams;
	send: CursorProviderTurnSend;
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	discardIncompleteTools: (outcome: IncompleteCursorToolRunOutcomeInput) => void;
}

export interface EmitCursorLiveTurnResult {
	error: unknown | undefined;
}

export async function emitCursorLiveTurn(emitParams: EmitCursorLiveTurnParams): Promise<EmitCursorLiveTurnResult> {
	const { params, send, sdkEventDebug, discardIncompleteTools } = emitParams;
	const { prepared } = send;
	const { liveRun, turnCoordinator } = prepared;
	if (!liveRun) throw new Error("emitCursorLiveTurn requires a live run");

	const { options, model } = params;
	let error: unknown;
	try {
		await cursorLiveRuns.withRunLease(liveRun, options?.signal, async () => {
			await cursorLiveRuns.waitForProgress(liveRun, options?.signal);
			await settleCursorLiveToolBatch(liveRun);
			turnCoordinator.closeTraceBlock();
			await drainCursorLiveRunTurn(params.stream, params.partial, model, params.context, liveRun, 0, {
				mode: "emit",
				signal: options?.signal,
				debugRecorder: sdkEventDebug,
			});
		});
	} catch (caught) {
		error = caught;
		if (caught instanceof CursorLiveRunAbortError) {
			discardIncompleteTools({ status: "cancelled", signalAborted: true });
			turnCoordinator.closeTraceBlock();
			flushPendingCursorLiveRunTraceEventsToStream(params.stream, params.partial, liveRun, {
				includeTracesBehindQueuedTools: true,
			});
			await cursorLiveRuns.release(liveRun);
		}
	}

	return { error };
}

export interface EmitCursorDirectOutcomeParams {
	params: CursorProviderTurnRunnerParams;
	send: CursorProviderTurnSend;
	outcome: CursorRunOutcome;
}

export async function emitCursorDirectOutcome(emitParams: EmitCursorDirectOutcomeParams): Promise<void> {
	const { params, send, outcome } = emitParams;
	const { prepared } = send;
	const { turnCoordinator, sessionAgentLease, bootstrap, promptInputTokens, sessionAgentScopeKey } = prepared;
	const { stream, partial, model, context } = params;

	turnCoordinator.closeTraceBlock();

	switch (classifyCursorRunEmission(outcome)) {
		case "cancelled":
			await abandonSessionCursorAgent(sessionAgentScopeKey);
			partial.stopReason = "aborted";
			partial.errorMessage = getCursorRunAbortMessage(outcome);
			stream.push({ type: "error", reason: "aborted", error: partial });
			break;
		case "failed":
			await abandonSessionCursorAgent(sessionAgentScopeKey);
			partial.stopReason = "error";
			partial.errorMessage = outcome.kind === "error" ? outcome.errorMessage : "Cursor SDK run failed.";
			stream.push({ type: "error", reason: "error", error: partial });
			break;
		case "finished":
			sessionAgentLease.commitSend(context, bootstrap);
			turnCoordinator.flushText(
				outcome.kind === "finished" && hasUsableText(outcome.finalText) ? [outcome.finalText] : [],
			);
			applyCursorApproximateUsage(partial, model, context, promptInputTokens);
			stream.push({ type: "done", reason: "stop", message: partial });
			break;
	}
}

export function discardIncompleteToolsFromPrepared(
	prepared: CursorProviderTurnPrepared | undefined,
	outcome: IncompleteCursorToolRunOutcomeInput,
): void {
	prepared?.turnCoordinator.discardIncompleteStartedToolCalls(buildIncompleteCursorToolRunOutcome(outcome));
}
