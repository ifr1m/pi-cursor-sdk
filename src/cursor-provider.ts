import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type AssistantMessage,
} from "@mariozechner/pi-ai";
import { Agent, createAgentPlatform } from "@cursor/sdk";
import type { InteractionUpdate, SDKAgent } from "@cursor/sdk";
import { buildCursorPrompt } from "./context.js";
import { getEffectiveFastForModelId } from "./cursor-state.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";

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

const MISSING_API_KEY_MESSAGE = "CURSOR_API_KEY or --api-key is required for Cursor SDK runs.";
const GENERIC_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed. Verify CURSOR_API_KEY or pass --api-key, then retry.";
const AUTH_CURSOR_SDK_ERROR_MESSAGE =
	"Cursor SDK request failed because the API key may be invalid or unauthorized. Verify CURSOR_API_KEY or pass --api-key, then retry.";

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
		.replace(/(authorization\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]")
		.replace(/(api[_-]?key\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]")
		.replace(/(token\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]")
		.replace(/(cookie\s*[:=]\s*)[^\n]+/gi, "$1[redacted]")
		.replace(/(session\s*[:=]\s*)[^\s,;}]+/gi, "$1[redacted]");
}

function isGenericErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized === "" || normalized === "error" || normalized === "unknown error";
}

function isLikelyAuthError(message: string): boolean {
	return /\b(unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(message);
}

function sanitizeError(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
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

function getCursorToolResult(toolCall: unknown): unknown {
	return getObjectField(toolCall, "result");
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

function summarizeCursorToolResult(result: unknown): string {
	if (result === undefined) return "";
	const parts: string[] = [];
	const status = getObjectField(result, "status");
	if (typeof status === "string") parts.push(status);
	const value = getObjectField(result, "value");
	const exitCode = getObjectField(value, "exitCode") ?? getObjectField(result, "exitCode");
	if (typeof exitCode === "number") parts.push(`exit ${exitCode}`);
	return parts.length > 0 ? `: ${parts.join(", ")}` : "";
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
		let abortSignal: AbortSignal | undefined;
		let abortListener: (() => void) | undefined;

		try {
			const throwIfAborted = (): void => {
				if (options?.signal?.aborted) throw new CursorAbortError();
			};

			stream.push({ type: "start", partial });
			throwIfAborted();

			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error(MISSING_API_KEY_MESSAGE);

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
			let textContentIndex = -1;
			let thinkingContentIndex = -1;
			const textDeltas: string[] = [];

			const appendBufferedTextDelta = (text: string): void => {
				textDeltas.push(text);
			};

			const appendTraceDelta = (text: string): void => {
				if (thinkingContentIndex < 0) {
					thinkingContentIndex = partial.content.length;
					partial.content.push({ type: "thinking", thinking: "" });
					stream.push({ type: "thinking_start", contentIndex: thinkingContentIndex, partial });
				}
				const block = partial.content[thinkingContentIndex];
				if (block.type === "thinking") {
					block.thinking += text;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingContentIndex,
						delta: text,
						partial,
					});
				}
			};

			const appendCursorToolStatus = (text: string): void => {
				appendTraceDelta(`${text}\n`);
			};

			const flushBufferedText = (fallbackText?: string): void => {
				const deltas = textDeltas.length > 0 ? textDeltas : fallbackText ? [fallbackText] : [];
				if (deltas.length === 0) return;
				textContentIndex = partial.content.length;
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: textContentIndex, partial });
				const block = partial.content[textContentIndex];
				if (block.type !== "text") return;
				for (const delta of deltas) {
					block.text += delta;
					stream.push({
						type: "text_delta",
						contentIndex: textContentIndex,
						delta,
						partial,
					});
				}
				stream.push({
					type: "text_end",
					contentIndex: textContentIndex,
					content: block.text,
					partial,
				});
			};

			const onDelta = (args: { update: InteractionUpdate }): void => {
				const update = args.update;

				if (update.type === "text-delta") {
					appendBufferedTextDelta(update.text);
				} else if (update.type === "thinking-delta") {
					appendTraceDelta(update.text);
				} else if (update.type === "thinking-completed") {
					if (thinkingContentIndex >= 0) {
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
					}
				} else if (update.type === "tool-call-started") {
					appendCursorToolStatus(`Cursor tool started (${getCursorToolName(update.toolCall)}, call ${update.callId})`);
				} else if (update.type === "tool-call-completed") {
					const suffix = summarizeCursorToolResult(getCursorToolResult(update.toolCall));
					appendCursorToolStatus(`Cursor tool completed (${getCursorToolName(update.toolCall)}, call ${update.callId})${suffix}`);
				} else if (update.type === "summary") {
					appendCursorToolStatus(`Cursor summary: ${update.summary}`);
				} else if (update.type === "turn-ended" && update.usage) {
					partial.usage.input = update.usage.inputTokens;
					partial.usage.output = update.usage.outputTokens;
					partial.usage.cacheRead = update.usage.cacheReadTokens;
					partial.usage.cacheWrite = update.usage.cacheWriteTokens;
					partial.usage.totalTokens =
						update.usage.inputTokens + update.usage.outputTokens + update.usage.cacheReadTokens + update.usage.cacheWriteTokens;
				}
				// partial-tool-call, summary-started, summary-completed,
				// shell-output-delta, token-delta, step-* are intentionally not surfaced.
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
				{ onDelta },
			);
			if (options?.signal?.aborted) {
				await run.cancel().catch(() => {});
				throw new CursorAbortError();
			}

			const result = await run.wait();
			await cacheSdkContextWindow(agent.agentId, model.id);

			// Close open thinking/trace before flushing final assistant text so saved
			// message content is trace first, final answer second.
			if (thinkingContentIndex >= 0) {
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
			}

			flushBufferedText(result.result);

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
				partial.errorMessage = sanitizeError(error, options?.apiKey);
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
