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
	discardIncompleteToolsFromCleanup,
	emitCursorDirectOutcome,
	emitCursorLiveTurn,
} from "./cursor-provider-turn-emit.js";
import { prepareCursorProviderTurn, requireCursorApiKey } from "./cursor-provider-turn-prepare.js";
import { sendCursorProviderTurn } from "./cursor-provider-turn-send.js";
import {
	createCursorProviderTurnCleanup,
	type CursorProviderTurnCleanup,
	type CursorProviderTurnRunnerParams,
} from "./cursor-provider-turn-types.js";

export { resolveCursorApiKey } from "./cursor-provider-turn-api-key.js";
export type { CursorProviderTurnRunnerParams } from "./cursor-provider-turn-types.js";

export class CursorProviderTurnRunner {
	private readonly cleanup: CursorProviderTurnCleanup = createCursorProviderTurnCleanup();

	constructor(private readonly params: CursorProviderTurnRunnerParams) {}

	private get options() {
		return this.params.options;
	}

	private get sdkEventDebug() {
		return this.cleanup.sdkEventDebug;
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
				: sanitizeCursorProviderError(error, this.cleanup.resolvedApiKey ?? options?.apiKey);
		this.params.stream.push({ type: "error", reason, error: partial });
	}

	private discardIncompleteTools(
		outcome: import("./cursor-incomplete-tool-visibility.js").IncompleteCursorToolRunOutcomeInput,
	): void {
		discardIncompleteToolsFromCleanup(this.cleanup, outcome);
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
			this.cleanup.sdkEventDebug = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: model.id,
				provider: model.provider,
			});
			sdkEventDebugRef.current = this.cleanup.sdkEventDebug;
			this.sdkEventDebug?.recordContextSnapshot(context);
			if (
				(await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug)) ===
				"stream_ended"
			) {
				await this.finalizeSdkEventDebug();
				sdkEventDebugRef.current = undefined;
				return;
			}

			this.cleanup.resolvedApiKey = requireCursorApiKey(options);
			const { prepared, handles: prepareHandles } = await prepareCursorProviderTurn({
				params: this.params,
				cwd,
				resolvedApiKey: this.cleanup.resolvedApiKey,
				sdkEventDebug: this.cleanup.sdkEventDebug,
				throwIfAborted: () => this.throwIfAborted(),
				registerPrepareHandles: (partial) => {
					this.cleanup.prepare = { ...this.cleanup.prepare, ...partial };
				},
			});
			this.cleanup.prepare = { ...this.cleanup.prepare, ...prepareHandles };

			const { send, handles: sendHandles } = await sendCursorProviderTurn({
				params: this.params,
				prepared,
				sdkEventDebug: this.cleanup.sdkEventDebug,
				sdkAbortErrorSuppression,
				throwIfAborted: () => this.throwIfAborted(),
				registerSendHandles: (partial) => {
					this.cleanup.send = { ...this.cleanup.send, ...partial };
				},
			});
			this.cleanup.send = sendHandles;

			if (prepared.liveRun) {
				await emitCursorLiveTurn({
					params: this.params,
					cleanup: this.cleanup,
					send,
					sdkAbortErrorSuppression,
					discardIncompleteTools: (outcome) => this.discardIncompleteTools(outcome),
					finalizeSdkEventDebug: () => this.finalizeSdkEventDebug(),
				});
				return;
			}

			const outcome = await awaitFinalizeCursorRunOutcome({
				run: send.run,
				prepared: send.prepared,
				cursorAgentMessageOffset: send.cursorAgentMessageOffset,
				modelId: model.id,
				signal: options?.signal,
				runResultFallback: send.run.result,
				resolvedApiKey: this.cleanup.resolvedApiKey,
				optionsApiKey: options?.apiKey,
				sdkEventDebug: this.cleanup.sdkEventDebug,
				contextWindowAgentId: prepared.agent.agentId,
			});
			await emitCursorDirectOutcome({
				params: this.params,
				cleanup: this.cleanup,
				send,
				outcome,
			});
		} catch (error) {
			this.cleanup.sdkEventDebug?.recordError("provider_stream", error);
			this.discardIncompleteTools({
				status: error instanceof CursorLiveRunAbortError ? "cancelled" : "error",
				signalAborted: error instanceof CursorLiveRunAbortError,
			});
			const activeLiveRun = this.cleanup.prepare?.activeLiveRun;
			if (activeLiveRun && !activeLiveRun.disposed) {
				await cursorLiveRuns.release(activeLiveRun);
			} else {
				await abandonSessionCursorAgent(this.cleanup.prepare?.sessionAgentScopeKey ?? "");
			}
			if (error instanceof CursorLiveRunAbortError) {
				sdkAbortErrorSuppression.suppressAbortErrors();
				this.pushSanitizedStreamError(error, "aborted");
			} else {
				this.pushSanitizedStreamError(error, "error");
			}
		} finally {
			await this.cleanupTurn(sdkAbortErrorSuppression);
		}
	}

	private async cleanupTurn(
		sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>,
	): Promise<void> {
		if (!this.cleanup.deferSdkEventDebugFinalize) {
			try {
				await this.finalizeSdkEventDebug();
			} finally {
				sdkAbortErrorSuppression.dispose();
			}
		}
		this.params.sdkEventDebugRef.current = undefined;
		this.cleanup.prepare?.restoreCursorSdkOutputFilter?.();
		const abortRegistration = this.cleanup.send?.abortRegistration;
		if (abortRegistration) {
			abortRegistration.signal.removeEventListener("abort", abortRegistration.listener);
		}
	}

	async handleOuterCatch(error: unknown): Promise<void> {
		const activeLiveRun = this.cleanup.prepare?.activeLiveRun;
		if (activeLiveRun && !activeLiveRun.disposed) {
			await cursorLiveRuns.release(activeLiveRun).catch(() => {});
		} else {
			await abandonSessionCursorAgent(this.cleanup.prepare?.sessionAgentScopeKey ?? "").catch(() => {});
		}
		this.pushSanitizedStreamError(error, error instanceof CursorLiveRunAbortError ? "aborted" : "error");
	}
}
