import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	discoverModels,
	buildCursorModelSelection,
	getCursorModelMetadata,
	getCursorModelMetadataEntries,
	__testUtils,
} from "../src/model-discovery.js";
import { saveCachedContextWindow } from "../src/context-window-cache.js";

vi.mock("@cursor/sdk", () => ({
	Cursor: {
		models: {
			list: vi.fn(),
		},
	},
}));

import { Cursor } from "@cursor/sdk";
import type { ModelListItem } from "@cursor/sdk";

const mockedList = vi.mocked(Cursor.models.list);

function register(items: ModelListItem[]) {
	return __testUtils.registerModelItems(items);
}

describe("discoverModels", () => {
	const originalEnv = process.env;
	const originalArgv = process.argv;

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.argv = [...originalArgv];
	});

	afterEach(() => {
		process.env = originalEnv;
		process.argv = originalArgv;
		vi.clearAllMocks();
	});

	it("returns context-qualified fallback models when no API key", async () => {
		delete process.env.CURSOR_API_KEY;
		const issues: unknown[] = [];
		const models = await discoverModels({ onFallback: (issue) => issues.push(issue) });
		expect(models.map((model) => model.id)).toEqual([
			"claude-opus-4-7@1m",
			"claude-opus-4-7@300k",
			"claude-sonnet-4-6@1m",
			"claude-sonnet-4-6@300k",
			"composer-2",
			"gpt-5.5@1m",
			"gpt-5.5@272k",
		]);
		expect(issues).toEqual([
			expect.objectContaining({
				reason: "missing-api-key",
				message: expect.stringContaining("CURSOR_API_KEY"),
			}),
		]);
		expect(JSON.stringify(issues)).toContain("--api-key");
		expect(mockedList).not.toHaveBeenCalled();
	});

	it("returns fallback models and reports missing key when API key is whitespace", async () => {
		process.env.CURSOR_API_KEY = "   ";
		const issues: unknown[] = [];
		const models = await discoverModels({ onFallback: (issue) => issues.push(issue) });
		expect(models.some((model) => model.id === "gpt-5.5@1m")).toBe(true);
		expect(issues).toEqual([expect.objectContaining({ reason: "missing-api-key" })]);
		expect(mockedList).not.toHaveBeenCalled();
	});

	it("uses pi --api-key for model discovery when CURSOR_API_KEY is unset", async () => {
		delete process.env.CURSOR_API_KEY;
		process.argv = ["node", "pi", "--api-key", "cli-key-123"];
		mockedList.mockResolvedValueOnce([
			{
				id: "composer-2",
				displayName: "Composer 2",
				variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
			},
		]);

		const models = await discoverModels();

		expect(mockedList).toHaveBeenCalledWith({ apiKey: "cli-key-123" });
		expect(models.map((model) => model.id)).toEqual(["composer-2"]);
	});

	it("parses pi --api-key=value for model discovery", () => {
		expect(__testUtils.getCliApiKeyFromArgv(["node", "pi", "--api-key=cli-key-123"])).toBe("cli-key-123");
		expect(__testUtils.getCliApiKeyFromArgv(["node", "pi", "--api-key", "--list-models"])).toBeUndefined();
	});

	it("calls Cursor.models.list with API key and sorts by base id", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "model-b",
				displayName: "Model B",
				variants: [{ params: [], displayName: "Model B", isDefault: true }],
			},
			{
				id: "model-a",
				displayName: "Model A",
				variants: [{ params: [], displayName: "Model A", isDefault: true }],
			},
		]);
		const models = await discoverModels();
		expect(mockedList).toHaveBeenCalledWith({ apiKey: "test-key-123" });
		expect(models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		expect(models[0].name).toBe("Model A");
	});

	it("sorts by base id while preserving Cursor SDK context value order inside each model", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "z-model",
				displayName: "Z Model",
				parameters: [{ id: "context", displayName: "Context", values: [{ value: "long" }, { value: "short" }] }],
				variants: [{ params: [{ id: "context", value: "short" }], displayName: "Z Model", isDefault: true }],
			},
			{
				id: "a-model",
				displayName: "A Model",
				parameters: [{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] }],
				variants: [{ params: [{ id: "context", value: "1m" }], displayName: "A Model", isDefault: true }],
			},
		]);

		const models = await discoverModels();

		expect(models.map((model) => model.id)).toEqual(["a-model@300k", "a-model@1m", "z-model@long", "z-model@short"]);
		expect(getCursorModelMetadata("a-model@300k")?.defaultParams).toEqual([{ id: "context", value: "300k" }]);
		expect(getCursorModelMetadata("z-model@long")?.defaultParams).toEqual([{ id: "context", value: "long" }]);
	});

	it("registers one pi model per Cursor context value", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "272k" }, { value: "1m" }] },
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [{ value: "none" }, { value: "medium" }],
					},
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
							{ id: "fast", value: "false" },
						],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels();
		expect(models.map((model) => model.id)).toEqual(["gpt-5.4@272k", "gpt-5.4@1m"]);
		expect(models[0].contextWindow).toBe(272000);
		expect(models[1].contextWindow).toBe(1000000);
		expect(models[0].name).toBe("GPT-5.4 @ 272k");

		const metadata = getCursorModelMetadata("gpt-5.4@272k");
		expect(metadata).toMatchObject({
			baseModelId: "gpt-5.4",
			context: "272k",
			supportsFast: true,
			defaultFast: false,
		});
		expect(metadata?.defaultParams).toEqual([
			{ id: "context", value: "272k" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "false" },
		]);
	});

	it("does not encode reasoning, effort, thinking, or fast into pi model IDs", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.3-codex",
				displayName: "GPT-5.3 Codex",
				parameters: [
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "high" }] },
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "reasoning", value: "high" },
							{ id: "fast", value: "true" },
						],
						displayName: "GPT-5.3 Codex",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels();
		expect(models[0].id).toBe("gpt-5.3-codex");
		expect(getCursorModelMetadata("gpt-5.3-codex")?.defaultParams).toEqual([
			{ id: "reasoning", value: "high" },
			{ id: "fast", value: "true" },
		]);
	});

	it("uses bundled SDK-derived context windows for models without context params", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-bundled-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
					variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2", isDefault: true }],
				},
			]);

			const models = await discoverModels();

			expect(models[0].id).toBe("composer-2");
			expect(models[0].contextWindow).toBe(200000);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("lets user cache override bundled context windows", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			saveCachedContextWindow("composer-2", 201000);
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
					variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2", isDefault: true }],
				},
			]);

			const models = await discoverModels();

			expect(models[0].id).toBe("composer-2");
			expect(models[0].contextWindow).toBe(201000);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("sets reasoning false for models without thinking controls", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gemini-3.1-pro",
				displayName: "Gemini 3.1 Pro",
				variants: [{ params: [], displayName: "Gemini 3.1 Pro", isDefault: true }],
			},
		]);
		const models = await discoverModels();
		expect(models[0].reasoning).toBe(false);
		expect(models[0].thinkingLevelMap).toBeUndefined();
	});

	it("maps Cursor reasoning values to pi thinking levels", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [
							{ value: "none" },
							{ value: "minimal" },
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "extra-high" },
						],
					},
				],
				variants: [
					{
						params: [{ id: "reasoning", value: "medium" }],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels();
		expect(models[0].thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "extra-high",
		});
	});

	it("maps boolean Cursor thinking values to off and high with explicit unsupported nulls", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-haiku-4-5",
				displayName: "Haiku 4.5",
				parameters: [
					{
						id: "thinking",
						displayName: "Thinking",
						values: [{ value: "false" }, { value: "true" }],
					},
				],
				variants: [
					{
						params: [{ id: "thinking", value: "true" }],
						displayName: "Haiku 4.5",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels();
		expect(models[0].thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: null,
			medium: null,
			high: "true",
			xhigh: null,
		});
	});

	it("maps Claude effort and prefers exact xhigh over max and extra-high", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-opus-4-7",
				displayName: "Opus 4.7",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
					{
						id: "effort",
						displayName: "Effort",
						values: [
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "xhigh" },
							{ value: "max" },
							{ value: "extra-high" },
						],
					},
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "context", value: "1m" },
							{ id: "effort", value: "xhigh" },
						],
						displayName: "Opus 4.7",
						isDefault: true,
					},
				],
			},
		]);
		const models = await discoverModels();
		expect(models.map((model) => model.id)).toEqual(["claude-opus-4-7@300k", "claude-opus-4-7@1m"]);
		expect(models[0].contextWindow).toBe(300000);
		expect(models[1].contextWindow).toBe(1000000);
		expect(models[0].thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		});
	});

	it("registers text and image input for Cursor models", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "vision-capable",
				displayName: "Vision Capable",
				variants: [{ params: [], displayName: "Vision Capable", isDefault: true }],
			},
		]);

		const models = await discoverModels();

		expect(models[0].input).toEqual(["text", "image"]);
	});

	it("maps reasoning off to unsupported null when Cursor exposes no none or off value", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "reasoning-only",
				displayName: "Reasoning Only",
				parameters: [
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
					},
				],
				variants: [{ params: [{ id: "reasoning", value: "medium" }], displayName: "Reasoning Only", isDefault: true }],
			},
		]);

		const models = await discoverModels();

		expect(models[0].thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
		});
		expect(buildCursorModelSelection("reasoning-only", "off")).toEqual({
			id: "reasoning-only",
			params: [{ id: "reasoning", value: "medium" }],
		});
	});

	it("maps boolean thinking plus effort to thinking=true with effort and off to thinking=false without effort", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-like",
				displayName: "Claude Like",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "effort", value: "medium" },
						],
						displayName: "Claude Like",
						isDefault: true,
					},
				],
			},
		]);

		const models = await discoverModels();

		expect(models[0].thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
		});
		expect(buildCursorModelSelection("claude-like", "high")).toEqual({
			id: "claude-like",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "effort", value: "high" },
			],
		});
		expect(buildCursorModelSelection("claude-like", "off")).toEqual({
			id: "claude-like",
			params: [{ id: "thinking", value: "false" }],
		});
	});

	it("keeps fallback model IDs aligned with the documented fallback list", async () => {
		delete process.env.CURSOR_API_KEY;

		const models = await discoverModels();

		expect(models.map((model) => model.id)).toEqual([
			"claude-opus-4-7@1m",
			"claude-opus-4-7@300k",
			"claude-sonnet-4-6@1m",
			"claude-sonnet-4-6@300k",
			"composer-2",
			"gpt-5.5@1m",
			"gpt-5.5@272k",
		]);
	});

	it("falls back and reports discovery failure when Cursor.models.list throws", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		const issues: unknown[] = [];
		mockedList.mockRejectedValueOnce(new Error("network error"));
		const models = await discoverModels({ onFallback: (issue) => issues.push(issue) });
		expect(models.some((model) => model.id === "composer-2")).toBe(true);
		expect(issues).toEqual([
			expect.objectContaining({
				reason: "discovery-failed",
				message: expect.stringContaining("Cursor model discovery failed"),
			}),
		]);
		expect(JSON.stringify(issues)).not.toContain("test-key-123");
	});

	it("falls back and reports empty model list when Cursor.models.list returns empty", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		const issues: unknown[] = [];
		mockedList.mockResolvedValueOnce([]);
		const models = await discoverModels({ onFallback: (issue) => issues.push(issue) });
		expect(models.some((model) => model.id === "claude-opus-4-7@1m")).toBe(true);
		expect(issues).toEqual([
			expect.objectContaining({
				reason: "empty-model-list",
				message: expect.stringContaining("Cursor model discovery returned no models"),
			}),
		]);
	});

	it("uses id as name when displayName is missing", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{ id: "raw-id", variants: [{ params: [], displayName: "raw-id", isDefault: true }] } as ModelListItem,
		]);
		const models = await discoverModels();
		expect(models[0].name).toBe("raw-id");
	});

	it("uses first variant when no isDefault is marked", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "test-model",
				displayName: "Test Model",
				parameters: [{ id: "reasoning", displayName: "Reasoning", values: [{ value: "low" }, { value: "high" }] }],
				variants: [
					{ params: [{ id: "reasoning", value: "low" }], displayName: "Test Model" },
					{ params: [{ id: "reasoning", value: "high" }], displayName: "Test Model" },
				],
			},
		]);
		const models = await discoverModels();
		expect(models[0].id).toBe("test-model");
		expect(buildCursorModelSelection("test-model", "off")).toEqual({
			id: "test-model",
			params: [{ id: "reasoning", value: "low" }],
		});
	});
});

describe("buildCursorModelSelection", () => {
	beforeEach(() => {
		register([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
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
							{ id: "reasoning", value: "medium" },
							{ id: "fast", value: "false" },
						],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
			{
				id: "claude-opus-4-7",
				displayName: "Opus 4.7",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "300k" }] },
					{
						id: "effort",
						displayName: "Effort",
						values: [
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "xhigh" },
						],
					},
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "context", value: "1m" },
							{ id: "effort", value: "xhigh" },
						],
						displayName: "Opus 4.7",
						isDefault: true,
					},
				],
			},
		]);
	});

	it("uses selected context, pi thinking, and fast state", () => {
		expect(buildCursorModelSelection("gpt-5.4@272k", "xhigh", true)).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "extra-high" },
				{ id: "fast", value: "true" },
			],
		});
	});

	it("turns Claude thinking off and omits effort when pi thinking is off", () => {
		expect(buildCursorModelSelection("claude-opus-4-7@300k", "off")).toEqual({
			id: "claude-opus-4-7",
			params: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: "300k" },
			],
		});
	});

	it("turns Claude thinking on and maps effort when pi thinking is enabled", () => {
		expect(buildCursorModelSelection("claude-opus-4-7@1m", "high")).toEqual({
			id: "claude-opus-4-7",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "1m" },
				{ id: "effort", value: "high" },
			],
		});
	});

	it("passes unknown model IDs through plainly", () => {
		expect(buildCursorModelSelection("gemini-3.1-pro", "off")).toEqual({ id: "gemini-3.1-pro" });
	});

	it("returns cloned metadata entries", () => {
		const entries = getCursorModelMetadataEntries();
		const metadata = entries.find((entry) => entry.piModelId === "gpt-5.4@1m");
		expect(metadata?.defaultParams).toEqual([
			{ id: "context", value: "1m" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "false" },
		]);
		metadata!.defaultParams[0].value = "mutated";
		metadata!.thinkingLevelMap!.medium = "mutated";
		expect(getCursorModelMetadata("gpt-5.4@1m")?.defaultParams[0].value).toBe("1m");
		expect(getCursorModelMetadata("gpt-5.4@1m")?.thinkingLevelMap?.medium).toBe("medium");
	});
});
