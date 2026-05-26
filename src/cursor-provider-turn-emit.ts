import type { Context } from "@earendil-works/pi-ai";
import { CursorLiveRunAbortError, type CursorLiveRun } from "./cursor-live-run-coordinator.js";
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
	classifyCursorRunDirectEmission,
	classifyCursorRunLiveEmission,
	getCursorRunAbortMessage,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";
import { sanitizeCursorProviderError } from "./cursor-provider-errors.js";
import type { installCursorSdkAbortErrorSuppression } from "./cursor-sdk-abort-error-guard.js";
import type { SessionCursorAgentLease } from "./cursor-session-agent.js";
import { awaitFinalizeCursorRunOutcome } from "./cursor-provider-turn-finalize.js";
import type {
	CursorProviderTurnRunnerParams,
	CursorProviderTurnRuntime,
	CursorProviderTurnSend,
} from "./cursor-provider-turn-types.js";

function applyLiveRunOutcome(
	liveRun: CursorLiveRun,
	outcome: CursorRunOutcome,
	sessionAgentLease: SessionCursorAgentLease,
	context: Context,
	bootstrap: boolean,
): void {
	switch (classifyCursorRunLiveEmission(outcome)) {
		case "finished":
			sessionAgentLease.commitSend(context, bootstrap);
			cursorLiveRuns.markFinished(liveRun, outcome.kind === "finished" ? outcome.finalText : "");
			break;
		case "cancelled":
			cursorLiveRuns.markCancelled(liveRun, getCursorRunAbortMessage(outcome));
			break;
		case "failed":
			cursorLiveRuns.markError(liveRun, outcome.kind === "error" ? outcome.errorMessage : "Cursor SDK run failed.");
			break;
	}
}

export interface EmitCursorLiveTurnParams {
	params: CursorProviderTurnRunnerParams;
	runtime: CursorProviderTurnRuntime;
	send: CursorProviderTurnSend;
	sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>;
	discardIncompleteTools: (outcome: IncompleteCursorToolRunOutcomeInput) => void;
	finalizeSdkEventDebug: () => Promise<void>;
}

export async function emitCursorLiveTurn(emitParams: EmitCursorLiveTurnParams): Promise<void> {
	const { params, runtime, send, sdkAbortErrorSuppression, discardIncompleteTools, finalizeSdkEventDebug } = emitParams;
	const { run, prepared, cursorAgentMessageOffset } = send;
	const { liveRun, turnCoordinator, sessionAgentLease, bootstrap } = prepared;
	if (!liveRun) return;

	runtime.deferSdkEventDebugFinalize = true;
	const activeSessionAgentLease = sessionAgentLease;
	const { options, model } = params;
	const { sdkEventDebug } = runtime;

	const waitCompletion = awaitFinalizeCursorRunOutcome({
		run,
		prepared,
		cursorAgentMessageOffset,
		modelId: model.id,
		signalAborted: options?.signal?.aborted,
		runResultFallback: run.result,
		resolvedApiKey: runtime.resolvedApiKey,
		optionsApiKey: options?.apiKey,
		sdkEventDebug,
		cacheContextWindow: true,
		contextWindowAgentId: liveRun.agent.agentId,
	})
		.then(async (outcome) => {
			if (liveRun.disposed) return;
			applyLiveRunOutcome(liveRun, outcome, activeSessionAgentLease, params.context, bootstrap);
		})
		.catch(async (error: unknown) => {
			sdkEventDebug?.recordWaitResult({ status: "error", error: String(error) });
			sdkEventDebug?.recordError("run_wait", error);
			discardIncompleteTools({ status: "error" });
			await sdkEventDebug?.captureRunArtifacts(run);
			if (liveRun.disposed) return;
			cursorLiveRuns.markError(
				liveRun,
				sanitizeCursorProviderError(error, runtime.resolvedApiKey ?? options?.apiKey),
			);
		});

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
	} catch (error) {
		if (error instanceof CursorLiveRunAbortError) {
			sdkAbortErrorSuppression.suppressAbortErrors();
			discardIncompleteTools({ status: "cancelled", signalAborted: true });
			turnCoordinator.closeTraceBlock();
			flushPendingCursorLiveRunTraceEventsToStream(params.stream, params.partial, liveRun, {
				includeTracesBehindQueuedTools: true,
			});
			await cursorLiveRuns.release(liveRun);
		}
		throw error;
	} finally {
		params.sdkEventDebugRef.current = undefined;
		activeSessionAgentLease.trackRunCompletion(waitCompletion);
		void waitCompletion
			.finally(async () => {
				try {
					await finalizeSdkEventDebug();
				} finally {
					sdkAbortErrorSuppression.dispose();
				}
			})
			.catch(() => {});
	}
}

export interface EmitCursorDirectOutcomeParams {
	params: CursorProviderTurnRunnerParams;
	runtime: CursorProviderTurnRuntime;
	send: CursorProviderTurnSend;
	outcome: CursorRunOutcome;
}

export async function emitCursorDirectOutcome(emitParams: EmitCursorDirectOutcomeParams): Promise<void> {
	const { params, runtime, send, outcome } = emitParams;
	const { prepared } = send;
	const { turnCoordinator, sessionAgentLease, bootstrap, promptInputTokens } = prepared;
	const { stream, partial, model, context } = params;

	turnCoordinator.closeTraceBlock();

	switch (classifyCursorRunDirectEmission(outcome)) {
		case "cancelled":
			await abandonSessionCursorAgent(runtime.sessionAgentScopeKey);
			partial.stopReason = "aborted";
			partial.errorMessage = getCursorRunAbortMessage(outcome);
			stream.push({ type: "error", reason: "aborted", error: partial });
			break;
		case "failed":
			await abandonSessionCursorAgent(runtime.sessionAgentScopeKey);
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

export function discardIncompleteToolsFromRuntime(
	runtime: CursorProviderTurnRuntime,
	outcome: IncompleteCursorToolRunOutcomeInput,
): void {
	runtime.turnCoordinatorForCleanup?.discardIncompleteStartedToolCalls(buildIncompleteCursorToolRunOutcome(outcome));
}
