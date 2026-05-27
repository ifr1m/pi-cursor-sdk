import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import {
	abandonSessionCursorAgent,
	cursorLiveRuns,
	drainExistingCursorLiveRunBeforeSend,
} from "./cursor-provider-live-run-drain.js";
import {
	formatCursorSdkAbortMessage,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "./cursor-provider-errors.js";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import { installCursorSdkAbortErrorSuppression } from "./cursor-sdk-abort-error-guard.js";
import { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { awaitFinalizeCursorRunOutcome } from "./cursor-provider-turn-finalize.js";
import {
	discardIncompleteToolsFromPrepared,
	emitCursorDirectOutcome,
	emitCursorLiveTurn,
} from "./cursor-provider-turn-emit.js";
import { CursorRunFinalizer, type CursorLiveRunCompletion } from "./cursor-provider-run-finalizer.js";
import { prepareCursorProviderTurn, requireCursorApiKey } from "./cursor-provider-turn-prepare.js";
import { sendCursorProviderTurn } from "./cursor-provider-turn-send.js";
import type {
	CursorProviderTurnPrepared,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnSendResult,
} from "./cursor-provider-turn-types.js";

export { resolveCursorApiKey } from "./cursor-provider-turn-api-key.js";
export type { CursorProviderTurnRunnerParams } from "./cursor-provider-turn-types.js";

export class CursorProviderTurnRunner {
	private sdkEventDebug: CursorSdkEventDebugSink | undefined;
	private resolvedApiKey: string | undefined;

	constructor(private readonly params: CursorProviderTurnRunnerParams) {}

	private get options() {
		return this.params.options;
	}

	private throwIfAborted(): void {
		if (this.options?.signal?.aborted) throw new CursorLiveRunAbortError();
	}

	private pushSanitizedStreamError(error: unknown, reason: "error" | "aborted" = "error"): void {
		const { partial, options } = this.params;
		partial.stopReason = reason;
		partial.errorMessage =
			reason === "aborted"
				? formatCursorSdkAbortMessage(
						resolveCursorSdkAbortCause({ signalAborted: options?.signal?.aborted }),
					)
				: sanitizeCursorProviderError(error, this.resolvedApiKey ?? options?.apiKey);
		this.params.stream.push({ type: "error", reason, error: partial });
	}

	private discardIncompleteTools(
		prepared: CursorProviderTurnPrepared | undefined,
		outcome: import("./cursor-incomplete-tool-visibility.js").IncompleteCursorToolRunOutcomeInput,
	): void {
		discardIncompleteToolsFromPrepared(prepared, outcome);
	}

	async run(sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>): Promise<void> {
		const { stream, partial, model, context, options, sdkEventDebugRef } = this.params;
		let prepared: CursorProviderTurnPrepared | undefined;
		let sendResult: CursorProviderTurnSendResult | undefined;
		let liveCompletion: CursorLiveRunCompletion | undefined;
		let runFinalizer: CursorRunFinalizer | undefined;

		try {
			stream.push({ type: "start", partial });
			this.throwIfAborted();
			const cwd = getCursorSessionCwd();
			this.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
			});
			sdkEventDebugRef.current = this.sdkEventDebug;
			runFinalizer = new CursorRunFinalizer({
				runnerParams: this.params,
				sdkEventDebug: this.sdkEventDebug,
				sdkAbortErrorSuppression,
			});
			this.sdkEventDebug?.recordContextSnapshot(context);
			if (
				(await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug)) ===
				"stream_ended"
			) {
				return;
			}

			this.resolvedApiKey = requireCursorApiKey(options);
			({ prepared } = await prepareCursorProviderTurn({
				params: this.params,
				cwd,
				resolvedApiKey: this.resolvedApiKey,
				sdkEventDebug: this.sdkEventDebug,
				throwIfAborted: () => this.throwIfAborted(),
			}));

			sendResult = await sendCursorProviderTurn({
				params: this.params,
				prepared,
				sdkEventDebug: this.sdkEventDebug,
				sdkAbortErrorSuppression,
				throwIfAborted: () => this.throwIfAborted(),
			});
			const { send } = sendResult;

			if (prepared.liveRun) {
				liveCompletion = runFinalizer.startLiveRunCompletion({
					send,
					modelId: model.id,
					resolvedApiKey: this.resolvedApiKey,
					discardIncompleteTools: (outcome) => this.discardIncompleteTools(prepared, outcome),
				});
				const liveResult = await emitCursorLiveTurn({
					params: this.params,
					send,
					sdkEventDebug: this.sdkEventDebug,
					discardIncompleteTools: (outcome) => this.discardIncompleteTools(prepared, outcome),
				});
				if (liveResult.error) throw liveResult.error;
				return;
			}

			const outcome = await awaitFinalizeCursorRunOutcome({
				run: send.run,
				prepared: send.prepared,
				cursorAgentMessageOffset: send.cursorAgentMessageOffset,
				modelId: model.id,
				signal: options?.signal,
				runResultFallback: send.run.result,
				resolvedApiKey: this.resolvedApiKey,
				optionsApiKey: options?.apiKey,
				sdkEventDebug: this.sdkEventDebug,
				contextWindowAgentId: prepared.agent.agentId,
			});
			await emitCursorDirectOutcome({
				params: this.params,
				send,
				outcome,
			});
		} catch (error) {
			this.sdkEventDebug?.recordError("provider_stream", error);
			this.discardIncompleteTools(prepared, {
				status: error instanceof CursorLiveRunAbortError ? "cancelled" : "error",
				signalAborted: error instanceof CursorLiveRunAbortError,
			});
			const activeLiveRun = prepared?.liveRun;
			if (activeLiveRun && !activeLiveRun.disposed) {
				await cursorLiveRuns.release(activeLiveRun);
			} else {
				await abandonSessionCursorAgent(prepared?.sessionAgentScopeKey);
			}
			if (error instanceof CursorLiveRunAbortError) {
				sdkAbortErrorSuppression.suppressAbortErrors();
				this.pushSanitizedStreamError(error, "aborted");
			} else {
				this.pushSanitizedStreamError(error, "error");
			}
		} finally {
			await this.cleanupTurn(sdkAbortErrorSuppression, prepared, sendResult, liveCompletion, runFinalizer);
		}
	}

	private async cleanupTurn(
		sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>,
		prepared: CursorProviderTurnPrepared | undefined,
		sendResult: CursorProviderTurnSendResult | undefined,
		liveCompletion: CursorLiveRunCompletion | undefined,
		runFinalizer: CursorRunFinalizer | undefined,
	): Promise<void> {
		prepared?.restoreCursorSdkOutputFilter();
		const abortRegistration = sendResult?.abortRegistration;
		if (abortRegistration) {
			abortRegistration.signal.removeEventListener("abort", abortRegistration.listener);
		}
		if (runFinalizer) {
			await runFinalizer.cleanup(liveCompletion);
			return;
		}
		this.params.sdkEventDebugRef.current = undefined;
		sdkAbortErrorSuppression.dispose();
	}

	async handleOuterCatch(error: unknown): Promise<void> {
		this.pushSanitizedStreamError(error, error instanceof CursorLiveRunAbortError ? "aborted" : "error");
	}
}
