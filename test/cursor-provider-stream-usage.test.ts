import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	getDoneEvent,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";


describe("streamCursor usage accounting", () => {
	beforeEach(resetCursorProviderTestState);

		it("uses pi prompt/output estimates instead of Cursor cumulative internal usage", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "turn-ended",
						usage: {
							inputTokens: 6746960,
							outputTokens: 17701,
							cacheReadTokens: 6559232,
							cacheWriteTokens: 0,
						},
					},
				});
				opts.onDelta({ update: { type: "text-delta", text: "done" } });
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

			expect(done.message.usage.input).toBeGreaterThan(0);
			expect(done.message.usage.output).toBe(1);
			expect(done.message.usage.cacheRead).toBe(0);
			expect(done.message.usage.cacheWrite).toBe(0);
			expect(done.message.usage.totalTokens).toBeLessThan(1000);
		});
});
