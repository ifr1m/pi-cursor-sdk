import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	makeAssistantMessage,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import type { Context } from "@earendil-works/pi-ai";


describe("streamCursor stream events", () => {
	beforeEach(resetCursorProviderTestState);

	it("detects trailing user messages only after tool results", () => {
			const base = makeContext();
			const toolResult: Context["messages"][number] = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			};

			expect(cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults(base)).toBe(false);
			expect(
				cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults({
					...base,
					messages: [...base.messages, makeAssistantMessage(), { role: "user", content: "follow up", timestamp: 4 }],
				}),
			).toBe(false);
			expect(
				cursorProviderTestUtils.hasTrailingUserMessagesAfterToolResults({
					...base,
					messages: [...base.messages, makeAssistantMessage(), toolResult, { role: "user", content: "follow up", timestamp: 4 }],
				}),
			).toBe(true);
		});

		it("emits text deltas as pi text stream events", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Hello " } });
				opts.onDelta({ update: { type: "text-delta", text: "world" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);

			const textDeltas = getEventsOfType(events, "text_delta");
			expect(textDeltas).toHaveLength(2);
			expect(textDeltas[0].delta).toBe("Hello ");
			expect(textDeltas[1].delta).toBe("world");

			const done = getDoneEvent(events);
			expect(done).toBeDefined();
		});

		it("emits createPlan args as final visible text when native replay is unavailable", async () => {
			const plan = "Plan:\n1. Create calculator UI.\n2. Implement addition and subtraction.\n3. Add tests.";
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Switching to plan mode.\n" } });
				opts.onDelta({ update: { type: "tool-call-completed", toolCall: { name: "createPlan", args: { plan }, result: { status: "success", value: {} } }, callId: "plan-1" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Switching to plan mode.\n" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const text = collectTextDeltas(events);
			const trace = collectThinkingDeltas(events);
			const done = getDoneEvent(events);

			expect(text).toBe(`Switching to plan mode.\n${plan}`);
			expect(trace).toContain("Create calculator UI");
			expect(done.message.content[0]).toEqual({ type: "text", text: `Switching to plan mode.\n${plan}` });
		});

		it("emits thinking deltas as pi thinking stream events", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "thinking-delta", text: "hmm" } });
				opts.onDelta({ update: { type: "thinking-delta", text: " let me think" } });
				opts.onDelta({ update: { type: "thinking-completed" } });
				opts.onDelta({ update: { type: "text-delta", text: "answer" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);

			const thinkingDeltas = getEventsOfType(events, "thinking_delta");
			expect(thinkingDeltas).toHaveLength(2);

			const thinkingEnd = events.find((event) => event.type === "thinking_end");
			expect(thinkingEnd).toBeDefined();
		});

		it("keeps late cursor thinking in the saved content order after live text", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "Final answer" } });
				opts.onDelta({ update: { type: "thinking-delta", text: "late trace" } });
				opts.onDelta({ update: { type: "thinking-completed" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const done = getDoneEvent(events);

			expect(done.message.content).toEqual([
				{ type: "text", text: "Final answer" },
				{ type: "thinking", thinking: "late trace" },
			]);
		});
});
