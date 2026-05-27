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

/** Concrete handles produced during prepare; owned by runner cleanup. */
export interface CursorProviderTurnPrepareHandles {
	sessionAgentScopeKey: string;
	restoreCursorSdkOutputFilter: () => void;
	activeLiveRun: CursorLiveRun | undefined;
	turnCoordinator: CursorSdkTurnCoordinator;
}

export interface CursorProviderTurnPrepareResult {
	prepared: CursorProviderTurnPrepared;
	handles: CursorProviderTurnPrepareHandles;
}

export interface CursorProviderTurnSend {
	run: Awaited<ReturnType<SDKAgent["send"]>>;
	prepared: CursorProviderTurnPrepared;
	cursorAgentMessageOffset: number | undefined;
}

/** Concrete handles produced during send; owned by runner cleanup. */
export interface CursorProviderTurnSendHandles {
	abortRegistration: { signal: AbortSignal; listener: () => void } | undefined;
}

export interface CursorProviderTurnSendResult {
	send: CursorProviderTurnSend;
	handles: CursorProviderTurnSendHandles;
}

/** Explicit cleanup registry populated as phases complete; not a cross-phase API surface. */
export interface CursorProviderTurnCleanup {
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	resolvedApiKey: string | undefined;
	prepare: Partial<CursorProviderTurnPrepareHandles> | undefined;
	send: Partial<CursorProviderTurnSendHandles> | undefined;
	deferSdkEventDebugFinalize: boolean;
}

export function createCursorProviderTurnCleanup(): CursorProviderTurnCleanup {
	return {
		sdkEventDebug: undefined,
		resolvedApiKey: undefined,
		prepare: undefined,
		send: undefined,
		deferSdkEventDebugFinalize: false,
	};
}
