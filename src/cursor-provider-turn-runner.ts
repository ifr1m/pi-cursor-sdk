import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Agent, createAgentPlatform } from "@cursor/sdk";
import type { RunResult, SDKAgent } from "@cursor/sdk";
import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./cursor-sdk-output-filter.js";
import {
	acquireSessionCursorAgent,
	buildCursorSessionSendPrompt,
	planCursorSessionSend,
	resetSessionCursorAgent,
	type SessionCursorAgentLease,
} from "./cursor-session-agent.js";
import type { CursorPiBridgeToolRequest, CursorPiToolBridgeRun } from "./cursor-pi-tool-bridge.js";
import { applyCursorApproximateUsage, estimateCursorPromptInputTokens, getCursorPromptOptions } from "./cursor-usage-accounting.js";
import { getCursorSessionCwd } from "./cursor-session-cwd.js";
import { getActiveContextToolNames } from "./cursor-context-tools.js";
import { CursorLiveRunAbortError, type CursorLiveRun } from "./cursor-live-run-coordinator.js";
import {
	abandonSessionCursorAgent,
	createCursorNativeReplayId,
	cursorLiveRuns,
	drainCursorLiveRunTurn,
	drainExistingCursorLiveRunBeforeSend,
	flushPendingCursorLiveRunTraceEventsToStream,
	settleCursorLiveToolBatch,
} from "./cursor-provider-live-run-drain.js";
import { getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import { isCursorNativeToolDisplayRuntimeEnabled } from "./cursor-native-tool-display.js";
import {
	formatCursorSdkAbortMessage,
	MISSING_CURSOR_API_KEY_MESSAGE,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "./cursor-provider-errors.js";
import { getEffectiveCursorSettingSources } from "./cursor-setting-sources.js";
import { hasUsableText } from "./cursor-record-utils.js";
import {
	countCursorAgentMessages,
	loadCursorTranscriptWebToolCallsAfterOffset,
} from "./cursor-agent-message-web-tools.js";
import { installCursorSdkAbortErrorSuppression } from "./cursor-sdk-abort-error-guard.js";
import {
	buildIncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcomeInput,
} from "./cursor-incomplete-tool-visibility.js";
import {
	classifyCursorRunDirectEmission,
	classifyCursorRunLiveEmission,
	isCursorRunFinishedSuccessfully,
	resolveCursorRunOutcome,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";

const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (trimmed === CURSOR_API_KEY_ENV_VAR) return process.env.CURSOR_API_KEY?.trim();
	return trimmed;
}

async function cacheSdkContextWindow(agentId: string, modelId: string): Promise<void> {
	try {
		const platform = await createAgentPlatform();
		const checkpoint = await platform.checkpointStore.loadLatest(agentId);
		const contextWindow = getCheckpointContextWindow(checkpoint);
		if (contextWindow) saveCachedContextWindow(modelId, contextWindow);
	} catch {
		// Context-window cache failures must not affect response streaming.
	}
}

export type CursorProviderTurnRunnerResult =
	| { kind: "pre_send_stream_ended" }
	| { kind: "live_turn_handoff" }
	| { kind: "direct_turn_completed" };

export interface CursorProviderTurnRunnerParams {
	model: Model<Api>;
	context: Context;
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	options?: SimpleStreamOptions;
	sdkEventDebug?: CursorSdkEventDebugSink;
	sdkEventDebugRef: { current?: CursorSdkEventDebugSink };
}

interface CursorProviderTurnPrepared {
	cwd: string;
	sessionAgentLease: SessionCursorAgentLease;
	bridgeRun: CursorPiToolBridgeRun | undefined;
	sendPlan: ReturnType<typeof planCursorSessionSend>;
	bootstrap: boolean;
	promptInputTokens: number;
	useNativeToolReplay: boolean;
	activeToolNames: ReadonlySet<string> | undefined;
	nativeReplayId: string;
	textDeltas: string[];
	liveRun: CursorLiveRun | undefined;
	turnCoordinator: CursorSdkTurnCoordinator;
	cursorAgentMessageOffset: number | undefined;
}

interface CursorProviderTurnSend {
	run: Awaited<ReturnType<SDKAgent["send"]>>;
	prepared: CursorProviderTurnPrepared;
}

export class CursorProviderTurnRunner {
	private agent: SDKAgent | null = null;
	private activeLiveRun: CursorLiveRun | undefined;
	private bridgeRun: CursorPiToolBridgeRun | undefined;
	private liveRunForBridgeQueue: CursorLiveRun | undefined;
	private readonly queuedBridgeRequestsBeforeLiveRun: CursorPiBridgeToolRequest[] = [];
	private resolvedApiKey: string | undefined;
	private sessionAgentScopeKey = "";
	private abortSignal: AbortSignal | undefined;
	private abortListener: (() => void) | undefined;
	private restoreCursorSdkOutputFilter: (() => void) | undefined;
	private deferSdkEventDebugFinalize = false;
	private turnCoordinatorForCleanup: CursorSdkTurnCoordinator | undefined;
	private sdkRun: Awaited<ReturnType<SDKAgent["send"]>> | null = null;

	constructor(private readonly params: CursorProviderTurnRunnerParams) {}

	private get options(): SimpleStreamOptions | undefined {
		return this.params.options;
	}

	private get sdkEventDebug(): CursorSdkEventDebugSink | undefined {
		return this.params.sdkEventDebug;
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

	private discardIncompleteTools(outcome: IncompleteCursorToolRunOutcomeInput): void {
		this.turnCoordinatorForCleanup?.discardIncompleteStartedToolCalls(buildIncompleteCursorToolRunOutcome(outcome));
	}

	private async getCursorAgentMessageOffset(agentId: string, cwd: string): Promise<number | undefined> {
		try {
			return await countCursorAgentMessages(agentId, cwd);
		} catch (error) {
			this.sdkEventDebug?.recordError("cursor_agent_message_count", error);
			return undefined;
		}
	}

	private async replayCursorTranscriptWebToolCalls(
		agentId: string,
		cwd: string,
		messageOffset: number | undefined,
		turnCoordinator: CursorSdkTurnCoordinator,
	): Promise<void> {
		try {
			const transcriptToolCalls = await loadCursorTranscriptWebToolCallsAfterOffset({
				agentId,
				cwd,
				offset: messageOffset,
			});
			if (transcriptToolCalls.length === 0) return;
			this.sdkEventDebug?.recordCoordinatorEvent("cursor-transcript-web-tools", {
				agentId,
				messageOffset,
				count: transcriptToolCalls.length,
			});
			turnCoordinator.handleTranscriptCompletedToolCalls(transcriptToolCalls);
		} catch (error) {
			this.sdkEventDebug?.recordError("cursor_transcript_web_tools", error);
		}
	}

	private buildRunOutcomeFromWait(
		waitResult: RunResult,
		prepared: CursorProviderTurnPrepared,
		runResultFallback?: string,
	): CursorRunOutcome {
		const { turnCoordinator, textDeltas, liveRun } = prepared;
		return resolveCursorRunOutcome({
			waitResult,
			signalAborted: this.options?.signal?.aborted,
			textDeltas: liveRun?.textDeltas ?? textDeltas,
			emittedText: liveRun?.emittedText ?? textDeltas.join(""),
			planTextCandidate: turnCoordinator.planTextCandidate,
			selectFinalTextOptions: liveRun ? undefined : { allowPartialPrefix: true },
			runResultFallback,
			resolvedApiKey: this.resolvedApiKey,
			optionsApiKey: this.options?.apiKey,
		});
	}

	private async finalizeRunArtifacts(
		run: Awaited<ReturnType<SDKAgent["send"]>>,
		prepared: CursorProviderTurnPrepared,
		runResultFallback?: string,
	): Promise<CursorRunOutcome> {
		const waitResult = await run.wait();
		this.sdkEventDebug?.recordWaitResult(waitResult);
		const outcome = this.buildRunOutcomeFromWait(waitResult, prepared, runResultFallback);
		if (isCursorRunFinishedSuccessfully(outcome)) {
			await this.replayCursorTranscriptWebToolCalls(
				run.agentId,
				prepared.cwd,
				prepared.cursorAgentMessageOffset,
				prepared.turnCoordinator,
			);
		}
		prepared.turnCoordinator.discardIncompleteStartedToolCalls(outcome.incompleteTools);
		await this.sdkEventDebug?.captureRunArtifacts(run);
		return outcome;
	}

	async run(sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>): Promise<CursorProviderTurnRunnerResult> {
		const { stream, partial, model, context, options, sdkEventDebugRef } = this.params;

		try {
			this.throwIfAborted();
			stream.push({ type: "start", partial });
			this.sdkEventDebug?.recordContextSnapshot(context);

			const cwd = getCursorSessionCwd();
			if (
				(await drainExistingCursorLiveRunBeforeSend(stream, partial, model, context, options?.signal, this.sdkEventDebug)) ===
				"stream_ended"
			) {
				await this.finalizeSdkEventDebug();
				sdkEventDebugRef.current = undefined;
				return { kind: "pre_send_stream_ended" };
			}

			const prepared = await this.prepareTurn(cwd);
			const sent = await this.sendRun(prepared, sdkAbortErrorSuppression);

			if (prepared.liveRun) {
				await this.emitLiveTurn(sent, sdkAbortErrorSuppression);
				this.agent = null;
				return { kind: "live_turn_handoff" };
			}

			const outcome = await this.awaitRunOutcome(sent);
			await this.emitDirectOutcome(outcome, sent);
			return { kind: "direct_turn_completed" };
		} catch (error) {
			this.sdkEventDebug?.recordError("provider_stream", error);
			this.discardIncompleteTools({
				status: error instanceof CursorLiveRunAbortError ? "cancelled" : "error",
				signalAborted: error instanceof CursorLiveRunAbortError,
			});
			if (this.activeLiveRun && !this.activeLiveRun.disposed) await cursorLiveRuns.release(this.activeLiveRun);
			else await abandonSessionCursorAgent(this.sessionAgentScopeKey);
			if (error instanceof CursorLiveRunAbortError) {
				sdkAbortErrorSuppression.suppressAbortErrors();
				this.pushSanitizedStreamError(error, "aborted");
			} else {
				this.pushSanitizedStreamError(error, "error");
			}
			return { kind: "direct_turn_completed" };
		} finally {
			await this.cleanup(sdkAbortErrorSuppression);
		}
	}

	private async prepareTurn(cwd: string): Promise<CursorProviderTurnPrepared> {
		const { model, context, options } = this.params;
		this.throwIfAborted();

		const apiKey = resolveCursorApiKey(options?.apiKey);
		if (!apiKey) throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
		this.resolvedApiKey = apiKey;

		const fastEnabled = getEffectiveFastForModelId(model.id);
		const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);
		const settingSources = getEffectiveCursorSettingSources();

		installCursorMcpToolTimeoutOverride();
		this.restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
		const sessionAgentAcquireParams = {
			apiKey,
			cwd,
			modelSelection: selection,
			settingSources,
			debugRecorder: this.sdkEventDebug,
			onBridgeToolRequest: (request: CursorPiBridgeToolRequest) => {
				if (this.liveRunForBridgeQueue && !this.liveRunForBridgeQueue.disposed) {
					cursorLiveRuns.queueEvent(this.liveRunForBridgeQueue, { type: "bridge-tool", request });
				} else {
					this.queuedBridgeRequestsBeforeLiveRun.push(request);
				}
			},
			createAgent: (createOptions: Parameters<typeof Agent.create>[0]) =>
				suppressCursorSdkOutput(() => Agent.create(createOptions)),
		};
		let sessionAgentLease = await acquireSessionCursorAgent(sessionAgentAcquireParams);
		this.sessionAgentScopeKey = sessionAgentLease.scopeKey;
		this.agent = sessionAgentLease.agent;
		this.bridgeRun = sessionAgentLease.bridgeRun;
		this.throwIfAborted();

		const promptOptions = getCursorPromptOptions(model);
		let sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
		let prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		if (sendPlan.resetAgent) {
			await resetSessionCursorAgent(sessionAgentLease.scopeKey);
			sessionAgentLease = await acquireSessionCursorAgent(sessionAgentAcquireParams);
			this.sessionAgentScopeKey = sessionAgentLease.scopeKey;
			this.agent = sessionAgentLease.agent;
			this.bridgeRun = sessionAgentLease.bridgeRun;
			sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
			prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		}
		const bootstrap = sendPlan.mode === "bootstrap";
		const sessionBridgeRun = sessionAgentLease.bridgeRun;
		const promptInputTokens = estimateCursorPromptInputTokens(prompt, promptOptions);
		const useNativeToolReplay = isCursorNativeToolDisplayRuntimeEnabled();
		const activeToolNames = getActiveContextToolNames(context);
		this.sdkEventDebug?.recordProviderMeta({
			model: {
				id: model.id,
				provider: model.provider,
				api: model.api,
				reasoning: options?.reasoning ?? "off",
				fastEnabled,
				selection,
			},
			settingSources: settingSources ?? null,
			sendState: sessionAgentLease.sendState,
			sendPlan,
			promptOptions,
			activeToolNames: activeToolNames ? [...activeToolNames] : [],
			sessionAgentScopeKey: this.sessionAgentScopeKey,
			bridgeRunId: this.bridgeRun?.id,
		});
		const nativeReplayId = createCursorNativeReplayId();
		const textDeltas: string[] = [];
		const useLiveRun = useNativeToolReplay || this.bridgeRun !== undefined;
		const liveRun: CursorLiveRun | undefined = useLiveRun
			? cursorLiveRuns.start({
					id: useNativeToolReplay ? nativeReplayId : this.bridgeRun!.id,
					agent: this.agent!,
					bridgeRun: this.bridgeRun,
					sessionBridgeRun,
					sessionAgentScopeKey: this.sessionAgentScopeKey,
					promptInputTokens,
					textDeltas,
					debugRecorder: this.sdkEventDebug,
				})
			: undefined;
		if (liveRun) {
			this.activeLiveRun = liveRun;
			this.liveRunForBridgeQueue = liveRun;
			for (const request of this.queuedBridgeRequestsBeforeLiveRun.splice(0)) {
				cursorLiveRuns.queueEvent(liveRun, { type: "bridge-tool", request });
			}
		}
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream: this.params.stream,
			partial: this.params.partial,
			cwd,
			resolvedApiKey: this.resolvedApiKey,
			liveRun,
			useNativeToolReplay,
			activeToolNames,
			nativeReplayId,
			textDeltas,
			debugRecorder: this.sdkEventDebug,
		});
		this.turnCoordinatorForCleanup = turnCoordinator;

		const cursorAgentMessageOffset = await this.getCursorAgentMessageOffset(this.agent!.agentId, cwd);

		return {
			cwd,
			sessionAgentLease,
			bridgeRun: this.bridgeRun,
			sendPlan,
			bootstrap,
			promptInputTokens,
			useNativeToolReplay,
			activeToolNames,
			nativeReplayId,
			textDeltas,
			liveRun,
			turnCoordinator,
			cursorAgentMessageOffset,
		};
	}

	private async sendRun(
		prepared: CursorProviderTurnPrepared,
		sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>,
	): Promise<CursorProviderTurnSend> {
		const { model, context, options } = this.params;
		const { turnCoordinator, sendPlan, bootstrap, liveRun } = prepared;

		this.sdkRun = null;
		this.abortListener = () => {
			sdkAbortErrorSuppression.suppressAbortErrors();
			this.activeLiveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
			if (this.sdkRun) {
				this.sdkRun.cancel().catch(() => {});
			}
		};
		this.abortSignal = options?.signal;
		this.abortSignal?.addEventListener("abort", this.abortListener, { once: true });

		this.throwIfAborted();
		const promptOptions = getCursorPromptOptions(model);
		const prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		this.sdkEventDebug?.recordSendMeta({
			mode: sendPlan.mode,
			reason: sendPlan.reason,
			resetAgent: sendPlan.resetAgent,
			bootstrap,
			promptText: prompt.text,
			imageCount: prompt.images.length,
			useNativeToolReplay: prepared.useNativeToolReplay,
			bridgeEnabled: prepared.bridgeRun !== undefined,
			nativeReplayId: prepared.nativeReplayId,
			promptInputTokens: prepared.promptInputTokens,
		});
		const sendPayload = {
			text: prompt.text,
			images: prompt.images.length > 0 ? prompt.images : undefined,
		};
		this.sdkEventDebug?.recordSendPayload(sendPayload);
		this.sdkEventDebug?.recordProviderEvent("agent_send_start", sendPayload);
		const run = await this.agent!.send(sendPayload, {
			onDelta: (args) => {
				this.sdkEventDebug?.recordOnDelta(args.update);
				turnCoordinator.handleDelta(args.update);
			},
			onStep: (args) => {
				this.sdkEventDebug?.recordOnStep(args.step);
				turnCoordinator.handleStep(args.step);
			},
		});
		this.sdkRun = run;
		this.sdkEventDebug?.recordRunMeta({
			runId: run.id,
			agentId: run.agentId,
			status: run.status,
		});
		this.sdkEventDebug?.attachRunStream(run);
		this.sdkEventDebug?.recordProviderEvent("agent_send_returned", {
			runId: run.id,
			agentId: run.agentId,
			status: run.status,
		});
		if (liveRun) cursorLiveRuns.attachSdkRun(liveRun, run);
		if (options?.signal?.aborted) {
			sdkAbortErrorSuppression.suppressAbortErrors();
			liveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
			await run.cancel().catch(() => {});
			throw new CursorLiveRunAbortError();
		}

		return { run, prepared };
	}

	private async awaitRunOutcome(send: CursorProviderTurnSend): Promise<CursorRunOutcome> {
		const outcome = await this.finalizeRunArtifacts(send.run, send.prepared, send.run.result);
		await cacheSdkContextWindow(this.agent!.agentId, this.params.model.id);
		return outcome;
	}

	private applyLiveRunOutcome(
		liveRun: CursorLiveRun,
		outcome: CursorRunOutcome,
		sessionAgentLease: SessionCursorAgentLease,
		bootstrap: boolean,
	): void {
		switch (classifyCursorRunLiveEmission(outcome)) {
			case "finished":
				sessionAgentLease.commitSend(this.params.context, bootstrap);
				cursorLiveRuns.markFinished(liveRun, outcome.finalText);
				break;
			case "cancelled":
				cursorLiveRuns.markCancelled(liveRun, outcome.abortMessage);
				break;
			case "failed":
				cursorLiveRuns.markError(liveRun, outcome.errorMessage);
				break;
		}
	}

	private async emitLiveTurn(
		send: CursorProviderTurnSend,
		sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>,
	): Promise<void> {
		const { run, prepared } = send;
		const { liveRun, turnCoordinator, sessionAgentLease, bootstrap } = prepared;
		if (!liveRun) return;

		this.deferSdkEventDebugFinalize = true;
		const activeSessionAgentLease = sessionAgentLease;

		const waitCompletion = run
			.wait()
			.then(async (waitResult) => {
				const outcome = this.buildRunOutcomeFromWait(waitResult, prepared, run.result);
				this.sdkEventDebug?.recordWaitResult(waitResult);
				if (isCursorRunFinishedSuccessfully(outcome)) {
					await this.replayCursorTranscriptWebToolCalls(
						run.agentId,
						prepared.cwd,
						prepared.cursorAgentMessageOffset,
						turnCoordinator,
					);
				}
				turnCoordinator.discardIncompleteStartedToolCalls(outcome.incompleteTools);
				await this.sdkEventDebug?.captureRunArtifacts(run);
				if (liveRun.disposed) return;
				await cacheSdkContextWindow(liveRun.agent.agentId, this.params.model.id);
				if (liveRun.disposed) return;
				this.applyLiveRunOutcome(liveRun, outcome, activeSessionAgentLease, bootstrap);
			})
			.catch(async (error: unknown) => {
				this.sdkEventDebug?.recordWaitResult({ status: "error", error: String(error) });
				this.sdkEventDebug?.recordError("run_wait", error);
				this.discardIncompleteTools({ status: "error" });
				await this.sdkEventDebug?.captureRunArtifacts(run);
				if (liveRun.disposed) return;
				cursorLiveRuns.markError(liveRun, sanitizeCursorProviderError(error, this.resolvedApiKey ?? this.options?.apiKey));
			});

		try {
			await cursorLiveRuns.withRunLease(liveRun, this.options?.signal, async () => {
				await cursorLiveRuns.waitForProgress(liveRun, this.options?.signal);
				await settleCursorLiveToolBatch(liveRun);
				turnCoordinator.closeTraceBlock();
				await drainCursorLiveRunTurn(
					this.params.stream,
					this.params.partial,
					this.params.model,
					this.params.context,
					liveRun,
					0,
					{
						mode: "emit",
						signal: this.options?.signal,
						debugRecorder: this.sdkEventDebug,
					},
				);
			});
		} catch (error) {
			if (error instanceof CursorLiveRunAbortError) {
				sdkAbortErrorSuppression.suppressAbortErrors();
				this.discardIncompleteTools({ status: "cancelled", signalAborted: true });
				turnCoordinator.closeTraceBlock();
				flushPendingCursorLiveRunTraceEventsToStream(this.params.stream, this.params.partial, liveRun, {
					includeTracesBehindQueuedTools: true,
				});
				await cursorLiveRuns.release(liveRun);
			}
			throw error;
		} finally {
			this.params.sdkEventDebugRef.current = undefined;
			activeSessionAgentLease.trackRunCompletion(waitCompletion);
			void waitCompletion
				.finally(async () => {
					try {
						await this.finalizeSdkEventDebug();
					} finally {
						sdkAbortErrorSuppression.dispose();
					}
				})
				.catch(() => {});
		}
	}

	private async emitDirectOutcome(outcome: CursorRunOutcome, send: CursorProviderTurnSend): Promise<void> {
		const { prepared } = send;
		const { turnCoordinator, sessionAgentLease, bootstrap, promptInputTokens } = prepared;
		const { stream, partial, model, context } = this.params;

		turnCoordinator.closeTraceBlock();

		switch (classifyCursorRunDirectEmission(outcome)) {
			case "cancelled":
				await abandonSessionCursorAgent(this.sessionAgentScopeKey);
				partial.stopReason = "aborted";
				partial.errorMessage = outcome.abortMessage;
				stream.push({ type: "error", reason: "aborted", error: partial });
				break;
			case "failed":
				await abandonSessionCursorAgent(this.sessionAgentScopeKey);
				partial.stopReason = "error";
				partial.errorMessage = outcome.errorMessage;
				stream.push({ type: "error", reason: "error", error: partial });
				break;
			case "finished":
				sessionAgentLease.commitSend(context, bootstrap);
				turnCoordinator.flushText(hasUsableText(outcome.finalText) ? [outcome.finalText] : []);
				applyCursorApproximateUsage(partial, model, context, promptInputTokens);
				stream.push({ type: "done", reason: "stop", message: partial });
				break;
		}
	}

	private async finalizeSdkEventDebug(): Promise<void> {
		this.sdkEventDebug?.recordFinalPartial(this.params.partial);
		await this.sdkEventDebug?.finalize();
	}

	private async cleanup(sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>): Promise<void> {
		if (!this.deferSdkEventDebugFinalize) {
			try {
				await this.finalizeSdkEventDebug();
			} finally {
				sdkAbortErrorSuppression.dispose();
			}
		}
		this.params.sdkEventDebugRef.current = undefined;
		this.restoreCursorSdkOutputFilter?.();
		if (this.abortSignal && this.abortListener) {
			this.abortSignal.removeEventListener("abort", this.abortListener);
		}
	}

	async handleOuterCatch(error: unknown): Promise<void> {
		if (this.activeLiveRun && !this.activeLiveRun.disposed) await cursorLiveRuns.release(this.activeLiveRun).catch(() => {});
		else await abandonSessionCursorAgent(this.sessionAgentScopeKey).catch(() => {});
		this.pushSanitizedStreamError(error, error instanceof CursorLiveRunAbortError ? "aborted" : "error");
	}
}
