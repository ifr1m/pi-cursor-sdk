import { mergeCursorToolCalls } from "./cursor-tool-transcript.js";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import {
	mergeShellOutputDeltasIntoCursorToolCall,
	type CursorShellOutputTracker,
} from "./cursor-provider-turn-shell-output.js";
import type { CursorToolCompletionLedger } from "./cursor-provider-turn-tool-ledger.js";

export type CursorToolCompletionSource = "delta" | "step";

export type ToolCompletionResolution =
	| { action: "ignore-bridge"; identity?: string }
	| {
			action: "handle";
			toolCall: unknown;
			identity?: string;
			source?: "started" | "fallback";
			matchedStartedCallId?: string;
	  };

export interface ResolveCursorToolCompletionOptions {
	source: CursorToolCompletionSource;
	callId: unknown;
	toolCall: unknown;
	startedToolCall?: unknown;
	liveRun?: CursorLiveRun;
	ledger: CursorToolCompletionLedger;
	shellOutput: CursorShellOutputTracker;
	onClearStartedCallId?: (callId: string) => void;
}

export function resolveCursorToolCompletion(options: ResolveCursorToolCompletionOptions): ToolCompletionResolution {
	const bridgeStartedCallId = options.ledger.takeBridgeStartedCallId(
		typeof options.callId === "string" ? options.callId : "",
	);
	if (bridgeStartedCallId) {
		options.ledger.recordCompletedIdentity(`cursor-tool:${bridgeStartedCallId}`);
		return { action: "ignore-bridge", identity: `cursor-tool:${bridgeStartedCallId}` };
	}

	let matchedStartedCallId: string | undefined;
	let resolvedToolCall: unknown;
	let identity: string | undefined;
	let source: "started" | "fallback" | undefined;

	if (options.source === "delta") {
		const callId = options.callId;
		identity = typeof callId === "string" ? `cursor-tool:${callId}` : undefined;
		resolvedToolCall = mergeCursorToolCalls(options.startedToolCall, options.toolCall);
		if (typeof callId === "string") {
			options.onClearStartedCallId?.(callId);
			options.ledger.clearStartedToolCall(callId);
		}
		resolvedToolCall = mergeShellOutputDeltasIntoCursorToolCall(
			resolvedToolCall,
			typeof callId === "string" ? options.shellOutput.takeDeltasForCall(callId) : undefined,
		);
		source = identity ? "started" : "fallback";
	} else {
		matchedStartedCallId = options.ledger.removeStartedToolCallForStep(options.toolCall, options.callId);
		if (matchedStartedCallId) {
			options.onClearStartedCallId?.(matchedStartedCallId);
		}
		resolvedToolCall = mergeShellOutputDeltasIntoCursorToolCall(
			options.toolCall,
			matchedStartedCallId ? options.shellOutput.takeDeltasForCall(matchedStartedCallId) : undefined,
		);
		const identityId = typeof options.callId === "string" ? options.callId : matchedStartedCallId;
		identity = identityId ? `cursor-tool:${identityId}` : undefined;
	}

	if (options.liveRun?.bridgeRun?.isBridgeMcpToolCall(resolvedToolCall)) {
		const bridgeIdentity =
			options.source === "step" && matchedStartedCallId ? `cursor-tool:${matchedStartedCallId}` : identity;
		if (bridgeIdentity) options.ledger.recordCompletedIdentity(bridgeIdentity);
		return { action: "ignore-bridge", identity: bridgeIdentity };
	}

	if (options.source === "delta") {
		return { action: "handle", toolCall: resolvedToolCall, identity, source };
	}
	return {
		action: "handle",
		toolCall: resolvedToolCall,
		identity,
		matchedStartedCallId,
	};
}
