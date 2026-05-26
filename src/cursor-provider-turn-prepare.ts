import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Agent } from "@cursor/sdk";
import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";
import { installCursorSdkOutputFilter, suppressCursorSdkOutput } from "./cursor-sdk-output-filter.js";
import {
	acquireSessionCursorAgent,
	buildCursorSessionSendPrompt,
	planCursorSessionSend,
	resetSessionCursorAgent,
} from "./cursor-session-agent.js";
import type { CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge.js";
import { estimateCursorPromptInputTokens, getCursorPromptOptions } from "./cursor-usage-accounting.js";
import { getActiveContextToolNames } from "./cursor-context-tools.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { createCursorNativeReplayId } from "./cursor-provider-live-run-drain.js";
import { getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getEffectiveCursorSettingSources } from "./cursor-setting-sources.js";
import { isCursorNativeToolDisplayRuntimeEnabled } from "./cursor-native-tool-display.js";
import { MISSING_CURSOR_API_KEY_MESSAGE } from "./cursor-provider-errors.js";
import { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import { resolveCursorApiKey } from "./cursor-provider-turn-api-key.js";
import type {
	CursorProviderTurnPrepared,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnRuntime,
} from "./cursor-provider-turn-types.js";

export interface PrepareCursorProviderTurnParams {
	params: CursorProviderTurnRunnerParams;
	runtime: CursorProviderTurnRuntime;
	cwd: string;
	resolvedApiKey: string;
	throwIfAborted: () => void;
}

export async function prepareCursorProviderTurn(
	prepareParams: PrepareCursorProviderTurnParams,
): Promise<CursorProviderTurnPrepared> {
	const { params, runtime, cwd, resolvedApiKey, throwIfAborted } = prepareParams;
	const { model, context, options } = params;
	const { sdkEventDebug } = runtime;

	const fastEnabled = getEffectiveFastForModelId(model.id);
	const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);
	const settingSources = getEffectiveCursorSettingSources();

	installCursorMcpToolTimeoutOverride();
	runtime.restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
	const sessionAgentAcquireParams = {
		apiKey: resolvedApiKey,
		cwd,
		modelSelection: selection,
		settingSources,
		debugRecorder: sdkEventDebug,
		onBridgeToolRequest: (request: CursorPiBridgeToolRequest) => {
			if (runtime.liveRunForBridgeQueue && !runtime.liveRunForBridgeQueue.disposed) {
				cursorLiveRuns.queueEvent(runtime.liveRunForBridgeQueue, { type: "bridge-tool", request });
			} else {
				runtime.queuedBridgeRequestsBeforeLiveRun.push(request);
			}
		},
		createAgent: (createOptions: Parameters<typeof Agent.create>[0]) =>
			suppressCursorSdkOutput(() => Agent.create(createOptions)),
	};
	let sessionAgentLease = await acquireSessionCursorAgent(sessionAgentAcquireParams);
	runtime.sessionAgentScopeKey = sessionAgentLease.scopeKey;
	throwIfAborted();

	const promptOptions = getCursorPromptOptions(model);
	let sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
	let prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
	if (sendPlan.resetAgent) {
		await resetSessionCursorAgent(sessionAgentLease.scopeKey);
		sessionAgentLease = await acquireSessionCursorAgent(sessionAgentAcquireParams);
		runtime.sessionAgentScopeKey = sessionAgentLease.scopeKey;
		sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);
		prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
	}
	const bootstrap = sendPlan.mode === "bootstrap";
	const agent = sessionAgentLease.agent;
	const bridgeRun = sessionAgentLease.bridgeRun;
	const sendPayload = {
		text: prompt.text,
		images: prompt.images.length > 0 ? prompt.images : undefined,
	};
	const sessionBridgeRun = bridgeRun;
	const promptInputTokens = estimateCursorPromptInputTokens(prompt, promptOptions);
	const useNativeToolReplay = isCursorNativeToolDisplayRuntimeEnabled();
	const activeToolNames = getActiveContextToolNames(context);
	sdkEventDebug?.recordProviderMeta({
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
		sessionAgentScopeKey: runtime.sessionAgentScopeKey,
		bridgeRunId: bridgeRun?.id,
	});
	const nativeReplayId = createCursorNativeReplayId();
	const textDeltas: string[] = [];
	const useLiveRun = useNativeToolReplay || bridgeRun !== undefined;
	const liveRun = useLiveRun
		? cursorLiveRuns.start({
				id: useNativeToolReplay ? nativeReplayId : bridgeRun?.id ?? nativeReplayId,
				agent,
				bridgeRun,
				sessionBridgeRun,
				sessionAgentScopeKey: runtime.sessionAgentScopeKey,
				promptInputTokens,
				textDeltas,
				debugRecorder: sdkEventDebug,
			})
		: undefined;
	if (liveRun) {
		runtime.activeLiveRun = liveRun;
		runtime.liveRunForBridgeQueue = liveRun;
		for (const request of runtime.queuedBridgeRequestsBeforeLiveRun.splice(0)) {
			cursorLiveRuns.queueEvent(liveRun, { type: "bridge-tool", request });
		}
	}
	const turnCoordinator = new CursorSdkTurnCoordinator({
		stream: params.stream,
		partial: params.partial,
		cwd,
		resolvedApiKey,
		liveRun,
		useNativeToolReplay,
		activeToolNames,
		nativeReplayId,
		textDeltas,
		debugRecorder: sdkEventDebug,
	});
	runtime.turnCoordinatorForCleanup = turnCoordinator;

	return {
		cwd,
		sessionAgentLease,
		agent,
		bridgeRun,
		sendPlan,
		prompt,
		sendPayload,
		bootstrap,
		promptInputTokens,
		useNativeToolReplay,
		activeToolNames,
		nativeReplayId,
		textDeltas,
		liveRun,
		turnCoordinator,
	};
}

export function requireCursorApiKey(options: SimpleStreamOptions | undefined): string {
	const apiKey = resolveCursorApiKey(options?.apiKey);
	if (!apiKey) throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
	return apiKey;
}
