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
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor", () => {
	beforeEach(resetCursorProviderTestState);

	it("keeps the session agent alive after a successful text-only turn", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockDispose).not.toHaveBeenCalled();
	});

	it("disposes the session agent after a send error", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockRejectedValue(new Error("boom"));
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("recreates the session agent on the next turn after a send error", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		let sendCallCount = 0;
		const mockSend = vi.fn().mockImplementation(async () => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				throw new Error("boom");
			}
			return {
				id: "run-2",
				agentId: "agent-2",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished", result: "Recovered" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockImplementation(async () => ({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		const errorEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getErrorEvent(errorEvents).reason).toBe("error");

		const recoveryEvents = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		expect(getDoneEvent(recoveryEvents).reason).toBe("stop");
		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("reuses the session agent and sends an incremental prompt on follow-up turns", async () => {
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) => {
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: message.text ?? "" }),
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

		const firstContext = makeContext();
		await collectEvents(streamCursor(makeModel(), firstContext, { apiKey: "test-key" }));

		const followUpContext = makeContext();
		followUpContext.messages = [
			...firstContext.messages,
			{ role: "assistant", content: [{ type: "text", text: "Hi there." }], api: "cursor-sdk", provider: "cursor", model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "Follow up", timestamp: 3 },
		];
		await collectEvents(streamCursor(makeModel(), followUpContext, { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledTimes(2);
		const firstPrompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		const secondPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(firstPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(firstPrompt.text).toContain("User: Hello");
		expect(secondPrompt.text).toContain("User: Follow up");
		expect(secondPrompt.text).not.toContain("User: Hello");
	});

	it("recreates the session agent after session-tree invalidation", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockImplementation(async () => ({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		sessionAgentTestUtils.invalidateSessionAgent();
		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("bootstraps with branch summary context after /tree navigation", async () => {
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) => ({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: message.text ?? "" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		}));
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const treeContext = makeContext();
		treeContext.messages = [
			{ role: "user", content: "Hello", timestamp: 1 },
			{
				role: "branchSummary",
				summary: "We explored approach A and rejected it.",
				fromId: "entry-a",
				timestamp: 2,
			} as Context["messages"][number],
			{ role: "user", content: "Continue on approach B", timestamp: 3 },
		];

		await collectEvents(streamCursor(makeModel(), treeContext, { apiKey: "test-key" }));

		const prompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		expect(prompt.text).toContain("We explored approach A and rejected it.");
		expect(prompt.text).toContain("User: Continue on approach B");
	});

	it("recreates the session agent when context diverges and sends a full bootstrap prompt", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockImplementation(async () => ({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		}));
		mockedCreate.mockImplementation(async () => ({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));

		const divergentContext = makeContext();
		divergentContext.messages = [{ role: "user", content: "Hello edited", timestamp: 1 }];
		await collectEvents(streamCursor(makeModel(), divergentContext, { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
		const secondPrompt = mockSend.mock.calls[1]?.[0] as { text?: string };
		expect(secondPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(secondPrompt.text).toContain("User: Hello edited");
	});

	it("recreates the session agent when branch-shrunk context diverges", async () => {
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn().mockImplementation(async () => ({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		}));
		mockedCreate.mockImplementation(async () => ({
			agentId: `agent-${mockedCreate.mock.calls.length + 1}`,
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		}));

		const firstContext = makeContext();
		await collectEvents(streamCursor(makeModel(), firstContext, { apiKey: "test-key" }));

		const followUpContext = makeContext();
		followUpContext.messages = [
			...firstContext.messages,
			{
				role: "assistant",
				content: [{ type: "text", text: "Hi there." }],
				api: "cursor-sdk",
				provider: "cursor",
				model: "test-model",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "Follow up", timestamp: 3 },
		];
		await collectEvents(streamCursor(makeModel(), followUpContext, { apiKey: "test-key" }));

		const shrunkContext = makeContext();
		await collectEvents(streamCursor(makeModel(), shrunkContext, { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(mockDispose).toHaveBeenCalledTimes(1);
		const thirdPrompt = mockSend.mock.calls[2]?.[0] as { text?: string };
		expect(thirdPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(thirdPrompt.text).toContain("User: Hello");
	});

	it("recreates the session agent when the API key changes between turns", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "key-a" }));
		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "key-b" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
	});

	it("rebinds bridge onToolRequest when reusing the session agent on a follow-up turn", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		let turn2OnDelta: CursorDeltaHandler | undefined;
		let resolveTurn2Run: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		let sendCallCount = 0;
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
			sendCallCount += 1;
			if (sendCallCount === 1) {
				opts.onDelta({ update: { type: "text-delta", text: "Hello" } });
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Hello" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			}

			turn2OnDelta = opts.onDelta;
			return {
				id: "run-2",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn(
					() =>
						new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
							resolveTurn2Run = resolve;
						}),
				),
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

		const firstContext = makeContext();
		await collectEvents(streamCursor(makeModel("composer-2"), firstContext, { apiKey: "test-key" }));

		const followUpContext = makeContext();
		followUpContext.messages = [
			...firstContext.messages,
			{ role: "assistant", content: [{ type: "text", text: "Hello" }], api: "cursor-sdk", provider: "cursor", model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "Read README", timestamp: 3 },
		];

		const secondEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), followUpContext, { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));

		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(createOptions.mcpServers.pi_tools.url);
		try {
			const readCallPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			turn2OnDelta?.({ update: { type: "tool-call-started", callId: "mcp-read", toolCall: { name: "mcp", args: { toolName: "pi__read" } } } });

			const secondEvents = await secondEventsPromise;
			const secondDone = getDoneEvent(secondEvents);
			const toolCalls = secondDone.message.content.filter(isToolCallBlock);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(secondDone.reason).toBe("toolUse");
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0]?.name).toBe("read");
			expect(toolCalls[0]?.arguments).toEqual({ path: "README.md" });

			const readToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCalls[0]!.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "file contents" }],
				isError: false,
				timestamp: 4,
			};
			const replayContext = makeContext();
			replayContext.messages = [...followUpContext.messages, secondDone.message, readToolResultMessage];
			const replayEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			resolveTurn2Run({ id: "run-2", status: "finished", result: "Done reading." });
			const replayEvents = await replayEventsPromise;

			expect(getDoneEvent(replayEvents).reason).toBe("stop");
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("surfaces live-run wait error status as a provider error", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "partial" } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "error",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "error", result: "Cursor SDK run failed" }),
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
		const error = getErrorEvent(events);

		expect(error.reason).toBe("error");
		expect(error.error.errorMessage).toContain("Cursor SDK run failed");
		expect(hasEventType(events, "done")).toBe(false);
	});

	it("rejects late bridge MCP calls after a successful live run is released", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});

		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Hello" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(createOptions.mcpServers!.pi_tools.url);
		try {
			const callPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const error = await callPromise.catch((callError: unknown) => callError);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/no active live run|MCP error/i);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("redacts common secret-bearing fields in Cursor SDK error messages", async () => {
		const mockSend = vi.fn().mockRejectedValue(
			new Error(
				'request failed {"apiKey":"super-secret-key-12345","token":"token-value","session_id":"session-value"} cookie: foo=bar; baz=qux',
			),
		);
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		const message = error.error.errorMessage;
		expect(message).toContain('"apiKey":"[redacted]"');
		expect(message).toContain('"token":"[redacted]"');
		expect(message).toContain('"session_id":"[redacted]"');
		expect(message).toContain("cookie: [redacted]");
		expect(message).not.toContain("super-secret-key-12345");
		expect(message).not.toContain("token-value");
		expect(message).not.toContain("session-value");
		expect(message).not.toContain("foo=bar");
		expect(message).not.toContain("baz=qux");
	});

	it("passes bridge MCP servers into Agent.create when active pi tools are exposed", async () => {
		registerBridgeForProviderTest({
			active: ["sem_reindex"],
			tools: [createBridgeToolInfo("sem_reindex", Type.Object({ target: Type.String() }), "Reindex semantic cache")],
		});
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		const createOptions = getCreatedAgentOptions();
		expect(createOptions.local).toEqual({ cwd: process.cwd(), settingSources: ["all"] });
		expect(createOptions.mcpServers?.pi_tools?.type).toBe("http");
		const url = new URL(createOptions.mcpServers.pi_tools.url);
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.pathname).toContain("/cursor-pi-tool-bridge/");
	});


	it("omits overlapping pi built-ins from Agent.create by default and exposes them with explicit opt-in", async () => {
		registerBridgeForProviderTest({
			active: ["read", "bash"],
			tools: [
				createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files"),
				createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run commands"),
			],
		});
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers).toBeUndefined();

		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		await cursorProviderTestUtils.resetSessionCursorAgents();
		vi.clearAllMocks();
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({
			active: ["read", "bash"],
			tools: [
				createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files"),
				createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run commands"),
			],
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-2",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers?.pi_tools?.type).toBe("http");
	});

	it("omits bridge MCP servers from Agent.create when disabled or when the active snapshot is empty", async () => {
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "0";
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBridgeToolInfo("read")],
		});
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers).toBeUndefined();

		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		await cursorProviderTestUtils.resetSessionCursorAgents();
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		vi.clearAllMocks();
		registerBridgeForProviderTest({
			active: ["cursor", "cursor_edit"],
			tools: [createBridgeToolInfo("cursor"), createBridgeToolInfo("cursor_edit")],
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-2",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		expect(getCreatedAgentOptions().mcpServers).toBeUndefined();
	});

	it("emits bridge MCP requests as real pi tool calls and resumes the same Cursor run after tool results", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		const registeredTools: RegisteredTool[] = [];
		await registerNativeToolDisplayForTest(registeredTools);
		registerBridgeForProviderTest({
			active: ["read", "bash"],
			tools: [
				createBuiltinToolInfo("read", Type.Object({ path: Type.String() }), "Read files"),
				createBuiltinToolInfo("bash", Type.Object({ command: Type.String() }), "Run commands"),
			],
		});

		let onDelta: CursorDeltaHandler | undefined;
		let onStep: CursorStepHandler | undefined;
		let resolveRun: (result: { id: string; status: "finished"; result: string }) => void = () => {};
		const runWait = vi.fn(
			() =>
				new Promise<{ id: string; status: "finished"; result: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler; onStep: CursorStepHandler }) => {
			onDelta = opts.onDelta;
			onStep = opts.onStep;
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
			const readCallPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } });
			const bashCallPromise = client.callTool({ name: "pi__bash", arguments: { command: "pwd" } });
			onDelta?.({ update: { type: "tool-call-started", callId: "mcp-read", toolCall: { name: "mcp", args: { toolName: "pi__read" } } } });
			onDelta?.({
				update: {
					type: "tool-call-completed",
					callId: "mcp-read",
					toolCall: {
						name: "mcp",
						result: { status: "success", value: { content: "duplicate bridge replay should be suppressed" } },
					},
				},
			});
			onDelta?.({ update: { type: "tool-call-started", callId: "mcp-read-step", toolCall: { name: "mcp", args: { toolName: "pi__read" } } } });
			onStep?.({
				step: {
					type: "toolCall",
					id: "mcp-read-step",
					message: {
						name: "mcp",
						result: { status: "success", value: { content: "duplicate bridge onStep replay should be suppressed" } },
					},
				},
			});
			onDelta?.({ update: { type: "tool-call-started", callId: "mcp-bash-start-only", toolCall: { name: "mcp", args: { toolName: "pi__bash" } } } });

			const firstEvents = await firstEventsPromise;
			const firstDone = getDoneEvent(firstEvents);
			const toolCalls = firstDone.message.content.filter(isToolCallBlock);
			const trace = collectThinkingDeltas(firstEvents);

			expect(firstDone.reason).toBe("toolUse");
			expect(toolCalls.map((toolCall) => toolCall.name)).toEqual(["read", "bash"]);
			expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
			expect(toolCalls[0].id).toContain("cursor-pi-bridge-");
			expect(toolCalls[0].arguments).toEqual({ path: "README.md" });
			expect(toolCalls[1].arguments).toEqual({ command: "pwd" });
			expect(trace).not.toContain("duplicate bridge replay");
			expect(trace).not.toContain("duplicate bridge onStep");
			expect(trace).not.toContain("Cursor tool started without a completion event");
			expect(nativeToolDisplayTestUtils.nativeToolResultCount()).toBe(0);

			const readToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCalls[0].id,
				toolName: "read",
				content: [{ type: "text" as const, text: "file contents" }],
				isError: false,
				timestamp: 2,
			};
			const bashToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCalls[1].id,
				toolName: "bash",
				content: [{ type: "text" as const, text: "/repo" }],
				isError: false,
				timestamp: 3,
			};
			const replayContext = makeContext();
			replayContext.messages = [
				...replayContext.messages,
				firstDone.message,
				readToolResultMessage,
				bashToolResultMessage,
			];

			const replayEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), replayContext, { apiKey: "test-key" }));
			await expect(readCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "file contents" }] });
			await expect(bashCallPromise).resolves.toMatchObject({ content: [{ type: "text", text: "/repo" }] });
			resolveRun({ id: "run-1", status: "finished", result: "Bridge complete." });
			const replayEvents = await replayEventsPromise;
			const replayText = collectTextDeltas(replayEvents);
			const replayDone = getDoneEvent(replayEvents);

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(mockSend).toHaveBeenCalledTimes(1);
			expect(runWait).toHaveBeenCalledTimes(1);
			expect(replayText).toBe("Bridge complete.");
			expect(replayDone.reason).toBe("stop");
			expect(replayDone.message.usage.input).toBe(
				estimateCursorPromptMessageTokens(readToolResultMessage) + estimateCursorPromptMessageTokens(bashToolResultMessage),
			);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("keeps non-bridge Cursor MCP replay visible while suppressing only bridge MCP calls", async () => {
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBridgeToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					callId: "external-mcp",
					toolCall: {
						name: "mcp",
						args: { toolName: "external_search" },
						result: { status: "success", value: { content: "external result" } },
					},
				},
			});
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
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

		const events = await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);

		expect(trace).toContain("external_search");
		expect(trace).toContain("external result");
		expect(hasEventType(events, "toolcall_start")).toBe(false);
	});

	it("rejects pending bridge MCP waits, clears live runs on idle disposal, and abandons the session agent", async () => {
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		cursorProviderTestUtils.setCursorNativeReplayIdleDisposeMs(1);
		registerBridgeForProviderTest({
			active: ["read"],
			tools: [createBridgeToolInfo("read", Type.Object({ path: Type.String() }), "Read files")],
		});
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const runWait = vi.fn(() => new Promise<{ id: string; status: "finished"; result: string }>(() => {}));
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "running",
			wait: runWait,
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: mockDispose,
		});

		const firstEventsPromise = collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
		const createOptions = getCreatedAgentOptions();
		const { client, transport } = await connectMcpClient(createOptions.mcpServers.pi_tools.url);
		try {
			const callErrorPromise = client.callTool({ name: "pi__read", arguments: { path: "README.md" } }).catch((error: unknown) => error);
			const firstEvents = await firstEventsPromise;
			const firstDone = getDoneEvent(firstEvents);

			expect(firstDone.reason).toBe("toolUse");
			expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(1);

			await vi.waitFor(() => expect(cursorProviderTestUtils.pendingCursorNativeRunCount()).toBe(0));
			const error = await callErrorPromise;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/disposed|cancelled|MCP error/i);
			expect(mockDispose).toHaveBeenCalledTimes(1);
		} finally {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
		}
	});

	it("loads all Cursor setting sources by default for ambient MCP/tools", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd(), settingSources: ["all"] },
			}),
		);
	});

	it("allows Cursor setting sources to be disabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "none";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd() },
			}),
		);
	});

	it("allows Cursor setting sources to be explicitly enabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "all";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd(), settingSources: ["all"] },
			}),
		);
	});

	it("suppresses all direct Cursor SDK startup writes when setting sources are enabled", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "all";
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const createCollector = (chunks: string[]) =>
			((
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
				callback?: (error?: Error | null) => void,
			): boolean => {
				chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
				const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				done?.();
				return true;
			}) as typeof process.stdout.write;
		process.stdout.write = createCollector(stdoutChunks);
		process.stderr.write = createCollector(stderrChunks) as typeof process.stderr.write;
		const consoleSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			process.stdout.write(`${String(message)}\n`);
		});
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
			process.stderr.write(`${String(message)}\n`);
		});
		try {
			const mockSend = vi.fn().mockImplementation(async () => {
				process.stdout.write("VISIBLE non-startup stdout\n");
				process.stderr.write("VISIBLE non-startup stderr\n");
				console.log("VISIBLE non-startup console");
				console.warn(
					'[hooks] SessionStart trigger matcher "startup" is not supported in Cursor, hooks will fire for all triggers',
				);
				console.warn('[hooks] Tool "Glob" is not supported in Cursor and will be ignored');
				process.stdout.write('18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "clone"}\n');
				process.stderr.write('18:05:57.961 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor"}\n');
				console.log('18:05:57.962 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor-sdk"}');
				process.stderr.write("Error initializing ignore mapping for /tmp/project: permission denied\n");
				console.warn("Ripgrep path not configured. Call configureRipgrepPath() at startup.");
				return {
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				};
			});
			mockedCreate.mockImplementationOnce(async () => {
				process.stdout.write('INFO managed_skills.removed meta={skill_id:"clone"}\n');
				process.stderr.write("INFO managed_skills.removed stderr\n");
				console.log("INFO managed_skills.removed via console");
				process.stdout.write("UNEXPECTED startup stdout with test-key\n");
				process.stderr.write("UNEXPECTED startup stderr with test-key\n");
				console.log("UNEXPECTED startup console with test-key");
				return {
					agentId: "agent-1",
					send: mockSend,
					[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
				};
			});

			await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}

		expect(stdoutChunks.join("")).not.toContain("[hooks]");
		expect(stderrChunks.join("")).not.toContain("[hooks]");
		expect(stdoutChunks.join("")).not.toContain("Error initializing ignore mapping for");
		expect(stderrChunks.join("")).not.toContain("Error initializing ignore mapping for");
		expect(stdoutChunks.join("")).not.toContain("Ripgrep path not configured");
		expect(stderrChunks.join("")).not.toContain("Ripgrep path not configured");
		expect(stdoutChunks.join("")).not.toContain("managed_skills.removed");
		expect(stderrChunks.join("")).not.toContain("managed_skills.removed");
		expect(stdoutChunks.join("")).not.toContain("UNEXPECTED startup");
		expect(stderrChunks.join("")).not.toContain("UNEXPECTED startup");
		expect(stdoutChunks.join("")).not.toContain("test-key");
		expect(stderrChunks.join("")).not.toContain("test-key");
		expect(stdoutChunks.join("")).toContain("VISIBLE non-startup stdout");
		expect(stdoutChunks.join("")).toContain("VISIBLE non-startup console");
		expect(stderrChunks.join("")).toContain("VISIBLE non-startup stderr");
		expect(consoleSpy).not.toHaveBeenCalledWith("INFO managed_skills.removed via console");
		expect(consoleSpy).not.toHaveBeenCalledWith("UNEXPECTED startup console with test-key");
		expect(consoleSpy).not.toHaveBeenCalledWith('18:05:57.962 INFO  managed_skills.removed ctx=syncBuiltinSkills meta={skill_id: "cursor-sdk"}');
		expect(consoleSpy).toHaveBeenCalledWith("VISIBLE non-startup console");
		expect(consoleWarnSpy).not.toHaveBeenCalledWith(
			'[hooks] SessionStart trigger matcher "startup" is not supported in Cursor, hooks will fire for all triggers',
		);
		expect(consoleWarnSpy).not.toHaveBeenCalledWith('[hooks] Tool "Glob" is not supported in Cursor and will be ignored');
		consoleSpy.mockRestore();
		consoleWarnSpy.mockRestore();
	});

	it("allows Cursor setting sources to be narrowed", async () => {
		process.env.PI_CURSOR_SETTING_SOURCES = "project,user";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: { cwd: process.cwd(), settingSources: ["project", "user"] },
			}),
		);
	});

});
