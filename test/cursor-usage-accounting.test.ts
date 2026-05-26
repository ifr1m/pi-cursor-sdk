import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
	applyCursorApproximateUsage,
	estimateCursorAssistantSessionOutputTokens,
	estimateCursorContextTotalTokens,
} from "../src/cursor-usage-accounting.js";
import { makeModel } from "./helpers/pi-harness.js";

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("cursor usage accounting", () => {
	it("counts assistant session output from text, thinking, and tool calls", () => {
		const textOnly = makeAssistantMessage([{ type: "text", text: "Done." }]);
		const withThinking = makeAssistantMessage([
			{ type: "thinking", thinking: "Inspecting the repository." },
			{ type: "text", text: "Done." },
		]);
		const withToolCall = makeAssistantMessage([
			{ type: "text", text: "I will inspect it." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);

		expect(estimateCursorAssistantSessionOutputTokens(textOnly)).toBeGreaterThan(0);
		expect(estimateCursorAssistantSessionOutputTokens(withThinking)).toBeGreaterThan(estimateCursorAssistantSessionOutputTokens(textOnly));
		expect(estimateCursorAssistantSessionOutputTokens(withToolCall)).toBeGreaterThan(estimateCursorAssistantSessionOutputTokens(textOnly));
	});

	it("applies pi session input/output estimates while deriving totalTokens from replayable context", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([
			{ type: "thinking", thinking: "Need a concise answer." },
			{ type: "text", text: "Hello back." },
		]);
		const sessionInputTokens = 7;

		applyCursorApproximateUsage(partial, model, context, sessionInputTokens);

		expect(partial.usage.input).toBe(sessionInputTokens);
		expect(partial.usage.output).toBe(estimateCursorAssistantSessionOutputTokens(partial));
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeGreaterThan(partial.usage.input);
	});
});
