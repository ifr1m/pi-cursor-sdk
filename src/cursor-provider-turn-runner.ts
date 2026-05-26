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
	discardIncompleteToolsFromRuntime,
	emitCursorDirectOutcome,
	emitCursorLiveTurn,
} from "./cursor-provider-turn-emit.js";
import { prepareCursorProviderTurn, requireCursorApiKey } from "./cursor-provider-turn-prepare.js";
import { sendCursorProviderTurn } from "./cursor-provider-turn-send.js";
import {
	createCursorProviderTurnRuntime,
	type CursorProviderTurnRunnerParams,
	type CursorProviderTurnRuntime,
} from "./cursor-provider-turn-types.js";

export { resolveCursorApiKey } from "./cursor-provider-turn-api-key.js";
export type { CursorProviderTurnRunnerParams } from "./cursor-provider-turn-types.js";

export class CursorProviderTurnRunner {
	private readonly runtime: CursorProviderTurnRuntime = createCursorProviderTurnRuntime();

	constructor(private readonly params: CursorProviderTurnRunnerParams) {}

	private get options() {
		return this.params.options;
	}

	private get sdkEventDebug() {
		return this.runtime.sdkEventDebug;
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
				: sanitizeCursorProviderError(error, this.runtime.resolvedApiKey ?? options?.apiKey);
		this.params.stream.push({ type: "error", reason, error: partial });
	}

	private discardIncompleteTools(
		outcome: import("./cursor-incomplete-tool-visibility.js").IncompleteCursorToolRunOutcomeInput,
	): void {
		discardIncompleteToolsFromRuntime(this.runtime, outcome);
	}

	private async finalizeSdkEventDebug(): Promise<void> {
		this.sdkEventDebug?.recordFinalPartial(this.params.partial);
		await this.sdkEventDebug?.finalize();
	}

	async run(sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>): Promise<void> {
		const { stream, partial, model, context, options, sdkEventDebugRef } = this.params;

		try {
			stream.push({ type: "start", partial });
			this.throwIfAborted();
			const cwd = getCursorSessionCwd();
			this.runtime.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
			});
			sdkEventDebugRef.current = this.runtime.sdkEventDebug;
			this.sdkEventDebug?.recordContextSnapshot(context);
			if (
				(await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug)) ===
				"stream_ended"
			) {
				await this.finalizeSdkEventDebug();
				sdkEventDebugRef.current = undefined;
				return;
			}

			this.runtime.resolvedApiKey = requireCursorApiKey(options);
			const prepared = await prepareCursorProviderTurn({
				params: this.params,
				runtime: this.runtime,
				cwd,
				resolvedApiKey: this.runtime.resolvedApiKey,
				throwIfAborted: () => this.throwIfAborted(),
			});
			const sent = await sendCursorProviderTurn({
				params: this.params,
				runtime: this.runtime,
				prepared,
				sdkAbortErrorSuppression,
				throwIfAborted: () => this.throwIfAborted(),
			});

			if (prepared.liveRun) {
				await emitCursorLiveTurn({
					params: this.params,
					runtime: this.runtime,
					send: sent,
					sdkAbortErrorSuppression,
					discardIncompleteTools: (outcome) => this.discardIncompleteTools(outcome),
					finalizeSdkEventDebug: () => this.finalizeSdkEventDebug(),
				});
				return;
			}

			const outcome = await awaitFinalizeCursorRunOutcome({
				run: sent.run,
				prepared: sent.prepared,
				cursorAgentMessageOffset: sent.cursorAgentMessageOffset,
				modelId: model.id,
				signalAborted: options?.signal?.aborted,
				runResultFallback: sent.run.result,
				resolvedApiKey: this.runtime.resolvedApiKey,
				optionsApiKey: options?.apiKey,
				sdkEventDebug: this.runtime.sdkEventDebug,
				contextWindowAgentId: prepared.agent.agentId,
			});
			await emitCursorDirectOutcome({
				params: this.params,
				runtime: this.runtime,
				send: sent,
				outcome,
			});
		} catch (error) {
			this.runtime.sdkEventDebug?.recordError("provider_stream", error);
			this.discardIncompleteTools({
				status: error instanceof CursorLiveRunAbortError ? "cancelled" : "error",
				signalAborted: error instanceof CursorLiveRunAbortError,
			});
			if (this.runtime.activeLiveRun && !this.runtime.activeLiveRun.disposed) {
				await cursorLiveRuns.release(this.runtime.activeLiveRun);
			} else {
				await abandonSessionCursorAgent(this.runtime.sessionAgentScopeKey);
			}
			if (error instanceof CursorLiveRunAbortError) {
				sdkAbortErrorSuppression.suppressAbortErrors();
				this.pushSanitizedStreamError(error, "aborted");
			} else {
				this.pushSanitizedStreamError(error, "error");
			}
		} finally {
			await this.cleanup(sdkAbortErrorSuppression);
		}
	}

	private async cleanup(sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>): Promise<void> {
		if (!this.runtime.deferSdkEventDebugFinalize) {
			try {
				await this.finalizeSdkEventDebug();
			} finally {
				sdkAbortErrorSuppression.dispose();
			}
		}
		this.params.sdkEventDebugRef.current = undefined;
		this.runtime.restoreCursorSdkOutputFilter?.();
		if (this.runtime.abortSignal && this.runtime.abortListener) {
			this.runtime.abortSignal.removeEventListener("abort", this.runtime.abortListener);
		}
	}

	async handleOuterCatch(error: unknown): Promise<void> {
		if (this.runtime.activeLiveRun && !this.runtime.activeLiveRun.disposed) {
			await cursorLiveRuns.release(this.runtime.activeLiveRun).catch(() => {});
		} else {
			await abandonSessionCursorAgent(this.runtime.sessionAgentScopeKey).catch(() => {});
		}
		this.pushSanitizedStreamError(error, error instanceof CursorLiveRunAbortError ? "aborted" : "error");
	}
}
