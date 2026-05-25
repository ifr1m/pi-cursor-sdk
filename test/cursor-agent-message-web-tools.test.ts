import { describe, expect, it } from "vitest";
import { collectCursorTranscriptWebToolCalls } from "../src/cursor-agent-message-web-tools.js";

describe("collectCursorTranscriptWebToolCalls", () => {
	it("extracts protobuf-style Cursor WebSearch calls from local agent messages", () => {
		const calls = collectCursorTranscriptWebToolCalls([
			{
				type: "user",
				uuid: "agent-1:7",
				agent_id: "agent-1",
				message: {
					turn: {
						case: "agentConversationTurn",
						value: {
							steps: [
								{
									message: {
										case: "toolCall",
										value: {
											tool: {
												case: "webSearchToolCall",
												value: {
													args: { searchTerm: "Cursor IDE", toolCallId: "tool-1" },
													result: {
														result: {
															case: "success",
															value: {
																references: [
																	{
																		title: "Web search results",
																		url: "",
																		chunk: "Links:\n1. [Cursor — Build Software with AI Agents](https://cursor.com/product)",
																	},
																],
															},
														},
													},
												},
											},
										},
									},
								},
							],
						},
					},
				},
			},
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0].identity).toBe("cursor-transcript:agent-1:7:webSearch:tool-1");
		expect(calls[0].toolCall).toEqual({
			name: "webSearch",
			args: { searchTerm: "Cursor IDE", toolCallId: "tool-1" },
			result: {
				status: "success",
				value: {
					content: [
						{
							type: "text",
							text: "Links:\n1. [Cursor — Build Software with AI Agents](https://cursor.com/product)",
						},
					],
				},
			},
		});
	});
});
