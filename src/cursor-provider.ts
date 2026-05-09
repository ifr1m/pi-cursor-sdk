import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Agent, createAgentPlatform } from "@cursor/sdk";
import type { InteractionUpdate, SDKAgent } from "@cursor/sdk";
import { buildCursorPrompt, type CursorPrompt } from "./context.js";
import { getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, mergeCursorToolCalls } from "./cursor-tool-transcript.js";
import {
	canRenderCursorToolNatively,
	isCursorNativeToolDisplayRuntimeEnabled,
	recordCursorNativeToolDisplay,
} from "./cursor-native-tool-display.js";

function makeInitialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

class CursorAbortError extends Error {
	constructor() {
		super("aborted");
		this.name = "CursorAbortError";
	}
}

const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
const MISSING_API_KEY_MESSAGE =
	"Cursor SDK runs require a Cursor API key. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.";
const GENERIC_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed. The API key may be missing, invalid, or unauthorized. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const AUTH_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed because the API key may be invalid or unauthorized. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.";
const APPROX_CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1200;
const CURSOR_ACTIVITY_TRACE_MAX_CHARS = 50000;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubSensitiveText(text: string, apiKey?: string): string {
	let scrubbed = text;
	const trimmedKey = apiKey?.trim();
	if (trimmedKey) {
		scrubbed = scrubbed.replace(new RegExp(escapeRegExp(trimmedKey), "g"), "[redacted]");
	}
	return scrubbed
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
		.replace(
			/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
			"$1[redacted]",
		);
}

function isGenericErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || normalized === "error" || normalized === "unknown error";
}

function isLikelyAuthError(message: string): boolean {
	return /\b(unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(message);
}

function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (trimmed === CURSOR_API_KEY_ENV_VAR) return process.env.CURSOR_API_KEY?.trim();
	return trimmed;
}

function sanitizeError(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message === MISSING_API_KEY_MESSAGE) return MISSING_API_KEY_MESSAGE;
	const scrubbed = scrubSensitiveText(message, apiKey).trim();
	if (isGenericErrorMessage(scrubbed)) return GENERIC_CURSOR_SDK_ERROR_MESSAGE;
	if (isLikelyAuthError(scrubbed)) return AUTH_CURSOR_SDK_ERROR_MESSAGE;
	return scrubbed || GENERIC_CURSOR_SDK_ERROR_MESSAGE;
}

function getObjectField(value: unknown, field: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[field];
}

function getCursorToolName(toolCall: unknown): string {
	if (!toolCall || typeof toolCall !== "object") return "unknown";
	const data = toolCall as Record<string, unknown>;
	if (typeof data.name === "string") return data.name;
	if (typeof data.type === "string") return data.type;
	return "unknown";
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

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function estimatePromptInputTokens(prompt: CursorPrompt): number {
	return estimateTextTokens(prompt.text) + prompt.images.length * IMAGE_TOKEN_ESTIMATE;
}

function setApproximateUsage(partial: AssistantMessage, promptInputTokens: number, outputText: string): void {
	partial.usage.input = promptInputTokens;
	partial.usage.output = estimateTextTokens(outputText);
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	partial.usage.totalTokens = partial.usage.input + partial.usage.output;
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

function hasUsableText(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function scrubDisplayValue(value: unknown, apiKey?: string): unknown {
	if (typeof value === "string") return scrubSensitiveText(value, apiKey);
	if (Array.isArray(value)) return value.map((entry) => scrubDisplayValue(entry, apiKey));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubDisplayValue(entry, apiKey)]));
	}
	return value;
}

export function streamCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const partial = makeInitialMessage(model);
		let agent: SDKAgent | null = null;
		let resolvedApiKey: string | undefined;
		let abortSignal: AbortSignal | undefined;
		let abortListener: (() => void) | undefined;

		try {
			const throwIfAborted = (): void => {
				if (options?.signal?.aborted) throw new CursorAbortError();
			};

			stream.push({ type: "start", partial });
			throwIfAborted();

			const apiKey = resolveCursorApiKey(options?.apiKey);
			if (!apiKey) throw new Error(MISSING_API_KEY_MESSAGE);
			resolvedApiKey = apiKey;

			const cwd = process.cwd();
			const fastEnabled = getEffectiveFastForModelId(model.id);
			const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", fastEnabled);

			agent = await Agent.create({
				apiKey,
				model: selection,
				// Do not pass settingSources here. The Cursor SDK currently writes
				// setting/rule loading INFO logs directly to process output, which corrupts pi's TUI.
				local: { cwd },
			});
			throwIfAborted();

			const prompt = buildCursorPrompt(context);
			const promptInputTokens = estimatePromptInputTokens(prompt);
			let thinkingContentIndex = -1;
			let activityTraceChars = 0;
			let activityTraceTruncated = false;
			let nativeToolDisplayCounter = 0;
			let textContentIndex = -1;
			const textDeltas: string[] = [];
			const startedToolCalls = new Map<string, unknown>();
			const completedToolFingerprints = new Set<string>();

			const appendLiveTextDelta = (text: string): void => {
				textDeltas.push(text);
				if (textContentIndex < 0) {
					textContentIndex = partial.content.length;
					partial.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: textContentIndex, partial });
				}
				const block = partial.content[textContentIndex];
				if (block.type !== "text") return;
				block.text += text;
				stream.push({
					type: "text_delta",
					contentIndex: textContentIndex,
					delta: text,
					partial,
				});
			};

			const appendTraceDelta = (text: string): void => {
				if (activityTraceTruncated) return;

				let delta = text;
				if (activityTraceChars + delta.length > CURSOR_ACTIVITY_TRACE_MAX_CHARS) {
					const remainingChars = Math.max(CURSOR_ACTIVITY_TRACE_MAX_CHARS - activityTraceChars, 0);
					delta = `${delta.slice(0, remainingChars)}\n[Cursor activity trace truncated]\n`;
					activityTraceTruncated = true;
				}
				if (!delta) return;

				if (thinkingContentIndex < 0) {
					thinkingContentIndex = partial.content.length;
					partial.content.push({ type: "thinking", thinking: "" });
					stream.push({ type: "thinking_start", contentIndex: thinkingContentIndex, partial });
				}
				const block = partial.content[thinkingContentIndex];
				if (block.type === "thinking") {
					block.thinking += delta;
					activityTraceChars += delta.length;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingContentIndex,
						delta,
						partial,
					});
				}
			};

			const appendTraceLine = (text: string): void => {
				appendTraceDelta(`${text}\n`);
			};

			const appendTraceBlock = (text: string): void => {
				closeTraceBlock();
				appendTraceDelta(text.endsWith("\n") ? text : `${text}\n`);
				closeTraceBlock();
			};

			const closeTraceBlock = (): void => {
				if (thinkingContentIndex < 0) return;
				const block = partial.content[thinkingContentIndex];
				if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingContentIndex,
						content: block.thinking,
						partial,
					});
				}
				thinkingContentIndex = -1;
			};

			const flushText = (deltas: string[]): string => {
				for (const delta of deltas) appendLiveTextDelta(delta);
				if (textContentIndex < 0) return "";
				const block = partial.content[textContentIndex];
				if (block.type !== "text") return "";
				stream.push({
					type: "text_end",
					contentIndex: textContentIndex,
					content: block.text,
					partial,
				});
				return block.text;
			};

			const getToolFingerprint = (value: unknown): string => {
				try {
					return JSON.stringify(value);
				} catch {
					return String(value);
				}
			};

			const handleCompletedToolCall = (toolCall: unknown): void => {
				const transcript = scrubSensitiveText(formatCursorToolTranscript(toolCall, { cwd }), resolvedApiKey);
				const display = buildCursorPiToolDisplay(toolCall, { cwd });
				const fingerprint = getToolFingerprint({ toolName: display.toolName, args: display.args, result: display.result });
				if (completedToolFingerprints.has(fingerprint)) return;
				completedToolFingerprints.add(fingerprint);

				if (isCursorNativeToolDisplayRuntimeEnabled() && canRenderCursorToolNatively(display.toolName)) {
					const id = `cursor-tool-${++nativeToolDisplayCounter}`;
					const contentIndex = partial.content.length;
					const scrubbedArgs = scrubDisplayValue(display.args, resolvedApiKey) as Record<string, unknown>;
					const scrubbedResult = scrubDisplayValue(display.result, resolvedApiKey) as typeof display.result;
					partial.content.push({
						type: "toolCall",
						id,
						name: display.toolName,
						arguments: scrubbedArgs,
					});
					stream.push({ type: "toolcall_start", contentIndex, partial });
					recordCursorNativeToolDisplay({
						...display,
						id,
						args: scrubbedArgs,
						result: scrubbedResult,
					});
					const block = partial.content[contentIndex];
					if (block.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
					return;
				}

				appendTraceBlock(transcript || `Cursor tool: ${formatCursorToolName(toolCall)} completed`);
			};

			const onDelta = (args: { update: InteractionUpdate }): void => {
				const update = args.update;

				if (update.type === "text-delta") {
					appendLiveTextDelta(update.text);
				} else if (update.type === "thinking-delta") {
					appendTraceDelta(update.text);
				} else if (update.type === "thinking-completed") {
					closeTraceBlock();
				} else if (update.type === "tool-call-started") {
					startedToolCalls.set(update.callId, update.toolCall);
				} else if (update.type === "tool-call-completed") {
					const mergedToolCall = mergeCursorToolCalls(startedToolCalls.get(update.callId), update.toolCall);
					startedToolCalls.delete(update.callId);
					handleCompletedToolCall(mergedToolCall);
				} else if (update.type === "summary") {
					appendTraceLine(`Cursor summary: ${truncateSingleLine(update.summary)}`);
				}
				// Cursor turn-ended usage is intentionally not copied into pi usage: the SDK reports
				// cumulative internal agent/tool/cache tokens, not the replayable pi prompt context.
				// partial-tool-call, summary-started, summary-completed, turn-ended,
				// shell-output-delta, token-delta, step-* are intentionally not surfaced.
			};

			const onStep = (args: { step: unknown }): void => {
				const step = getObjectField(args.step, "message") ? args.step : undefined;
				if (getObjectField(args.step, "type") !== "toolCall") return;
				const toolCall = getObjectField(step, "message");
				if (toolCall) handleCompletedToolCall(toolCall);
			};

			// Handle abort signal
			let run: Awaited<ReturnType<SDKAgent["send"]>> | null = null;
			abortListener = () => {
				if (run) {
					run.cancel().catch(() => {});
				}
			};
			abortSignal = options?.signal;
			abortSignal?.addEventListener("abort", abortListener, { once: true });

			throwIfAborted();
			run = await agent.send(
				{ text: prompt.text, images: prompt.images.length > 0 ? prompt.images : undefined },
				{ onDelta, onStep },
			);
			if (options?.signal?.aborted) {
				await run.cancel().catch(() => {});
				throw new CursorAbortError();
			}

			const result = await run.wait();
			await cacheSdkContextWindow(agent.agentId, model.id);

			// Close any open thinking/activity trace, then use the final run result only when
			// Cursor did not stream text deltas.
			closeTraceBlock();

			const finalText = flushText(textDeltas.length === 0 && hasUsableText(result.result) ? [result.result] : []);
			setApproximateUsage(partial, promptInputTokens, finalText);

			if (result.status === "cancelled") {
				partial.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else {
				stream.push({ type: "done", reason: "stop", message: partial });
			}
		} catch (error) {
			if (error instanceof CursorAbortError) {
				partial.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: partial });
			} else {
				partial.stopReason = "error";
				partial.errorMessage = sanitizeError(error, resolvedApiKey ?? options?.apiKey);
				stream.push({ type: "error", reason: "error", error: partial });
			}
		} finally {
			if (abortSignal && abortListener) {
				abortSignal.removeEventListener("abort", abortListener);
			}

			if (agent) {
				try {
					await agent[Symbol.asyncDispose]();
				} catch {
					// disposal failure should not mask original error
				}
				agent = null;
			}
		}

		stream.end();
	})();

	return stream;
}
