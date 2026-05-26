import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { SDKAgent, SDKImage } from "@cursor/sdk";
import type { CursorPiBridgeToolRequest, CursorPiToolBridgeRun } from "./cursor-pi-tool-bridge.js";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import type { SessionCursorAgentLease } from "./cursor-session-agent.js";
import type { planCursorSessionSend } from "./cursor-session-agent.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import type { CursorPrompt } from "./context.js";

export interface CursorProviderTurnRunnerParams {
	model: Model<Api>;
	context: Context;
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	options?: SimpleStreamOptions;
	sdkEventDebugRef: { current?: CursorSdkEventDebugSink };
}

export interface CursorProviderTurnSendPayload {
	text: string;
	images?: SDKImage[];
}

export interface CursorProviderTurnPrepared {
	cwd: string;
	sessionAgentLease: SessionCursorAgentLease;
	agent: SDKAgent;
	bridgeRun: CursorPiToolBridgeRun | undefined;
	sendPlan: ReturnType<typeof planCursorSessionSend>;
	prompt: CursorPrompt;
	sendPayload: CursorProviderTurnSendPayload;
	bootstrap: boolean;
	promptInputTokens: number;
	useNativeToolReplay: boolean;
	activeToolNames: ReadonlySet<string> | undefined;
	nativeReplayId: string;
	textDeltas: string[];
	liveRun: CursorLiveRun | undefined;
	turnCoordinator: CursorSdkTurnCoordinator;
}

export interface CursorProviderTurnSend {
	run: Awaited<ReturnType<SDKAgent["send"]>>;
	prepared: CursorProviderTurnPrepared;
	cursorAgentMessageOffset: number | undefined;
}

export interface CursorProviderTurnRuntime {
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	resolvedApiKey: string | undefined;
	sessionAgentScopeKey: string;
	activeLiveRun: CursorLiveRun | undefined;
	liveRunForBridgeQueue: CursorLiveRun | undefined;
	queuedBridgeRequestsBeforeLiveRun: CursorPiBridgeToolRequest[];
	abortSignal: AbortSignal | undefined;
	abortListener: (() => void) | undefined;
	restoreCursorSdkOutputFilter: (() => void) | undefined;
	deferSdkEventDebugFinalize: boolean;
	turnCoordinatorForCleanup: CursorSdkTurnCoordinator | undefined;
	sdkRun: Awaited<ReturnType<SDKAgent["send"]>> | null;
}

export function createCursorProviderTurnRuntime(): CursorProviderTurnRuntime {
	return {
		sdkEventDebug: undefined,
		resolvedApiKey: undefined,
		sessionAgentScopeKey: "",
		activeLiveRun: undefined,
		liveRunForBridgeQueue: undefined,
		queuedBridgeRequestsBeforeLiveRun: [],
		abortSignal: undefined,
		abortListener: undefined,
		restoreCursorSdkOutputFilter: undefined,
		deferSdkEventDebugFinalize: false,
		turnCoordinatorForCleanup: undefined,
		sdkRun: null,
	};
}
