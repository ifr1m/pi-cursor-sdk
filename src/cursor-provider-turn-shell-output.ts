import type { InteractionUpdate } from "@cursor/sdk";
import { asRecord, getField, hasUsableText } from "./cursor-record-utils.js";
import { classifyCursorToolVisibility } from "./cursor-tool-visibility.js";

export interface CursorShellOutputDelta {
	stream: "stdout" | "stderr";
	data: string;
}

export interface CursorShellOutputDeltas {
	stdout: string[];
	stderr: string[];
}

export function isCursorShellToolCall(toolCall: unknown): boolean {
	return classifyCursorToolVisibility(toolCall).normalizedKey === "shell";
}

export function getCursorShellOutputDelta(update: InteractionUpdate): CursorShellOutputDelta | undefined {
	if (update.type !== "shell-output-delta") return undefined;
	const event = getField(update, "event");
	const eventCase = getField(event, "case");
	if (eventCase !== "stdout" && eventCase !== "stderr") return undefined;
	const value = getField(event, "value");
	const data = getField(value, "data");
	if (typeof data !== "string" || data.length === 0) return undefined;
	return { stream: eventCase, data };
}

export function mergeShellOutputDeltasIntoCursorToolCall(
	toolCall: unknown,
	deltas: CursorShellOutputDeltas | undefined,
): unknown {
	if (!deltas) return toolCall;
	const stdout = deltas.stdout.join("");
	const stderr = deltas.stderr.join("");
	if (!hasUsableText(stdout) && !hasUsableText(stderr)) return toolCall;

	const toolRecord = asRecord(toolCall);
	const result = getField(toolRecord, "result");
	const resultRecord = asRecord(result);
	if (!toolRecord || !resultRecord || resultRecord.status !== "success") return toolCall;

	const value = getField(resultRecord, "value");
	const valueRecord = asRecord(value);
	const completedStdout = getField(valueRecord, "stdout");
	const completedStderr = getField(valueRecord, "stderr");
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

export class CursorShellOutputTracker {
	private readonly activeShellCallIds = new Set<string>();
	private readonly ambiguousShellOutputCallIds = new Set<string>();
	private readonly shellOutputDeltasByCallId = new Map<string, CursorShellOutputDeltas>();

	onShellToolStarted(callId: string): void {
		this.activeShellCallIds.add(callId);
	}

	onShellToolCleared(callId: string): void {
		this.activeShellCallIds.delete(callId);
		this.ambiguousShellOutputCallIds.delete(callId);
	}

	appendShellOutputDelta(delta: CursorShellOutputDelta): void {
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

	takeDeltasForCall(callId: string): CursorShellOutputDeltas | undefined {
		const deltas = this.shellOutputDeltasByCallId.get(callId);
		this.shellOutputDeltasByCallId.delete(callId);
		return deltas;
	}

	clear(): void {
		this.activeShellCallIds.clear();
		this.ambiguousShellOutputCallIds.clear();
		this.shellOutputDeltasByCallId.clear();
	}
}
