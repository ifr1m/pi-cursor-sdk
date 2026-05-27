import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { SDKAgent, SDKImage } from "@cursor/sdk";
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

export interface CursorProviderTurnSendMeta {
	sendPlan: ReturnType<typeof planCursorSessionSend>;
	prompt: CursorPrompt;
	bootstrap: boolean;
	promptInputTokens: number;
	useNativeToolReplay: boolean;
	bridgeEnabled: boolean;
	nativeReplayId: string;
}

interface CursorProviderTurnRuntimeBase {
	turnCoordinator: CursorSdkTurnCoordinator;
}

export interface DirectCursorProviderTurnRuntime extends CursorProviderTurnRuntimeBase {
	kind: "direct";
	liveRun?: undefined;
}

export interface LiveCursorProviderTurnRuntime extends CursorProviderTurnRuntimeBase {
	kind: "live";
	liveRun: CursorLiveRun;
}

export type CursorProviderTurnRuntime = DirectCursorProviderTurnRuntime | LiveCursorProviderTurnRuntime;

/**
 * Single owned model for a prepared provider turn.
 *
 * Send, finalize, and cleanup phases receive this immutable object instead of
 * keeping parallel liveRun/turnCoordinator/resource bags in sync by convention.
 */
export interface PreparedCursorProviderTurn {
	agent: SDKAgent;
	cwd: string;
	payload: CursorProviderTurnSendPayload;
	meta: CursorProviderTurnSendMeta;
	contextWindowAgentId: string;
	textDeltas: string[];
	sessionAgentScopeKey: string;
	sessionAgentLease: SessionCursorAgentLease;
	restoreCursorSdkOutputFilter: () => void;
	runtime: CursorProviderTurnRuntime;
}

export type CursorProviderTurnPrepareResult = PreparedCursorProviderTurn;

export interface CursorProviderTurnSend {
	run: Awaited<ReturnType<SDKAgent["send"]>>;
	cursorAgentMessageOffset: number | undefined;
}

export interface CursorProviderTurnSendResult {
	send: CursorProviderTurnSend;
	abortRegistration: { signal: AbortSignal; listener: () => void } | undefined;
}
