import type { Context, Message, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { CURSOR_APPROX_CHARS_PER_TOKEN, estimateCursorPromptMessageTokens } from "./context.js";

export interface CursorLiveRunAccountingState {
	promptInputTokens: number;
	promptInputTokensReported: boolean;
	consumedToolResultIds: ReadonlySet<string>;
}

export interface CursorLiveToolResultConsumption {
	state: CursorLiveRunAccountingState;
	toolResults: ToolResultMessage[];
	toolResultInputTokens: number;
	toolCallIds: string[];
}

export function createCursorLiveRunAccountingState(promptInputTokens: number): CursorLiveRunAccountingState {
	return {
		promptInputTokens,
		promptInputTokensReported: false,
		consumedToolResultIds: new Set(),
	};
}

function asToolResultMessage(message: Message): ToolResultMessage | undefined {
	return message.role === "toolResult" ? message : undefined;
}

export function consumeCursorLiveToolResults(
	state: CursorLiveRunAccountingState,
	context: Context,
	isMatchingToolResult: (toolResult: ToolResultMessage) => boolean,
): CursorLiveToolResultConsumption {
	const consumedToolResultIds = new Set(state.consumedToolResultIds);
	const toolResults: ToolResultMessage[] = [];
	let toolResultInputTokens = 0;

	for (const message of context.messages) {
		const toolResult = asToolResultMessage(message);
		if (!toolResult) continue;
		if (consumedToolResultIds.has(toolResult.toolCallId)) continue;
		if (!isMatchingToolResult(toolResult)) continue;
		consumedToolResultIds.add(toolResult.toolCallId);
		toolResults.push(toolResult);
		toolResultInputTokens += estimateCursorPromptMessageTokens(toolResult, { charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN });
	}

	return {
		state: { ...state, consumedToolResultIds },
		toolResults,
		toolResultInputTokens,
		toolCallIds: toolResults.map((toolResult) => toolResult.toolCallId),
	};
}

export function takeCursorLiveTurnInputTokens(
	state: CursorLiveRunAccountingState,
	toolResultInputTokens: number,
): { state: CursorLiveRunAccountingState; sessionInputTokens: number } {
	const promptInputTokens = state.promptInputTokensReported ? 0 : state.promptInputTokens;
	return {
		state: state.promptInputTokensReported ? state : { ...state, promptInputTokensReported: true },
		sessionInputTokens: promptInputTokens + toolResultInputTokens,
	};
}
