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
	createBridgeToolInfo,
	cursorModelItems,
	type CursorDeltaHandler,
	type CursorStepHandler,
	type RegisteredTool,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor, __testUtils as cursorProviderTestUtils } from "../src/cursor-provider.js";
import { estimateCursorPromptMessageTokens } from "../src/context.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor native replay live run", () => {
	beforeEach(resetCursorProviderTestState);

it("replays native Cursor tools as a toolUse turn before final text", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "I am checking files." } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk" } },
					},
					callId: "c1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(runWait).toHaveBeenCalledTimes(1);
		const firstDone = getDoneEvent(firstEvents);
		const firstText = collectTextDeltas(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstText).toBe("I am checking files.");
		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.stopReason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(firstDone.message.content[0]).toEqual({ type: "text", text: "I am checking files." });
		expect(toolCall.name).toBe("read");
		expect(hasEventType(firstEvents, "toolcall_delta")).toBe(true);

		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult).toEqual({
			content: [{ type: "text", text: "# pi-cursor-sdk" }],
			details: undefined,
			terminate: false,
		});

		resolveRun({ id: "run-1", status: "finished", result: "Final answer only." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(replayText).toBe("Final answer only.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Final answer only." }]);
	});

	it("resumes an active live run when a steering user message follows tool results", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		let sendCallCount = 0;
		let firstOnDelta: CursorDeltaHandler | undefined;
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }, opts: { onDelta: CursorDeltaHandler }) => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				firstOnDelta = opts.onDelta;
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "bash",
							result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
						},
						callId: "c1",
					},
				});
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			}

			return {
				id: "run-2",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: message.text ?? "" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		expect(toolCall?.name).toBe("bash");
		expect(firstDone.reason).toBe("toolUse");

		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		const toolResult = await bashTool!.execute(toolCall!.id, toolCall!.arguments, undefined, undefined, {});

		const steerContext = makeContext();
		steerContext.messages = [
			...steerContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall!.id,
				toolName: "bash",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "and push", timestamp: 3 },
		];

		const steerEventsPromise = collectEvents(streamCursor(makeModel(), steerContext, { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

		firstOnDelta?.({ update: { type: "text-delta", text: "Old run text that should not leak." } });
		resolveRun({ id: "run-1", status: "finished", result: "Would have kept going without steer." });

		const steerEvents = await steerEventsPromise;
		expect(steerEvents.some((event) => event.type === "error")).toBe(false);
		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockedCreate).toHaveBeenCalledTimes(1);

		const steerPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(steerPrompt.text).toContain("User: and push");
		expect(collectTextDeltas(steerEvents)).not.toContain("Old run text that should not leak.");
		const steerDone = getDoneEvent(steerEvents);
		expect(steerDone.reason).toBe("stop");
	});

	it("settles a scope-active live run directly when context has no matching tool results", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		let firstOnDelta: CursorDeltaHandler | undefined;
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			firstOnDelta = opts.onDelta;
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "bash",
						result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
					},
					callId: "c1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getDoneEvent(firstEvents).reason).toBe("toolUse");

		firstOnDelta?.({ update: { type: "text-delta", text: "Late scoped text." } });
		const scopedEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Late scoped final." });

		const scopedEvents = await Promise.race([
			scopedEventsPromise,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("scope-active live run settlement timed out")), 1000)),
		]);

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(collectTextDeltas(scopedEvents)).toContain("Late scoped text.");
		expect(getDoneEvent(scopedEvents).reason).toBe("stop");
	});


	it("does not let idle disposal release an active run while pre-send drain owns it", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(10);
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const cancelRun = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "bash",
						result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
					},
					callId: "c1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: cancelRun,
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getDoneEvent(firstEvents).reason).toBe("toolUse");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

		const scopedEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
		expect(cancelRun).not.toHaveBeenCalled();
		expect(mockSend).toHaveBeenCalledTimes(1);

		resolveRun({ id: "run-1", status: "finished", result: "Scoped final." });
		const scopedEvents = await scopedEventsPromise;

		expect(collectTextDeltas(scopedEvents)).toBe("Scoped final.");
		expect(getDoneEvent(scopedEvents).reason).toBe("stop");
		expect(cancelRun).not.toHaveBeenCalled();
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("chains steering through an additional old-run native tool batch without leaking old text", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		let sendCallCount = 0;
		let firstOnDelta: CursorDeltaHandler | undefined;
		const mockSend = vi.fn().mockImplementation(async (_message: { text?: string }, opts: { onDelta: CursorDeltaHandler }) => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				firstOnDelta = opts.onDelta;
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "bash",
							result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
						},
						callId: "c1",
					},
				});
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: runWait,
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			}

			return {
				id: "run-2",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: "Fresh chained answer." }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const firstToolCall = firstDone.message.content.find(isToolCallBlock);
		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		const firstToolResult = await bashTool!.execute(firstToolCall!.id, firstToolCall!.arguments, undefined, undefined, {});

		const steerContext = makeContext();
		steerContext.messages = [
			...steerContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall!.id,
				toolName: "bash",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "and push after both tools", timestamp: 3 },
		];

		const secondToolTurnPromise = collectEvents(streamCursor(makeModel(), steerContext, { apiKey: "test-key" }));
		await Promise.resolve();
		firstOnDelta?.({ update: { type: "text-delta", text: "Old run text that should not leak." } });
		firstOnDelta?.({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git log -1" } }, callId: "c2" } });
		firstOnDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "bash",
					result: { status: "success", value: { stdout: "commit abc", stderr: "", exitCode: 0 } },
				},
				callId: "c2",
			},
		});
		const secondToolTurnEvents = await secondToolTurnPromise;
		const secondToolTurnDone = getDoneEvent(secondToolTurnEvents);
		const secondToolCall = secondToolTurnDone.message.content.find(isToolCallBlock);

		expect(secondToolTurnDone.reason).toBe("toolUse");
		expect(secondToolCall?.name).toBe("bash");
		expect(collectTextDeltas(secondToolTurnEvents)).not.toContain("Old run text");
		expect(mockSend).toHaveBeenCalledTimes(1);

		const secondToolResult = await bashTool!.execute(secondToolCall!.id, secondToolCall!.arguments, undefined, undefined, {});
		const finalContext = makeContext();
		finalContext.messages = [
			...steerContext.messages,
			secondToolTurnDone.message,
			{
				role: "toolResult",
				toolCallId: secondToolCall!.id,
				toolName: "bash",
				content: secondToolResult.content,
				details: secondToolResult.details,
				isError: false,
				timestamp: 4,
			},
		];

		const finalEventsPromise = collectEvents(streamCursor(makeModel(), finalContext, { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Old final answer that should not leak." });
		const finalEvents = await finalEventsPromise;

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		const freshPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(freshPrompt.text).toContain("and push after both tools");
		expect(collectTextDeltas(finalEvents)).toBe("Fresh chained answer.");
		expect(collectTextDeltas(finalEvents)).not.toContain("Old final answer");
		expect(getDoneEvent(finalEvents).reason).toBe("stop");
	});

	it("aborts while waiting for an active scoped live run and releases it once", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const cancelRun = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "bash", args: { command: "git status" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "bash",
						result: { status: "success", value: { stdout: "clean", stderr: "", exitCode: 0 } },
					},
					callId: "c1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: runWait,
				cancel: cancelRun,
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getDoneEvent(firstEvents).reason).toBe("toolUse");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

		const scopedEventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal }));
		await Promise.resolve();
		controller.abort();
		const scopedEvents = await scopedEventsPromise;

		expect(getErrorEvent(scopedEvents).reason).toBe("aborted");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(cancelRun).toHaveBeenCalledTimes(1);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});
});
