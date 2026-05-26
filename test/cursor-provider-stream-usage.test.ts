import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import {
	resetCursorProviderTestState,
	mockedCreate,
	mockedCreateAgentPlatform,
	makeModel,
	makeContext,
	makeAssistantMessage,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	getEventsOfType,
	getDoneEvent,
	getErrorEvent,
	getTextEndEvent,
	hasEventType,
	isToolCallBlock,
	isCursorToolStreamEvent,
	getCreatedAgentOptions,
	createMockAgentPlatform,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	connectMcpClient,
	createBuiltinToolInfo,
	createTestToolInfo,
	cursorModelItems,
	type CursorDeltaHandler,
	type CursorStepHandler,
	type RegisteredTool,
	mockCreatedAgent,
	asMockCursorRun,
	getPiToolsMcpUrlFromAgentCreateOptions,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import { __testUtils as sdkEventDebugTestUtils } from "../src/cursor-sdk-event-debug.js";
import type { SDKMessage, SendOptions } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";

type CursorOnStepPayload = Parameters<NonNullable<SendOptions["onStep"]>>[0];
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";




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
