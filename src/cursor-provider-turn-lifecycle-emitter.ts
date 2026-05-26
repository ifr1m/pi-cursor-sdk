import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { CursorPartialContentEmitter } from "./cursor-partial-content-emitter.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import {
	CURSOR_TOOL_LIFECYCLE_DEFER_MS,
	formatCursorToolLifecycleProgressText,
	isCursorToolLifecycleEligible,
} from "./cursor-tool-lifecycle.js";
import { classifyCursorToolVisibility } from "./cursor-tool-visibility.js";

function getNormalizedCursorToolName(toolCall: unknown): string {
	return classifyCursorToolVisibility(toolCall).normalizedName;
}

export interface CursorToolLifecycleEmitterOptions {
	liveRun?: CursorLiveRun;
	resolvedApiKey?: string;
	contentEmitter: CursorPartialContentEmitter;
	debugRecorder?: CursorSdkEventDebugRecorder;
	hasStartedToolCall: (callId: string) => boolean;
	isBridgeMcpToolCall: (toolCall: unknown) => boolean;
}

export class CursorToolLifecycleEmitter {
	private readonly liveRun?: CursorLiveRun;
	private readonly resolvedApiKey?: string;
	private readonly contentEmitter: CursorPartialContentEmitter;
	private readonly debugRecorder?: CursorSdkEventDebugRecorder;
	private readonly hasStartedToolCall: (callId: string) => boolean;
	private readonly isBridgeMcpToolCall: (toolCall: unknown) => boolean;
	private readonly emittedLifecycleCallIds = new Set<string>();
	private readonly lifecycleTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: CursorToolLifecycleEmitterOptions) {
		this.liveRun = options.liveRun;
		this.resolvedApiKey = options.resolvedApiKey;
		this.contentEmitter = options.contentEmitter;
		this.debugRecorder = options.debugRecorder;
		this.hasStartedToolCall = options.hasStartedToolCall;
		this.isBridgeMcpToolCall = options.isBridgeMcpToolCall;
	}

	maybeSchedule(callId: unknown, toolCall: unknown): void {
		if (typeof callId !== "string" || this.emittedLifecycleCallIds.has(callId)) return;
		if (this.isBridgeMcpToolCall(toolCall)) return;
		if (!isCursorToolLifecycleEligible(toolCall)) return;

		this.cancel(callId);
		const timer = setTimeout(() => {
			this.lifecycleTimers.delete(callId);
			if (!this.hasStartedToolCall(callId)) return;
			if (this.emittedLifecycleCallIds.has(callId)) return;
			this.emit(callId, toolCall);
		}, CURSOR_TOOL_LIFECYCLE_DEFER_MS);
		timer.unref?.();
		this.lifecycleTimers.set(callId, timer);
	}

	cancel(callId: string): void {
		const timer = this.lifecycleTimers.get(callId);
		if (!timer) return;
		clearTimeout(timer);
		this.lifecycleTimers.delete(callId);
	}

	clear(): void {
		this.emittedLifecycleCallIds.clear();
		for (const timer of this.lifecycleTimers.values()) clearTimeout(timer);
		this.lifecycleTimers.clear();
	}

	private emit(callId: string, toolCall: unknown): void {
		const progressText = formatCursorToolLifecycleProgressText(toolCall, this.resolvedApiKey);
		if (!progressText) return;
		this.emittedLifecycleCallIds.add(callId);
		this.debugRecorder?.recordCoordinatorEvent("tool_lifecycle", {
			callId,
			toolName: getNormalizedCursorToolName(toolCall),
			progressText,
			liveRun: this.liveRun !== undefined,
		});
		if (this.liveRun) {
			cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: progressText });
			return;
		}
		this.contentEmitter.appendThinkingDelta(progressText);
	}
}

export function createTurnCoordinatorContentEmitter(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
): CursorPartialContentEmitter {
	return new CursorPartialContentEmitter(stream, partial, undefined, false);
}
