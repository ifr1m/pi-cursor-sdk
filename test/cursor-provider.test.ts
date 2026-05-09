import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @cursor/sdk before importing the module under test
vi.mock("@cursor/sdk", () => {
	const mockCancel = vi.fn().mockResolvedValue(undefined);
	const mockDispose = vi.fn().mockResolvedValue(undefined);

	const mockAgent = {
		agentId: "agent-1",
		send: vi.fn(),
		[Symbol.asyncDispose]: mockDispose,
	};
	const mockPlatform = {
		checkpointStore: {
			loadLatest: vi.fn().mockResolvedValue(undefined),
		},
	};

	return {
		Agent: {
			create: vi.fn().mockResolvedValue(mockAgent),
		},
		createAgentPlatform: vi.fn().mockResolvedValue(mockPlatform),
		_mockAgent: mockAgent,
		_mockCancel: mockCancel,
		_mockDispose: mockDispose,
		_mockPlatform: mockPlatform,
	};
});

import { Agent, createAgentPlatform } from "@cursor/sdk";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import { __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import type { ModelListItem } from "@cursor/sdk";
import type { Context, Model } from "@earendil-works/pi-ai";

// Access the mocks via the module
const mockedCreate = vi.mocked(Agent.create);
const mockedCreateAgentPlatform = vi.mocked(createAgentPlatform);

function makeModel(id = "test-model"): Model<"cursor-sdk"> {
	return {
		id,
		name: "Test Model",
		api: "cursor-sdk" as const,
		provider: "cursor",
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "Be helpful.",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
}

async function collectEvents(stream: ReturnType<typeof streamCursor>) {
	const events: unknown[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

const cursorModelItems: ModelListItem[] = [
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
			{
				id: "reasoning",
				displayName: "Reasoning",
				values: [
					{ value: "none" },
					{ value: "low" },
					{ value: "medium" },
					{ value: "high" },
					{ value: "extra-high" },
				],
			},
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "fast", value: "false" },
					{ id: "reasoning", value: "medium" },
				],
				displayName: "GPT-5.5",
				isDefault: true,
			},
		],
	},
	{
		id: "claude-opus-4-7",
		displayName: "Opus 4.7",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }] },
			{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
			{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "effort", value: "xhigh" },
					{ id: "thinking", value: "true" },
				],
				displayName: "Opus 4.7",
				isDefault: true,
			},
		],
	},
	{
		id: "claude-sonnet-4-6",
		displayName: "Sonnet 4.6",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }] },
			{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
			{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "effort", value: "medium" },
					{ id: "thinking", value: "true" },
				],
				displayName: "Sonnet 4.6",
				isDefault: true,
			},
		],
	},
];

describe("streamCursor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		modelDiscoveryTestUtils.registerModelItems(cursorModelItems);
		// Re-setup default mock return after clearing
		mockedCreate.mockResolvedValue({
			agentId: "agent-1",
			send: vi.fn(),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		mockedCreateAgentPlatform.mockResolvedValue({
			checkpointStore: {
				loadLatest: vi.fn().mockResolvedValue(undefined),
			},
		} as any);
	});

	it("emits text deltas as pi text stream events", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({ update: { type: "text-delta", text: "Hello " } });
			opts.onDelta({ update: { type: "text-delta", text: "world" } });
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const textDeltas = events.filter((e: any) => e.type === "text_delta");
		expect(textDeltas).toHaveLength(2);
		expect(textDeltas[0].delta).toBe("Hello ");
		expect(textDeltas[1].delta).toBe("world");

		const done = events.find((e: any) => e.type === "done");
		expect(done).toBeDefined();
	});

	it("emits thinking deltas as pi thinking stream events", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({ update: { type: "thinking-delta", text: "hmm" } });
			opts.onDelta({ update: { type: "thinking-delta", text: " let me think" } });
			opts.onDelta({ update: { type: "thinking-completed" } });
			opts.onDelta({ update: { type: "text-delta", text: "answer" } });
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const thinkingDeltas = events.filter((e: any) => e.type === "thinking_delta");
		expect(thinkingDeltas).toHaveLength(2);

		const thinkingEnd = events.find((e: any) => e.type === "thinking_end");
		expect(thinkingEnd).toBeDefined();
	});

	it("does not emit pi tool call events for cursor tool deltas", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read_file" }, callId: "c1" } });
			opts.onDelta({ update: { type: "tool-call-completed", toolCall: { name: "read_file" }, callId: "c1" } });
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const toolEvents = events.filter((e: any) =>
			["toolcall_start", "toolcall_delta", "toolcall_end"].includes(e.type),
		);
		expect(toolEvents).toHaveLength(0);
	});

	it("surfaces cursor tool results as pi-like trace transcript without polluting final text", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "README.md" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: { status: "success", value: { content: "# pi-cursor-sdk\n\nReadme body", totalLines: 3, fileSize: 29 } },
					},
					callId: "c1",
				},
			});
			opts.onDelta({ update: { type: "summary", summary: "Inspected files" } });
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = events.filter((e: any) => e.type === "thinking_delta").map((e: any) => e.delta).join("");
		const text = events.filter((e: any) => e.type === "text_delta").map((e: any) => e.delta).join("");
		const done = events.find((e: any) => e.type === "done") as any;

		expect(trace).toContain("read README.md");
		expect(trace).toContain("# pi-cursor-sdk");
		expect(trace).not.toContain("Cursor tool: read started");
		expect(trace).not.toContain("call c1");
		expect(trace).toContain("Cursor summary: Inspected files");
		expect(text).toBe("done");
		expect(done.message.content.map((block: any) => block.type)).toEqual(["thinking", "thinking", "text"]);
	});

	it("prefers the final run result over intermediate cursor progress text", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({ update: { type: "text-delta", text: "I’m checking files." } });
			opts.onDelta({ update: { type: "text-delta", text: "I found the issue." } });
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "Final answer only." }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const text = events.filter((e: any) => e.type === "text_delta").map((e: any) => e.delta).join("");

		expect(text).toBe("Final answer only.");
		expect(text).not.toContain("I’m checking files");
	});

	it("omits raw cursor call ids while rendering completed cursor tools", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({
				update: {
					type: "tool-call-started",
					toolCall: { name: "shell", args: { command: "date" } },
					callId: "call_abc\nfc_secret",
				},
			});
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "shell",
						result: { status: "success", value: { stdout: "Sat May  9\n", stderr: "", exitCode: 0, executionTime: 12 } },
					},
					callId: "call_abc\nfc_secret",
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const trace = events.filter((e: any) => e.type === "thinking_delta").map((e: any) => e.delta).join("");

		expect(trace).toContain("$ date\n");
		expect(trace).toContain("Sat May  9");
		expect(trace).toContain("Took 0.0s");
		expect(trace).not.toContain("call_abc");
		expect(trace).not.toContain("fc_secret");
	});

	it("scrubs secrets from cursor tool transcript output", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({ update: { type: "tool-call-started", toolCall: { name: "read", args: { path: "secrets.txt" } }, callId: "c1" } });
			opts.onDelta({
				update: {
					type: "tool-call-completed",
					toolCall: {
						name: "read",
						result: {
							status: "success",
							value: { content: "token=super-secret-key-12345\nAuthorization: Bearer bearer-token-value" },
						},
					},
					callId: "c1",
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
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);
		const trace = events.filter((e: any) => e.type === "thinking_delta").map((e: any) => e.delta).join("");

		expect(trace).toContain("read secrets.txt");
		expect(trace).toContain("[redacted]");
		expect(trace).not.toContain("super-secret-key-12345");
		expect(trace).not.toContain("bearer-token-value");
	});

	it("keeps late cursor thinking before final text in the saved content order", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
			opts.onDelta({ update: { type: "text-delta", text: "Final answer" } });
			opts.onDelta({ update: { type: "thinking-delta", text: "late trace" } });
			opts.onDelta({ update: { type: "thinking-completed" } });
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const done = events.find((e: any) => e.type === "done") as any;

		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "late trace" },
			{ type: "text", text: "Final answer" },
		]);
	});

	it("uses pi prompt/output estimates instead of Cursor cumulative internal usage", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: (a: unknown) => void }) => {
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
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const done = events.find((e: any) => e.type === "done") as any;

		expect(done.message.usage.input).toBeGreaterThan(0);
		expect(done.message.usage.output).toBe(1);
		expect(done.message.usage.cacheRead).toBe(0);
		expect(done.message.usage.cacheWrite).toBe(0);
		expect(done.message.usage.totalTokens).toBeLessThan(1000);
	});

	it("aborts after agent creation without sending a prompt when already cancelled", async () => {
		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn();
		mockedCreate.mockImplementation(async () => {
			controller.abort();
			return {
				send: mockSend,
				[Symbol.asyncDispose]: mockDispose,
			};
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal });
		const events = await collectEvents(stream);
		const error = events.find((e: any) => e.type === "error") as any;

		expect(error.reason).toBe("aborted");
		expect(error.error.stopReason).toBe("aborted");
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("emits actionable error when no API key", async () => {
		const stream = streamCursor(makeModel(), makeContext(), { apiKey: undefined });
		const events = await collectEvents(stream);

		const error = events.find((e: any) => e.type === "error");
		expect(error).toBeDefined();
		expect((error as any).error.errorMessage).toContain("/login");
		expect((error as any).error.errorMessage).toContain("CURSOR_API_KEY");
		expect((error as any).error.errorMessage).toContain("--api-key");
	});

	it("treats unresolved CURSOR_API_KEY provider placeholders as a missing API key", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		delete process.env.CURSOR_API_KEY;
		try {
			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "CURSOR_API_KEY" });
			const events = await collectEvents(stream);

			const error = events.find((e: any) => e.type === "error");
			expect(error).toBeDefined();
			expect((error as any).error.errorMessage).toBe(
				"Cursor SDK runs require a Cursor API key. Run /login -> Use an API key -> Cursor, set CURSOR_API_KEY before starting pi, or restart pi with --api-key.",
			);
			expect(mockedCreate).not.toHaveBeenCalled();
		} finally {
			if (originalKey === undefined) {
				delete process.env.CURSOR_API_KEY;
			} else {
				process.env.CURSOR_API_KEY = originalKey;
			}
		}
	});

	it("resolves CURSOR_API_KEY provider placeholders through the env var when present", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "env-key-123";
		try {
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

			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "CURSOR_API_KEY" });
			await collectEvents(stream);

			expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "env-key-123" }));
		} finally {
			if (originalKey === undefined) {
				delete process.env.CURSOR_API_KEY;
			} else {
				process.env.CURSOR_API_KEY = originalKey;
			}
		}
	});

	it("turns generic Cursor SDK failures into actionable setup errors", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Error"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const error = events.find((e: any) => e.type === "error");
		expect(error).toBeDefined();
		expect((error as any).error.errorMessage).toContain("Cursor SDK request failed");
		expect((error as any).error.errorMessage).toContain("/login");
		expect((error as any).error.errorMessage).toContain("CURSOR_API_KEY");
		expect((error as any).error.errorMessage).toContain("--api-key");
		expect((error as any).error.errorMessage).not.toBe("Error");
	});

	it("labels likely auth failures without leaking the supplied API key", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Unauthorized Bearer super-secret-key-12345"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);

		const error = events.find((e: any) => e.type === "error");
		const message = (error as any).error.errorMessage;
		expect(message).toContain("invalid or unauthorized");
		expect(message).toContain("/login");
		expect(message).toContain("CURSOR_API_KEY");
		expect(message).not.toContain("super-secret-key-12345");
	});

	it("disposes agent on success", async () => {
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

		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("disposes agent on error", async () => {
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

		const error = events.find((e: any) => e.type === "error") as any;
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

	it("cancels run on abort signal", async () => {
		const controller = new AbortController();
		const mockCancel = vi.fn().mockResolvedValue(undefined);
		let resolveWait: () => void;
		const waitPromise = new Promise<{ id: string; status: string }>((resolve) => {
			resolveWait = () => resolve({ id: "run-1", status: "cancelled" });
		});
		const mockSend = vi.fn().mockImplementation(async () => {
			return {
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockReturnValue(waitPromise),
				cancel: mockCancel,
				supports: () => true,
				unsupportedReason: () => undefined,
			};
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), {
			apiKey: "test-key",
			signal: controller.signal,
		});

		// Give the async IIFE time to start the run
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());

		// Now abort
		controller.abort();

		// Let the run resolve
		resolveWait!();

		await collectEvents(stream);

		expect(mockCancel).toHaveBeenCalled();
	});

	it("forwards latest user images to Cursor Agent.send", async () => {
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
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this image" },
						{ type: "image", data: "base64-image", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};

		const stream = streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [{ data: "base64-image", mimeType: "image/png" }],
			}),
			expect.any(Object),
		);
	});

	it("caches SDK checkpoint context windows after successful runs", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-provider-context-window-"));
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			const loadLatest = vi.fn().mockResolvedValue({ tokenDetails: { usedTokens: 8435, maxTokens: 201000 } });
			mockedCreateAgentPlatform.mockResolvedValue({ checkpointStore: { loadLatest } } as any);
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
				agentId: "agent-ctx",
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
			await collectEvents(stream);

			expect(loadLatest).toHaveBeenCalledWith("agent-ctx");
			const cache = JSON.parse(readFileSync(contextWindowCacheTestUtils.getCachePath(), "utf-8"));
			expect(cache.contextWindows).toEqual({ "composer-2": 201000 });
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("creates local Cursor agents without ambient setting sources that write SDK logs to the terminal", async () => {
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

	it("passes Cursor model selection with context and pi thinking off to Agent.create", async () => {
		const modelWithParams = makeModel("gpt-5.5@1m");
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

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "1m" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "none" },
					],
				},
			}),
		);
	});

	it("applies pi medium thinking level to Cursor reasoning parameter", async () => {
		const modelWithParams = {
			...makeModel("gpt-5.5@1m"),
			reasoning: true,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "extra-high", off: null, minimal: null },
		};
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

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "medium" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "1m" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "medium" },
					],
				},
			}),
		);
	});

	it("maps pi xhigh thinking to Cursor extra-high reasoning for a sibling context", async () => {
		const modelWithParams = {
			...makeModel("gpt-5.5@272k"),
			reasoning: true,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "extra-high", off: null, minimal: null },
		};
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

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "xhigh" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-5.5",
					params: [
						{ id: "context", value: "272k" },
						{ id: "fast", value: "false" },
						{ id: "reasoning", value: "extra-high" },
					],
				},
			}),
		);
	});

	it("applies pi thinking level to Cursor Claude effort and thinking parameters", async () => {
		const modelWithParams = {
			...makeModel("claude-opus-4-7@1m"),
			reasoning: true,
			thinkingLevelMap: {
				off: "false",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			},
		};
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

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key", reasoning: "xhigh" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "claude-opus-4-7",
					params: [
						{ id: "context", value: "1m" },
						{ id: "effort", value: "xhigh" },
						{ id: "thinking", value: "true" },
					],
				},
			}),
		);
	});

	it("turns Cursor thinking off when pi thinking is off", async () => {
		const modelWithParams = {
			...makeModel("claude-sonnet-4-6@1m"),
			reasoning: true,
			thinkingLevelMap: { off: "false", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		};
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

		const stream = streamCursor(modelWithParams, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "claude-sonnet-4-6",
					params: [
						{ id: "context", value: "1m" },
						{ id: "thinking", value: "false" },
					],
				},
			}),
		);
	});

	it("passes plain model id without params to Agent.create", async () => {
		const plainModel = makeModel("gemini-3.1-pro");
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

		const stream = streamCursor(plainModel, makeContext(), { apiKey: "test-key" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: { id: "gemini-3.1-pro" },
			}),
		);
	});

	it("emits result text when no deltas were received", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "fallback text" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedCreate.mockResolvedValue({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const textEnd = events.find((e: any) => e.type === "text_end");
		expect(textEnd).toBeDefined();
		expect((textEnd as any).content).toBe("fallback text");
	});
});
