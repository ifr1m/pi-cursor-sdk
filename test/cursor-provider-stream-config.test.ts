import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	mockedCreate,
	mockedCreateAgentPlatform,
	makeModel,
	makeContext,
	collectEvents,
	getTextEndEvent,
	mockCreatedAgent,
	createMockAgentPlatform,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import type { Context } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("streamCursor prompt and model config", () => {
	beforeEach(resetCursorProviderTestState);

it("budgets oversized prompt history before Cursor Agent.send", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Keep this system prompt.",
			messages: [
				{ role: "user", content: `old request ${"x".repeat(1200)}`, timestamp: 1 },
				{ role: "user", content: "latest request must remain", timestamp: 2 },
			],
		};
		const smallModel = { ...makeModel("gpt-5.5@1m"), contextWindow: 250, maxTokens: 50 };

		const stream = streamCursor(smallModel, context, { apiKey: "test-key" });
		await collectEvents(stream);

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string };
		expect(sentMessage.text).toContain("Keep this system prompt.");
		expect(sentMessage.text).toContain("latest request must remain");
		expect(sentMessage.text).toContain("Earlier transcript omitted");
		expect(sentMessage.text).not.toContain("old request");
	});

	it("reserves image tokens when budgeting oversized prompt history", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		const context: Context = {
			systemPrompt: "Keep image prompt compact.",
			messages: [
				{ role: "user", content: `old request ${"x".repeat(1200)}`, timestamp: 1 },
				{
					role: "user",
					content: [
						{ type: "text", text: "latest image request" },
						{ type: "image", data: "base64-image", mimeType: "image/png" },
					],
					timestamp: 2,
				},
			],
		};
		const smallModel = { ...makeModel("gpt-5.5@1m"), contextWindow: 250, maxTokens: 50 };

		const stream = streamCursor(smallModel, context, { apiKey: "test-key" });
		await collectEvents(stream);

		const sentMessage = mockSend.mock.calls[0]?.[0] as { text: string; images?: unknown[] };
		expect(sentMessage.text).toContain("latest image request");
		expect(sentMessage.text).toContain("Earlier transcript omitted");
		expect(sentMessage.text).not.toContain("old request");
		expect(sentMessage.images).toEqual([{ data: "base64-image", mimeType: "image/png" }]);
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
		mockCreatedAgent({
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
			mockedCreateAgentPlatform.mockResolvedValue(createMockAgentPlatform(loadLatest));
			const mockSend = vi.fn().mockResolvedValue({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
			mockCreatedAgent({
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
	it("passes Cursor alias model selection back to the SDK", async () => {
		modelDiscoveryTestUtils.registerModelItems([
			{
				id: "gpt-5.5",
				displayName: "GPT-5.5",
				aliases: ["gpt-latest"],
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
						],
						displayName: "GPT-5.5",
						isDefault: true,
					},
				],
			},
		]);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel("gpt-latest@272k"), makeContext(), { apiKey: "test-key", reasoning: "medium" });
		await collectEvents(stream);

		expect(mockedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: {
					id: "gpt-latest",
					params: [
						{ id: "context", value: "272k" },
						{ id: "reasoning", value: "medium" },
					],
				},
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
		mockCreatedAgent({
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
		mockCreatedAgent({
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
		mockCreatedAgent({
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
		mockCreatedAgent({
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
		mockCreatedAgent({
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
		mockCreatedAgent({
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
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const textEnd = getTextEndEvent(events);
		expect(textEnd).toBeDefined();
		expect(textEnd.content).toBe("fallback text");
	});
});
