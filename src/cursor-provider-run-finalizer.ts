import type { Context } from "@earendil-works/pi-ai";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import {
	classifyCursorRunEmission,
	getCursorRunAbortMessage,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";
import { sanitizeCursorProviderError } from "./cursor-provider-errors.js";
import type { IncompleteCursorToolRunOutcomeInput } from "./cursor-incomplete-tool-visibility.js";
import type { installCursorSdkAbortErrorSuppression } from "./cursor-sdk-abort-error-guard.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { awaitFinalizeCursorRunOutcome } from "./cursor-provider-turn-finalize.js";
import type {
	CursorProviderTurnRunnerParams,
	CursorProviderTurnSend,
} from "./cursor-provider-turn-types.js";

function applyLiveRunOutcome(
	outcome: CursorRunOutcome,
	send: CursorProviderTurnSend,
	context: Context,
): void {
	const { liveRun, sessionAgentLease, bootstrap } = send.prepared;
	if (!liveRun || liveRun.disposed) return;
	switch (classifyCursorRunEmission(outcome)) {
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

export interface CursorLiveRunCompletion {
	waitCompletion: Promise<void>;
	send: CursorProviderTurnSend;
}

export interface CursorRunFinalizerParams {
	runnerParams: CursorProviderTurnRunnerParams;
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>;
}

export interface StartCursorLiveRunCompletionParams {
	send: CursorProviderTurnSend;
	modelId: string;
	resolvedApiKey: string | undefined;
	discardIncompleteTools: (outcome: IncompleteCursorToolRunOutcomeInput) => void;
}

export class CursorRunFinalizer {
	constructor(private readonly params: CursorRunFinalizerParams) {}

	startLiveRunCompletion(startParams: StartCursorLiveRunCompletionParams): CursorLiveRunCompletion {
		const { runnerParams, sdkEventDebug } = this.params;
		const { send, modelId, resolvedApiKey, discardIncompleteTools } = startParams;
		const { run, prepared, cursorAgentMessageOffset } = send;
		const liveRun = prepared.liveRun;
		if (!liveRun) throw new Error("startLiveRunCompletion requires a live run");
		const waitCompletion = awaitFinalizeCursorRunOutcome({
			run,
			prepared,
			cursorAgentMessageOffset,
			modelId,
			signal: runnerParams.options?.signal,
			runResultFallback: run.result,
			resolvedApiKey,
			optionsApiKey: runnerParams.options?.apiKey,
			sdkEventDebug,
			cacheContextWindow: true,
			contextWindowAgentId: liveRun.agent.agentId,
		})
			.then(async (outcome) => {
				applyLiveRunOutcome(outcome, send, runnerParams.context);
			})
			.catch(async (error: unknown) => {
				sdkEventDebug?.recordWaitResult({ status: "error", error: String(error) });
				sdkEventDebug?.recordError("run_wait", error);
				discardIncompleteTools({ status: "error" });
				await sdkEventDebug?.captureRunArtifacts(run);
				if (liveRun.disposed) return;
				cursorLiveRuns.markError(
					liveRun,
					sanitizeCursorProviderError(error, resolvedApiKey ?? runnerParams.options?.apiKey),
				);
			});
		return { waitCompletion, send };
	}

	async cleanup(liveCompletion: CursorLiveRunCompletion | undefined): Promise<void> {
		this.params.runnerParams.sdkEventDebugRef.current = undefined;
		if (liveCompletion) {
			liveCompletion.send.prepared.sessionAgentLease.trackRunCompletion(liveCompletion.waitCompletion);
			void liveCompletion.waitCompletion
				.finally(async () => {
					try {
						await this.finalizeSdkEventDebug();
					} finally {
						this.params.sdkAbortErrorSuppression.dispose();
					}
				})
				.catch(() => {});
			return;
		}
		try {
			await this.finalizeSdkEventDebug();
		} finally {
			this.params.sdkAbortErrorSuppression.dispose();
		}
	}

	private async finalizeSdkEventDebug(): Promise<void> {
		this.params.sdkEventDebug?.recordFinalPartial(this.params.runnerParams.partial);
		await this.params.sdkEventDebug?.finalize();
	}
}
