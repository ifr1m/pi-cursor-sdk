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


describe("streamCursor", () => {
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

	it("uses Cursor shell-output-delta as display-only fallback when completed shell output is empty", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const command = 'sleep 2 && echo "background job done"';
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { toolName: "run_terminal_cmd", args: { command } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "background job done\n" } } } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						toolName: "run_terminal_cmd",
						result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, executionTime: 2015 } },
					},
					callId: "shell-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall.name).toBe("bash");
		expect(toolCall.arguments).toEqual({ command });

		const bashTool = registeredTools.find((tool) => tool.name === "bash");
		const toolResult = await bashTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult).toMatchObject({
			content: [{ type: "text", text: "background job done" }],
			terminate: false,
		});

		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "bash",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		expect(replayText).toBe("Done.");
	});

	it("drops shell-output-delta fallback data when overlapping shell calls make attribution ambiguous", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 1" } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "partial first output\n" } } } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 2" } }, callId: "shell-2" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "ambiguous output\n" } } } });
			for (const [callId, command] of [
				["shell-1", "sleep 1"],
				["shell-2", "sleep 2"],
			] as const) {
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							name: "shell",
							args: { command },
							result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0, executionTime: 1 } },
						},
						callId,
					},
				});
			}
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Done." }),
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

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("$ sleep 1");
		expect(trace).toContain("$ sleep 2");
		expect(trace).not.toContain("partial first output");
		expect(trace).not.toContain("ambiguous output");
		expect(trace.match(/\(no output\)/g)).toHaveLength(2);
	});

	it("prefers completed shell stdout over Cursor shell-output-delta fallback data", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "printf done" } }, callId: "shell-1" } });
			opts.onDelta({ update: { type: "shell-output-delta", event: { case: "stdout", value: { data: "delta output\n" } } } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "shell",
						result: { status: "success", value: { stdout: "completed output\n", stderr: "", exitCode: 0, executionTime: 1 } },
					},
					callId: "shell-1",
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Done." }),
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

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("completed output");
		expect(trace).not.toContain("delta output");
	});

	it("replays Cursor createPlan as a neutral cursor card before final plan text", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["toolCall"]);
		expect(toolCall.name).toBe("cursor");
		expect(toolCall.arguments).toMatchObject({ totalCount: 0 });

		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult.content[0].text).toContain("createPlan");
		expect(toolResult.details).toMatchObject({ cursorToolName: "createPlan" });

		resolveRun({ id: "run-1", status: "finished", result: "Final Cursor plan text." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
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
		expect(replayText).toBe("Final Cursor plan text.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Final Cursor plan text." }]);
	});

	it("prefers distinct Cursor final result text after pre-plan native replay text", async () => {
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
			opts.onDelta({ update: { type: "text-delta", text: "Compiling the tool inventory and execution status.\n" } });
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const firstText = collectTextDeltas(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);

		expect(firstText).toBe("Compiling the tool inventory and execution status.\n");
		expect(firstDone.reason).toBe("toolUse");
		expect(firstDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(toolCall.name).toBe("cursor");

		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		resolveRun({ id: "run-1", status: "finished", result: "Final plan:\n1. Summarize available tools.\n2. Report execution status." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(replayText).toBe("Final plan:\n1. Summarize available tools.\n2. Report execution status.");
		expect(replayText).not.toContain("Compiling the tool inventory");
		expect(replayDone.message.content).toEqual([
			{ type: "text", text: "Final plan:\n1. Summarize available tools.\n2. Report execution status." },
		]);
	});

	it("emits distinct final result text even after post-replay text deltas", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "createPlan", args: {} }, callId: "plan-1" } });
			onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: { name: "createPlan", args: {}, result: { status: "success", value: {} } },
					callId: "plan-1",
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
		const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "cursor",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const replayEvents: AssistantMessageEvent[] = [];
		let sawPostReplayText: () => void = () => {};
		const postReplayTextSeen = new Promise<void>((resolve) => {
			sawPostReplayText = resolve;
		});
		const replayDonePromise = (async () => {
			for await (const event of streamCursor(makeModel(), replayContext, { apiKey: "test-key" })) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Compiling after replay.\n") sawPostReplayText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Compiling after replay.\n" } });
		await Promise.race([
			postReplayTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for post-replay text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Final Cursor plan text." });
		await replayDonePromise;

		const replayText = collectTextDeltas(replayEvents);
		const replayDone = getDoneEvent(replayEvents);

		expect(replayText).toBe("Compiling after replay.\nFinal Cursor plan text.");
		expect(replayDone.reason).toBe("stop");
		expect(replayDone.message.content).toEqual([
			{ type: "text", text: "Compiling after replay.\n" },
			{ type: "text", text: "Final Cursor plan text." },
		]);
	});

	it("suppresses Cursor tool starts that never receive completion events during native replay", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "mcp", args: { toolName: "demo" } }, callId: "c2" } });
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

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

		const replayEventsPromise = collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const replayEvents = await replayEventsPromise;
		const replayDone = getDoneEvent(replayEvents);
		const replayText = collectTextDeltas(replayEvents);

		expect(replayDone.reason).toBe("stop");
		expect(replayText).toBe("Done.");
		expect(replayDone.message.content).toEqual([{ type: "text", text: "Done." }]);
		expect(replayDone.message.content.some(isToolCallBlock)).toBe(false);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
	});

	it("suppresses a native replay run that only has started Cursor tool calls", async () => {
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
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
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

		const eventsPromise = collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(runWait).toHaveBeenCalledTimes(1));
		resolveRun({ id: "run-1", status: "finished", result: "Done." });
		const events = await eventsPromise;
		const done = getDoneEvent(events);
		const text = collectTextDeltas(events);
		const trace = collectThinkingDeltas(events);

		expect(done.reason).toBe("stop");
		expect(text).toBe("Done.");
		expect(trace).not.toContain("Cursor tool started without a completion event");
		expect(done.message.content).toEqual([{ type: "text", text: "Done." }]);
		expect(hasEventType(events, "toolcall_start")).toBe(false);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
	});

	it("counts thinking plus tool-call replay turns as nonzero assistant activity", async () => {
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
			opts.onDelta({ update: { type: "thinking-delta", text: "Need to inspect the file." } });
			opts.onDelta({ update: { type: "thinking-completed" } });
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

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);

		expect(done.reason).toBe("toolUse");
		expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
		expect(done.message.usage.output).toBeGreaterThan(0);
		expect(done.message.usage.totalTokens).toBeGreaterThan(done.message.usage.input);

		const toolCall = done.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			done.message,
			{
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: "read",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		resolveRun({ id: "run-1", status: "finished", result: "" });
		await Promise.resolve();
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
	});

	it("gives empty final replay turns context total without recounting the original prompt", async () => {
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: toolCall.id,
			toolName: "read",
			content: toolResult.content,
			details: toolResult.details,
			isError: false,
			timestamp: 2,
		};
		const replayContext = makeContext();
		replayContext.messages = [...replayContext.messages, firstDone.message, toolResultMessage];

		expect(runWait).toHaveBeenCalledTimes(1);
		resolveRun({ id: "run-1", status: "finished", result: "" });
		await Promise.resolve();

		const finalEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
		const finalDone = getDoneEvent(finalEvents);

		expect(finalDone.reason).toBe("stop");
		expect(finalDone.message.content).toEqual([]);
		expect(finalDone.message.usage.input).toBe(estimateCursorPromptMessageTokens(toolResultMessage));
		expect(finalDone.message.usage.input).toBeLessThan(firstDone.message.usage.input);
		expect(finalDone.message.usage.output).toBe(0);
		expect(finalDone.message.usage.totalTokens).toBeGreaterThan(finalDone.message.usage.input);
	});

	it("replays Cursor grep activity through native grep display", async () => {
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
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { type: "grep", args: { pattern: "sem_reindex", path: "src" } },
					callId: "c1",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						type: "grep",
						args: { pattern: "sem_reindex", path: "src" },
						result: {
							status: "success",
							value: {
								workspaceResults: {
									src: {
										type: "files",
										output: { files: ["src/tools/reindex.ts"] },
									},
								},
							},
						},
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const trace = collectThinkingDeltas(firstEvents);

		expect(firstDone.reason).toBe("toolUse");
		expect(toolCall.name).toBe("grep");
		expect(toolCall.arguments).toEqual({ pattern: "sem_reindex", path: "src" });
		expect(trace).not.toContain("src/tools/reindex.ts");

		const grepTool = registeredTools.find((tool) => tool.name === "grep");
		const toolResult = await grepTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(toolResult.content[0].text).toContain("src/tools/reindex.ts");

		resolveRun({ id: "run-1", status: "finished", result: "Done." });

		const replayContext = makeContext();
		replayContext.messages = [
			...replayContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "grep",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: 2,
			},
		];
		await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
	});

	it("replays path-only Cursor edit activity through neutral recorded cursor output without pi edit validation", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-edit-replay-"));
		const targetPath = join(dir, ".tool-demo-temp.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: { type: "edit", args: { path: targetPath } }, callId: "c1" } });
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "edit",
							args: { path: targetPath },
							result: {
								status: "success",
								value: { linesAdded: 1, linesRemoved: 1, diffString: `--- a/${targetPath}\n+++ b/${targetPath}` },
							},
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
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("cursor");
			expect(toolCall.arguments).toMatchObject({ path: targetPath });
			expect(toolCall.arguments).not.toHaveProperty("edits");
			const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
			expect(cursorTool).toBeDefined();
			const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`edit ${targetPath}`) }],
				details: { cursorToolName: "edit", title: "Cursor edit", summary: targetPath, diff: `--- a/${targetPath}\n+++ b/${targetPath}` },
				terminate: false,
			});
			expect(toolResult.content[0].text).not.toContain("Validation failed for tool \"edit\"");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			const editTool = registeredTools.find((tool) => tool.name === "edit");
			expect(editTool).toBeDefined();
			await expect(
				editTool!.execute(
					"cursor-replay-1-1-tool-999",
					{ path: targetPath, edits: [{ oldText: "old\n", newText: "mutated\n" }] },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow("replay-only call does not execute file mutations");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "cursor",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays path-only Cursor write activity through neutral recorded cursor output without pi write validation", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-write-path-only-replay-"));
		const targetPath = join(dir, "recorded-write.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { type: "write", args: { path: targetPath } }, callId: "c1" },
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "write",
							args: { path: targetPath },
							result: {
								status: "success",
								value: { linesCreated: 1, fileSize: 4 },
							},
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
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("cursor");
			expect(toolCall.arguments).toMatchObject({ path: targetPath, activityTitle: "Cursor write", activitySummary: targetPath });
			expect(toolCall.arguments).not.toHaveProperty("content");
			const cursorTool = registeredTools.find((tool) => tool.name === "cursor");
			expect(cursorTool).toBeDefined();
			const toolResult = await cursorTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`write ${targetPath}`) }],
				details: { cursorToolName: "write", title: "Cursor write", path: targetPath },
				terminate: false,
			});
			expect(toolResult.content[0].text).not.toContain("Validation failed for tool \"write\"");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "cursor",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays Cursor StrReplace through schema-valid recorded edit output without mutating files", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-strreplace-replay-"));
		const targetPath = join(dir, "recorded-edit.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: {
						type: "tool-call-started",
						toolCall: { type: "StrReplace", args: { path: targetPath, old_string: "old\n", new_string: "new\n" } },
						callId: "c1",
					},
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "StrReplace",
							args: { path: targetPath, old_string: "old\n", new_string: "new\n" },
							result: {
								status: "success",
								value: { linesAdded: 1, linesRemoved: 1, diffString: `--- a/${targetPath}\n+++ b/${targetPath}\n@@ -1 +1 @@\n-old\n+new` },
							},
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
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("edit");
			expect(toolCall.arguments).toEqual({ path: targetPath, edits: [{ oldText: "old\n", newText: "new\n" }] });
			const editTool = registeredTools.find((tool) => tool.name === "edit");
			expect(editTool).toBeDefined();
			const toolResult = await editTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`edit ${targetPath}`) }],
				details: { cursorToolName: "edit", diff: expect.stringContaining("-old") },
				terminate: false,
			});
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "edit",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays Cursor write activity through native-looking recorded write output without mutating files", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		const dir = mkdtempSync(join(tmpdir(), "cursor-write-replay-"));
		const targetPath = join(dir, "recorded-write.txt");
		writeFileSync(targetPath, "old\n");

		try {
			let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
			const runWait = vi.fn(
				() =>
					new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { type: "write", args: { path: targetPath, content: "new\n" } }, callId: "c1" },
				});
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							type: "write",
							args: { path: targetPath, content: "new\n" },
							result: {
								status: "success",
								value: { linesCreated: 1, fileSize: 4, fileContentAfterWrite: "new\n" },
							},
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
			const firstDone = getDoneEvent(firstEvents);
			const toolCall = firstDone.message.content.find(isToolCallBlock);

			expect(toolCall.name).toBe("write");
			expect(toolCall.name).not.toContain("cursor");
			expect(toolCall.arguments).toEqual({ path: targetPath, content: "new\n" });
			const writeTool = registeredTools.find((tool) => tool.name === "write");
			expect(writeTool).toBeDefined();
			const toolResult = await writeTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining(`write ${targetPath}`) }],
				details: { cursorToolName: "write", fileContentAfterWrite: "new\n" },
				terminate: false,
			});
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			await expect(
				writeTool!.execute("cursor-replay-1-1-tool-998", { path: targetPath, content: "mutated\n" }, undefined, undefined, {}),
			).rejects.toThrow("replay-only call does not execute file mutations");
			expect(readFileSync(targetPath, "utf-8")).toBe("old\n");

			resolveRun({ id: "run-1", status: "finished", result: "Done." });

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "write",
					content: toolResult.content,
					details: toolResult.details,
					isError: false,
					timestamp: 2,
				},
			];
			const replayEvents = await collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key" }));
			const replayText = collectTextDeltas(replayEvents);
			expect(replayText).toBe("Done.");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("disposes abandoned native replay runs after the idle timeout and abandons the session agent", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(1);
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);

		expect(done.reason).toBe("toolUse");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(1);
		expect(mockDispose).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0));
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("cleans up pending native replay runs when replay aborts mid-flight and abandons the session agent", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);
		expect(mockDispose).not.toHaveBeenCalled();

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

		const replayEventsPromise = collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key", signal: controller.signal }));
		await Promise.resolve();
		controller.abort();
		const replayEvents = await replayEventsPromise;
		const error = getErrorEvent(replayEvents);

		expect(error.reason).toBe("aborted");
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);

		resolveRun({ id: "run-1", status: "finished", result: "late result" });
		await Promise.resolve();
		await Promise.resolve();

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("cleans up pending native replay runs when the replay signal is already aborted before wait listener registration", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		const mockDispose = vi.fn().mockResolvedValue(undefined);
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
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
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool!.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

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

		let abortedReads = 0;
		const fakeSignal = {
			get aborted() {
				abortedReads += 1;
				return abortedReads >= 2;
			},
			onabort: null,
			reason: undefined,
			throwIfAborted() {
				if (this.aborted) throw this.reason;
			},
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(() => true),
		} satisfies AbortSignal;
		const replayEvents = await Promise.race([
			collectEvents(streamCursor(makeModel(), replayContext, { apiKey: "test-key", signal: fakeSignal })),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for aborted replay")), 100)),
		]);
		const error = getErrorEvent(replayEvents);

		expect(error.reason).toBe("aborted");
		expect(fakeSignal.addEventListener).not.toHaveBeenCalled();
		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);

		resolveRun({ id: "run-1", status: "finished", result: "late result" });
		await Promise.resolve();
		await Promise.resolve();

		expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("streams post-tool Cursor thinking and text while a native replay run is still active", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

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

		const replayStream = streamCursor(makeModel(), replayContext, { apiKey: "test-key" });
		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of replayStream) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Final ") sawLiveText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "thinking-delta", text: "Streaming thought." } });
		onDelta?.({ update: { type: "thinking-completed" } });
		onDelta?.({ update: { type: "text-delta", text: "Final " } });
		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for live Cursor text")), 500)),
		]);
		onDelta?.({ update: { type: "text-delta", text: "answer." } });
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const replayThinking = collectThinkingDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(replayThinking).toBe("Streaming thought.");
		expect(replayText).toBe("Final answer.");
		expect(finalDone.reason).toBe("stop");
		expect(finalDone.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(getTextEndEvent(replayEvents)?.contentIndex).toBe(1);
	});

	it("trims current-turn post-tool native replay final text when streamed text is only a word prefix", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

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

		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of streamCursor(makeModel(), replayContext, { apiKey: "test-key" })) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Disconnect") sawLiveText();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Disconnect" } });
		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for live Cursor text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Disconnecting the CDP session..." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(replayText).toBe("Disconnecting the CDP session...");
		expect(finalDone.reason).toBe("stop");
	});

	it("queues post-tool thinking and text that arrive before the native tool-use turn closes", async () => {
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
			opts.onDelta({ update: { type: "thinking-delta", text: "Post-tool thought." } });
			opts.onDelta({ update: { type: "thinking-completed" } });
			opts.onDelta({ update: { type: "text-delta", text: "Final " } });
			opts.onDelta({ update: { type: "text-delta", text: "answer." } });
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
		const firstDone = getDoneEvent(firstEvents);
		const toolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const toolResult = await readTool.execute(toolCall.id, toolCall.arguments, undefined, undefined, {});

		expect(firstDone.message.content.map((block) => block.type)).toEqual(["toolCall"]);

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

		const replayStream = streamCursor(makeModel(), replayContext, { apiKey: "test-key" });
		const replayEvents: AssistantMessageEvent[] = [];
		let sawLiveText: () => void = () => {};
		const liveTextSeen = new Promise<void>((resolve) => {
			sawLiveText = resolve;
		});
		const replayDone = (async () => {
			for await (const event of replayStream) {
				replayEvents.push(event);
				if (event.type === "text_delta" && event.delta === "Final ") sawLiveText();
			}
		})();

		await Promise.race([
			liveTextSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for queued Cursor text")), 500)),
		]);
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		await replayDone;

		const replayText = collectTextDeltas(replayEvents);
		const replayThinking = collectThinkingDeltas(replayEvents);
		const finalDone = getDoneEvent(replayEvents);

		expect(replayThinking).toBe("Post-tool thought.");
		expect(replayText).toBe("Final answer.");
		expect(finalDone.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(getTextEndEvent(replayEvents)?.contentIndex).toBe(1);
	});


	it("does not duplicate text already emitted before a later native replay tool", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const firstDone = getDoneEvent(firstEvents);
		const firstToolCall = firstDone.message.content.find(isToolCallBlock);
		const readTool = registeredTools.find((tool) => tool.name === "read");
		const firstToolResult = await readTool.execute(firstToolCall.id, firstToolCall.arguments, undefined, undefined, {});

		const secondContext = makeContext();
		secondContext.messages = [
			...secondContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall.id,
				toolName: "read",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
		];

		const secondStream = streamCursor(makeModel(), secondContext, { apiKey: "test-key" });
		const secondEvents: AssistantMessageEvent[] = [];
		let sawSecondTool: () => void = () => {};
		const secondToolSeen = new Promise<void>((resolve) => {
			sawSecondTool = resolve;
		});
		const secondDonePromise = (async () => {
			for await (const event of secondStream) {
				secondEvents.push(event);
				if (event.type === "toolcall_end") sawSecondTool();
			}
		})();

		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Gathering context.\n" } });
		onDelta?.({ update: { type: "tool-call-started", toolCall: { name: "grep", args: { pattern: "cursor", path: "src" } }, callId: "c2" } });
		onDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "grep",
					result: { status: "success", value: { matches: ["src/index.ts"] } },
				},
				callId: "c2",
			},
		});
		await Promise.race([
			secondToolSeen,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for second replay tool")), 500)),
		]);
		await secondDonePromise;

		const secondText = collectTextDeltas(secondEvents);
		expect(secondText).toBe("Gathering context.\n");

		const secondToolCall = (getDoneEvent(secondEvents)).message.content.find(
			isToolCallBlock,
		);
		const grepTool = registeredTools.find((tool) => tool.name === "grep");
		const secondToolResult = await grepTool.execute(secondToolCall.id, secondToolCall.arguments, undefined, undefined, {});

		const finalContext = makeContext();
		finalContext.messages = [
			...finalContext.messages,
			firstDone.message,
			{
				role: "toolResult",
				toolCallId: firstToolCall.id,
				toolName: "read",
				content: firstToolResult.content,
				details: firstToolResult.details,
				isError: false,
				timestamp: 2,
			},
			(getDoneEvent(secondEvents)).message,
			{
				role: "toolResult",
				toolCallId: secondToolCall.id,
				toolName: "grep",
				content: secondToolResult.content,
				details: secondToolResult.details,
				isError: false,
				timestamp: 3,
			},
		];

		const finalEventsPromise = collectEvents(streamCursor(makeModel(), finalContext, { apiKey: "test-key" }));
		await Promise.resolve();
		resolveRun({ id: "run-1", status: "finished", result: "Gathering context.\n" });
		const finalEvents = await finalEventsPromise;
		const finalText = collectTextDeltas(finalEvents);
		const finalDone = getDoneEvent(finalEvents);

		expect(finalText).toBe("");
		expect(finalDone.message.content).toEqual([]);
	});


	it("does not duplicate final result after an earlier post-tool text turn", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
			onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			onDelta({
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
		const readTool = registeredTools.find((tool) => tool.name === "read");

		const context = makeContext();
		const firstEvents = await collectEvents(streamCursor(makeModel(), context, { apiKey: "test-key" }));
		const firstDone = getDoneEvent(firstEvents);
		const firstToolCall = firstDone.message.content.find(isToolCallBlock);
		const firstToolResult = await readTool.execute(firstToolCall.id, firstToolCall.arguments, undefined, undefined, {});
		const firstToolResultMessage = {
			role: "toolResult" as const,
			toolCallId: firstToolCall.id,
			toolName: "read",
			content: firstToolResult.content,
			details: firstToolResult.details,
			isError: false,
			timestamp: 2,
		};
		context.messages.push(firstDone.message, firstToolResultMessage);

		const secondStream = streamCursor(makeModel(), context, { apiKey: "test-key" });
		const secondDonePromise = collectEvents(secondStream);
		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "I am checking helpers." } });
		onDelta?.({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "src/index.ts" } }, callId: "c2" } });
		onDelta?.({
			update: {
				type: "tool-call-completed",
				toolCall: {
					name: "read",
					result: { status: "success", value: { content: "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";" } },
				},
				callId: "c2",
			},
		});
		const secondEvents = await secondDonePromise;
		const secondDone = getDoneEvent(secondEvents);
		const secondToolCall = secondDone.message.content.find(isToolCallBlock);
		const secondToolResult = await readTool.execute(secondToolCall.id, secondToolCall.arguments, undefined, undefined, {});
		const secondToolResultMessage = {
			role: "toolResult" as const,
			toolCallId: secondToolCall.id,
			toolName: "read",
			content: secondToolResult.content,
			details: secondToolResult.details,
			isError: false,
			timestamp: 3,
		};
		context.messages.push(secondDone.message, secondToolResultMessage);

		const finalStream = streamCursor(makeModel(), context, { apiKey: "test-key" });
		const finalEventsPromise = collectEvents(finalStream);
		await Promise.resolve();
		onDelta?.({ update: { type: "text-delta", text: "Final answer." } });
		resolveRun({ id: "run-1", status: "finished", result: "Final answer." });
		const finalEvents = await finalEventsPromise;
		const finalDone = getDoneEvent(finalEvents);
		const finalText = collectTextDeltas(finalEvents);

		expect(runWait).toHaveBeenCalledTimes(1);
		expect(firstDone.message.usage.input).toBeGreaterThan(0);
		expect(firstDone.message.usage.output).toBeGreaterThan(0);
		expect(firstDone.message.usage.totalTokens).toBeGreaterThan(firstDone.message.usage.input + firstDone.message.usage.output);
		expect(secondDone.message.usage.input).toBe(estimateCursorPromptMessageTokens(firstToolResultMessage));
		expect(secondDone.message.usage.input).toBeGreaterThan(0);
		expect(secondDone.message.usage.input).toBeLessThan(firstDone.message.usage.input);
		expect(secondDone.message.usage.output).toBeGreaterThan(0);
		expect(secondDone.message.usage.totalTokens).toBeGreaterThan(secondDone.message.usage.input + secondDone.message.usage.output);
		expect(finalDone.message.usage.input).toBe(estimateCursorPromptMessageTokens(secondToolResultMessage));
		expect(finalDone.message.usage.input).not.toBe(estimateCursorPromptMessageTokens(firstToolResultMessage) + estimateCursorPromptMessageTokens(secondToolResultMessage));
		expect(finalDone.message.usage.input).toBeGreaterThan(0);
		expect(finalDone.message.usage.input).toBeLessThan(firstDone.message.usage.input);
		expect(finalDone.message.usage.output).toBeGreaterThan(0);
		expect(finalDone.message.usage.totalTokens).toBeGreaterThan(finalDone.message.usage.input + finalDone.message.usage.output);
		expect(secondDone.message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(finalText).toBe("Final answer.");
		expect(finalDone.message.content).toEqual([{ type: "text", text: "Final answer." }]);
	});

	it("does not trim final text when pre-tool text is only a word prefix", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		let onDelta: CursorDeltaHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			onDelta = opts.onDelta;
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

		const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(createOptions.mcpServers.pi_tools.url);
		try {
			onDelta?.({ update: { type: "text-delta", text: "Disconnect" } });
			const readCallPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const firstEvents = await firstEventsPromise;
			const firstText = collectTextDeltas(firstEvents);
			const firstDone = getDoneEvent(firstEvents);
			const [toolCall] = firstDone.message.content.filter(isToolCallBlock);

			expect(firstText).toBe("Disconnect");
			expect(toolCall.name).toBe("read");

			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 2,
				},
			];

			const finalEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			resolveRun({ id: "run-1", status: "finished", result: "Disconnecting the CDP session per your choice." });
			const finalEvents = await finalEventsPromise;
			const finalText = collectTextDeltas(finalEvents);
			const finalDone = getDoneEvent(finalEvents);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(runWait).toHaveBeenCalledTimes(1);
			expect(finalText).toBe("Disconnecting the CDP session per your choice.");
			expect(finalDone.message.content).toEqual([{ type: "text", text: "Disconnecting the CDP session per your choice." }]);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});
});
