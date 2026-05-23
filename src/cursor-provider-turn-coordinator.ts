import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { InteractionUpdate } from "@cursor/sdk";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { canRenderCursorToolNatively } from "./cursor-native-tool-display.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, getCursorCreatePlanText, mergeCursorToolCalls } from "./cursor-tool-transcript.js";

const CURSOR_ACTIVITY_TRACE_MAX_CHARS = 50000;

function getObjectField(value: unknown, field: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[field];
}

function getCursorToolName(toolCall: unknown): string {
	if (!toolCall || typeof toolCall !== "object") return "unknown";
	const data = toolCall as Record<string, unknown>;
	if (typeof data.name === "string") return data.name;
	if (typeof data.type === "string") return data.type;
	if (typeof data.toolName === "string") return data.toolName;
	return "unknown";
}

function hasUsableText(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function sanitizeSingleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateSingleLine(value: string, maxLength = 240): string {
	const sanitized = sanitizeSingleLine(value);
	return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength - 1)}…` : sanitized;
}

function formatCursorToolName(toolCall: unknown): string {
	return truncateSingleLine(getCursorToolName(toolCall), 80) || "unknown";
}

function scrubSensitiveText(text: string, apiKey?: string): string {
	let scrubbed = text;
	const trimmedKey = apiKey?.trim();
	if (trimmedKey) {
		scrubbed = scrubbed.replace(new RegExp(trimmedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted]");
	}
	return scrubbed
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
		.replace(
			/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
			"$1[redacted]",
		);
}

function scrubDisplayValue(value: unknown, apiKey?: string): unknown {
	if (typeof value === "string") return scrubSensitiveText(value, apiKey);
	if (Array.isArray(value)) return value.map((entry) => scrubDisplayValue(entry, apiKey));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubDisplayValue(entry, apiKey)]));
	}
	return value;
}

interface CursorShellOutputDelta {
	stream: "stdout" | "stderr";
	data: string;
}

interface CursorShellOutputDeltas {
	stdout: string[];
	stderr: string[];
}

function isCursorShellToolCall(toolCall: unknown): boolean {
	const normalizedName = getCursorToolName(toolCall).replace(/\s+/g, " ").trim().toLowerCase();
	return normalizedName === "shell" || normalizedName === "run_terminal_cmd" || normalizedName === "terminal" || normalizedName === "bash";
}

function getCursorShellOutputDelta(update: InteractionUpdate): CursorShellOutputDelta | undefined {
	if (update.type !== "shell-output-delta") return undefined;
	const event = getObjectField(update, "event");
	const eventCase = getObjectField(event, "case");
	if (eventCase !== "stdout" && eventCase !== "stderr") return undefined;
	const value = getObjectField(event, "value");
	const data = getObjectField(value, "data");
	if (typeof data !== "string" || data.length === 0) return undefined;
	return { stream: eventCase, data };
}

function mergeShellOutputDeltasIntoCursorToolCall(toolCall: unknown, deltas: CursorShellOutputDeltas | undefined): unknown {
	if (!deltas) return toolCall;
	const stdout = deltas.stdout.join("");
	const stderr = deltas.stderr.join("");
	if (!hasUsableText(stdout) && !hasUsableText(stderr)) return toolCall;

	const toolRecord = toolCall && typeof toolCall === "object" && !Array.isArray(toolCall) ? (toolCall as Record<string, unknown>) : undefined;
	const result = getObjectField(toolRecord, "result");
	const resultRecord = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
	if (!toolRecord || !resultRecord || resultRecord.status !== "success") return toolCall;

	const value = getObjectField(resultRecord, "value");
	const valueRecord = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	const completedStdout = getObjectField(valueRecord, "stdout");
	const completedStderr = getObjectField(valueRecord, "stderr");
	if (hasUsableText(typeof completedStdout === "string" ? completedStdout : undefined)) return toolCall;
	if (hasUsableText(typeof completedStderr === "string" ? completedStderr : undefined)) return toolCall;

	return {
		...toolRecord,
		result: {
			...resultRecord,
			value: {
				...(valueRecord ?? {}),
				stdout,
				stderr,
			},
		},
	};
}

type ToolCompletionResolution =
	| { action: "ignore-bridge"; identity?: string }
	| {
			action: "handle";
			toolCall: unknown;
			identity?: string;
			source?: "started" | "fallback";
			matchedStartedCallId?: string;
	  };

export interface CursorSdkTurnCoordinatorOptions {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	cwd: string;
	resolvedApiKey?: string;
	liveRun?: CursorLiveRun;
	useNativeToolReplay: boolean;
	nativeReplayId: string;
	textDeltas: string[];
}

export class CursorSdkTurnCoordinator {
	readonly stream: AssistantMessageEventStream;
	readonly partial: AssistantMessage;
	readonly cwd: string;
	readonly resolvedApiKey?: string;
	readonly liveRun?: CursorLiveRun;
	readonly useNativeToolReplay: boolean;
	readonly nativeReplayId: string;
	readonly textDeltas: string[];

	private thinkingContentIndex = -1;
	private activityTraceChars = 0;
	private activityTraceTruncated = false;
	private nativeToolDisplayCounter = 0;
	private textContentIndex = -1;
	private nativeToolReplayStarted = false;
	private cursorPlanTextCandidate: string | undefined;
	private readonly startedToolCalls = new Map<string, unknown>();
	private readonly bridgeStartedToolCallIds = new Set<string>();
	private readonly activeShellCallIds = new Set<string>();
	private readonly ambiguousShellOutputCallIds = new Set<string>();
	private readonly shellOutputDeltasByCallId = new Map<string, CursorShellOutputDeltas>();
	private readonly completedToolIdentities = new Set<string>();
	private readonly completedStartedToolFingerprints = new Set<string>();
	private readonly completedFallbackToolFingerprints = new Set<string>();

	constructor(options: CursorSdkTurnCoordinatorOptions) {
		this.stream = options.stream;
		this.partial = options.partial;
		this.cwd = options.cwd;
		this.resolvedApiKey = options.resolvedApiKey;
		this.liveRun = options.liveRun;
		this.useNativeToolReplay = options.useNativeToolReplay;
		this.nativeReplayId = options.nativeReplayId;
		this.textDeltas = options.textDeltas;
	}

	get planTextCandidate(): string | undefined {
		return this.cursorPlanTextCandidate;
	}

	get replayStarted(): boolean {
		return this.nativeToolReplayStarted;
	}

	discardIncompleteStartedToolCalls(): void {
		this.startedToolCalls.clear();
		this.bridgeStartedToolCallIds.clear();
		this.activeShellCallIds.clear();
		this.ambiguousShellOutputCallIds.clear();
		this.shellOutputDeltasByCallId.clear();
	}

	closeTraceBlock(): void {
		if (this.thinkingContentIndex < 0) return;
		const block = this.partial.content[this.thinkingContentIndex];
		if (block.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex: this.thinkingContentIndex,
				content: block.thinking,
				partial: this.partial,
			});
		}
		this.thinkingContentIndex = -1;
	}

	flushText(deltas: string[]): string {
		for (const delta of deltas) this.appendLiveTextDelta(delta);
		if (this.textContentIndex < 0) return "";
		const block = this.partial.content[this.textContentIndex];
		if (block.type !== "text") return "";
		this.stream.push({
			type: "text_end",
			contentIndex: this.textContentIndex,
			content: block.text,
			partial: this.partial,
		});
		return block.text;
	}

	handleDelta(update: InteractionUpdate): void {
		if (update.type === "text-delta") {
			this.textDeltas.push(update.text);
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "text-delta", text: update.text });
			} else {
				this.appendLiveTextDelta(update.text);
			}
			return;
		}
		if (update.type === "thinking-delta") {
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: update.text });
			} else {
				this.appendTraceDelta(update.text);
			}
			return;
		}
		if (update.type === "thinking-completed") {
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-completed" });
			} else {
				this.closeTraceBlock();
			}
			return;
		}
		if (update.type === "tool-call-started") {
			if (this.liveRun?.bridgeRun?.isBridgeMcpToolCall(update.toolCall)) {
				if (typeof update.callId === "string") this.bridgeStartedToolCallIds.add(update.callId);
			} else {
				this.startedToolCalls.set(update.callId, update.toolCall);
				if (isCursorShellToolCall(update.toolCall)) this.activeShellCallIds.add(update.callId);
			}
			return;
		}
		if (update.type === "tool-call-completed") {
			const resolution = this.resolveDeltaToolCompletion(update);
			if (resolution.action === "ignore-bridge") return;
			this.handleCompletedToolCall(resolution.toolCall, {
				identity: resolution.identity,
				source: resolution.source,
			});
			return;
		}
		if (update.type === "shell-output-delta") {
			const delta = getCursorShellOutputDelta(update);
			if (delta) this.appendShellOutputDelta(delta);
			return;
		}
		if (update.type === "summary") {
			const summary = `Cursor summary: ${truncateSingleLine(update.summary)}\n`;
			if (this.liveRun) {
				cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: summary });
			} else {
				this.appendTraceDelta(summary);
			}
		}
	}

	handleStep(stepEnvelope: unknown): void {
		const stepType = getObjectField(stepEnvelope, "type");
		const step = getObjectField(stepEnvelope, "message") ? stepEnvelope : undefined;
		const rawStepToolCall = getObjectField(step, "message");
		if (stepType !== "toolCall") return;
		const toolCall = rawStepToolCall;
		const stepId = getObjectField(stepEnvelope, "id") ?? getObjectField(toolCall, "id") ?? getObjectField(toolCall, "callId");
		if (!toolCall) return;

		const resolution = this.resolveStepToolCompletion(toolCall, stepId);
		if (resolution.action === "ignore-bridge") return;
		this.handleCompletedToolCall(resolution.toolCall, {
			identity: resolution.identity,
			source: resolution.source,
		});
		if (resolution.matchedStartedCallId && resolution.matchedStartedCallId !== stepId) {
			this.completedToolIdentities.add(`cursor-tool:${resolution.matchedStartedCallId}`);
		}
	}

	private resolveDeltaToolCompletion(update: Extract<InteractionUpdate, { type: "tool-call-completed" }>): ToolCompletionResolution {
		const identity = typeof update.callId === "string" ? `cursor-tool:${update.callId}` : undefined;
		const bridgeStartedCallId = this.takeBridgeStartedToolCallId(update.callId);
		if (bridgeStartedCallId) {
			this.completedToolIdentities.add(`cursor-tool:${bridgeStartedCallId}`);
			return { action: "ignore-bridge", identity: `cursor-tool:${bridgeStartedCallId}` };
		}
		const mergedToolCall = mergeCursorToolCalls(this.startedToolCalls.get(update.callId), update.toolCall);
		this.clearStartedToolCall(update.callId);
		const toolCallWithShellOutput = mergeShellOutputDeltasIntoCursorToolCall(
			mergedToolCall,
			this.takeShellOutputDeltas(update.callId),
		);
		return {
			action: "handle",
			toolCall: toolCallWithShellOutput,
			identity,
			source: identity ? "started" : "fallback",
		};
	}

	private resolveStepToolCompletion(toolCall: unknown, stepId: unknown): ToolCompletionResolution {
		const bridgeStartedCallId = this.takeBridgeStartedToolCallId(stepId);
		if (bridgeStartedCallId) {
			this.completedToolIdentities.add(`cursor-tool:${bridgeStartedCallId}`);
			return { action: "ignore-bridge", identity: `cursor-tool:${bridgeStartedCallId}` };
		}
		const matchedStartedCallId = this.removeStartedToolCallForStep(toolCall, stepId);
		const toolCallWithShellOutput = mergeShellOutputDeltasIntoCursorToolCall(
			toolCall,
			matchedStartedCallId ? this.takeShellOutputDeltas(matchedStartedCallId) : undefined,
		);
		if (this.liveRun?.bridgeRun?.isBridgeMcpToolCall(toolCall)) {
			if (matchedStartedCallId) this.completedToolIdentities.add(`cursor-tool:${matchedStartedCallId}`);
			return { action: "ignore-bridge", identity: matchedStartedCallId ? `cursor-tool:${matchedStartedCallId}` : undefined };
		}
		const identityId = typeof stepId === "string" ? stepId : matchedStartedCallId;
		return {
			action: "handle",
			toolCall: toolCallWithShellOutput,
			identity: identityId ? `cursor-tool:${identityId}` : undefined,
			matchedStartedCallId,
		};
	}

	private handleCompletedToolCall(
		toolCall: unknown,
		options: { identity?: string; source?: "started" | "fallback" } = {},
	): void {
		const planText = getCursorCreatePlanText(toolCall);
		if (planText) this.cursorPlanTextCandidate = scrubSensitiveText(planText, this.resolvedApiKey);

		if (this.liveRun?.bridgeRun?.isBridgeMcpToolCall(toolCall)) {
			if (options.identity) this.completedToolIdentities.add(options.identity);
			return;
		}
		const transcript = scrubSensitiveText(formatCursorToolTranscript(toolCall, { cwd: this.cwd }), this.resolvedApiKey);
		const display = buildCursorPiToolDisplay(toolCall, { cwd: this.cwd });
		const fingerprint = this.getToolFingerprint({ toolName: display.toolName, args: display.args, result: display.result });
		if (options.identity && this.completedToolIdentities.has(options.identity)) return;
		if (options.source === "started") {
			if (this.completedFallbackToolFingerprints.has(fingerprint)) return;
		} else if (this.completedStartedToolFingerprints.has(fingerprint) || this.completedFallbackToolFingerprints.has(fingerprint)) {
			return;
		}
		if (options.identity) this.completedToolIdentities.add(options.identity);
		if (options.source === "started") {
			this.completedStartedToolFingerprints.add(fingerprint);
		} else {
			this.completedFallbackToolFingerprints.add(fingerprint);
		}

		const nativeRenderable = canRenderCursorToolNatively(display.toolName);
		const route = this.useNativeToolReplay && nativeRenderable && this.liveRun ? "native_replay" : "trace";

		if (route === "native_replay" && this.liveRun) {
			this.nativeToolReplayStarted = true;
			const id = `${this.nativeReplayId}-tool-${++this.nativeToolDisplayCounter}`;
			cursorLiveRuns.queueEvent(this.liveRun, {
				type: "tool",
				tool: {
					...display,
					id,
					args: scrubDisplayValue(display.args, this.resolvedApiKey) as Record<string, unknown>,
					result: scrubDisplayValue(display.result, this.resolvedApiKey) as typeof display.result,
				},
			});
			return;
		}

		this.emitCursorToolTrace(transcript || `Cursor tool: ${formatCursorToolName(toolCall)} completed`);
	}

	private appendLiveTextDelta(text: string): void {
		if (this.textContentIndex < 0) {
			this.textContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textContentIndex, partial: this.partial });
		}
		const block = this.partial.content[this.textContentIndex];
		if (block.type !== "text") return;
		block.text += text;
		this.stream.push({
			type: "text_delta",
			contentIndex: this.textContentIndex,
			delta: text,
			partial: this.partial,
		});
	}

	private appendTraceDelta(text: string): void {
		if (this.activityTraceTruncated) return;

		let delta = text;
		if (this.activityTraceChars + delta.length > CURSOR_ACTIVITY_TRACE_MAX_CHARS) {
			const remainingChars = Math.max(CURSOR_ACTIVITY_TRACE_MAX_CHARS - this.activityTraceChars, 0);
			delta = `${delta.slice(0, remainingChars)}\n[Cursor activity trace truncated]\n`;
			this.activityTraceTruncated = true;
		}
		if (!delta) return;

		if (this.thinkingContentIndex < 0) {
			this.thinkingContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: this.thinkingContentIndex, partial: this.partial });
		}
		const block = this.partial.content[this.thinkingContentIndex];
		if (block.type === "thinking") {
			block.thinking += delta;
			this.activityTraceChars += delta.length;
			this.stream.push({
				type: "thinking_delta",
				contentIndex: this.thinkingContentIndex,
				delta,
				partial: this.partial,
			});
		}
	}

	private appendTraceBlock(text: string): void {
		this.closeTraceBlock();
		this.appendTraceDelta(text.endsWith("\n") ? text : `${text}\n`);
		this.closeTraceBlock();
	}

	private emitCursorToolTrace(text: string): void {
		const traceText = text.endsWith("\n") ? text : `${text}\n`;
		if (this.liveRun) {
			cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-delta", text: traceText });
			cursorLiveRuns.queueEvent(this.liveRun, { type: "thinking-completed" });
			return;
		}
		this.appendTraceBlock(traceText);
	}

	private getToolFingerprint(value: unknown): string {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	private getStartedToolCallFingerprint(toolCall: unknown): string {
		return this.getToolFingerprint({ toolName: getCursorToolName(toolCall), args: getObjectField(toolCall, "args") });
	}

	private clearStartedToolCall(callId: string): void {
		this.startedToolCalls.delete(callId);
		this.bridgeStartedToolCallIds.delete(callId);
		this.activeShellCallIds.delete(callId);
		this.ambiguousShellOutputCallIds.delete(callId);
	}

	private takeBridgeStartedToolCallId(callId: unknown): string | undefined {
		if (typeof callId !== "string" || !this.bridgeStartedToolCallIds.has(callId)) return undefined;
		this.bridgeStartedToolCallIds.delete(callId);
		return callId;
	}

	private takeShellOutputDeltas(callId: string): CursorShellOutputDeltas | undefined {
		const deltas = this.shellOutputDeltasByCallId.get(callId);
		this.shellOutputDeltasByCallId.delete(callId);
		return deltas;
	}

	private appendShellOutputDelta(delta: CursorShellOutputDelta): void {
		if (this.activeShellCallIds.size !== 1) {
			for (const activeCallId of this.activeShellCallIds) {
				this.ambiguousShellOutputCallIds.add(activeCallId);
				this.shellOutputDeltasByCallId.delete(activeCallId);
			}
			return;
		}
		const [callId] = this.activeShellCallIds;
		if (!callId || this.ambiguousShellOutputCallIds.has(callId)) return;
		let deltas = this.shellOutputDeltasByCallId.get(callId);
		if (!deltas) {
			deltas = { stdout: [], stderr: [] };
			this.shellOutputDeltasByCallId.set(callId, deltas);
		}
		deltas[delta.stream].push(delta.data);
	}

	private removeStartedToolCallForStep(toolCall: unknown, stepId: unknown): string | undefined {
		if (typeof stepId === "string" && this.startedToolCalls.has(stepId)) {
			this.clearStartedToolCall(stepId);
			return stepId;
		}
		const fingerprint = this.getStartedToolCallFingerprint(toolCall);
		for (const [callId, startedToolCall] of this.startedToolCalls) {
			if (this.getStartedToolCallFingerprint(startedToolCall) !== fingerprint) continue;
			this.clearStartedToolCall(callId);
			return callId;
		}
		return undefined;
	}
}
