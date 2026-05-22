import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCursorFastControls, getEffectiveFastForModelId, __testUtils } from "../src/cursor-state.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const modelItems: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Cursor Composer 2",
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [
			{
				params: [{ id: "fast", value: "true" }],
				displayName: "Cursor Composer 2",
				isDefault: true,
			},
		],
	},
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
			{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "reasoning", value: "medium" },
					{ id: "fast", value: "false" },
				],
				displayName: "GPT-5.5",
				isDefault: true,
			},
		],
	},
	{
		id: "gemini-3.1-pro",
		displayName: "Gemini 3.1 Pro",
		variants: [{ params: [], displayName: "Gemini 3.1 Pro", isDefault: true }],
	},
];

type CursorFastTestModel = Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "api">;
type CursorFastTestContext = {
	model: CursorFastTestModel | undefined;
	ui: {
		setStatus: ReturnType<typeof vi.fn>;
		notify: ReturnType<typeof vi.fn>;
	};
	sessionManager: {
		getBranch: ReturnType<typeof vi.fn<() => unknown[]>>;
	};
};
type CursorFastTestCommand = {
	description?: string;
	handler: (args: string, ctx: CursorFastTestContext) => Promise<void> | void;
};
type CursorFastTestHandler = (
	event: { model?: CursorFastTestModel },
	ctx: CursorFastTestContext,
) => Promise<void> | void;

function createHarness(options: { modelId?: string; provider?: string; branch?: unknown[]; cursorFastFlag?: boolean; cursorNoFastFlag?: boolean } = {}) {
	const commands = new Map<string, CursorFastTestCommand>();
	const handlers = new Map<string, CursorFastTestHandler>();
	const pi = {
		registerFlag: vi.fn(),
		registerCommand: vi.fn((name: string, command: CursorFastTestCommand) => commands.set(name, command)),
		on: vi.fn((event: string, handler: CursorFastTestHandler) => handlers.set(event, handler)),
		getFlag: vi.fn((name: string) => {
			if (name === "cursor-fast") return options.cursorFastFlag ?? false;
			if (name === "cursor-no-fast") return options.cursorNoFastFlag ?? false;
			return false;
		}),
		appendEntry: vi.fn(),
	};
	const ctx: CursorFastTestContext = {
		model: options.modelId
			? {
					provider: options.provider ?? "cursor",
					id: options.modelId,
					api: "cursor-sdk",
				}
			: undefined,
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
		},
		sessionManager: {
			getBranch: vi.fn(() => options.branch ?? []),
		},
	};
	registerCursorFastControls(pi);
	return { pi, ctx, commands, handlers };
}

describe("Cursor fast state", () => {
	let tmpAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-state-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		__testUtils.sessionFastPreferences.clear();
		modelDiscoveryTestUtils.registerModelItems(modelItems);
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tmpAgentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("toggles fast per session and writes the global default", async () => {
		const { pi, ctx, commands, handlers } = createHarness({ modelId: "composer-2" });
		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");

		await commands.get("cursor-fast").handler("", ctx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.FAST_ENTRY_TYPE, {
			baseModelId: "composer-2",
			fast: false,
		});
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "composer-2": false },
		});
	});

	it("does not update fast state when the global config cannot be saved", async () => {
		const blockedAgentDir = join(tmpAgentDir, "not-a-directory");
		writeFileSync(blockedAgentDir, "x");
		process.env.PI_CODING_AGENT_DIR = blockedAgentDir;
		const { pi, ctx, commands, handlers } = createHarness({ modelId: "composer-2" });
		await handlers.get("session_start")({}, ctx);

		await commands.get("cursor-fast").handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("rolls fast state back when the session journal append fails", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const { pi, ctx, commands, handlers } = createHarness({ modelId: "composer-2" });
		pi.appendEntry.mockImplementationOnce(() => {
			throw new Error("journal unavailable");
		});
		await handlers.get("session_start")({}, ctx);

		await commands.get("cursor-fast").handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "composer-2": true },
		});
	});

	it("restores fast state from the active session branch", async () => {
		const { ctx, handlers } = createHarness({
			modelId: "composer-2",
			branch: [
				{
					type: "custom",
					customType: __testUtils.FAST_ENTRY_TYPE,
					data: { baseModelId: "composer-2", fast: false },
				},
			],
		});

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
	});

	it("uses global fast defaults for new sessions", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true } }));
		const { ctx, handlers } = createHarness({ modelId: "gpt-5.5@1m" });

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
	});

	it("forces fast with the CLI flag without writing session state", async () => {
		const { pi, ctx, handlers } = createHarness({ modelId: "gpt-5.5@1m", cursorFastFlag: true });

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("forces fast off with --cursor-no-fast without writing session state", async () => {
		const { pi, ctx, handlers } = createHarness({ modelId: "composer-2", cursorNoFastFlag: true });

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("lets --cursor-no-fast win when both one-run force flags are set", async () => {
		const { pi, ctx, handlers } = createHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not apply --cursor-no-fast to unsupported Cursor models", async () => {
		const { pi, ctx, handlers } = createHarness({ modelId: "gemini-3.1-pro", cursorNoFastFlag: true });

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not let /cursor-fast persist while --cursor-no-fast is active", async () => {
		const { pi, ctx, commands, handlers } = createHarness({ modelId: "composer-2", cursorNoFastFlag: true });
		await handlers.get("session_start")({}, ctx);

		await commands.get("cursor-fast").handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("mentions --cursor-no-fast when both force flags block /cursor-fast", async () => {
		const { ctx, commands, handlers } = createHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });
		await handlers.get("session_start")({}, ctx);

		await commands.get("cursor-fast").handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
	});

	it("does not let /cursor-fast persist an opposite value when --cursor-fast is active", async () => {
		const { pi, ctx, commands, handlers } = createHarness({ modelId: "gpt-5.5@1m", cursorFastFlag: true });
		await handlers.get("session_start")({}, ctx);

		await commands.get("cursor-fast").handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced by --cursor-fast", "info");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("notifies and no-ops when the selected model does not support fast", async () => {
		const { ctx, commands, handlers } = createHarness({ modelId: "gemini-3.1-pro" });
		await handlers.get("session_start")({}, ctx);

		await commands.get("cursor-fast").handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Fast mode not supported by gemini-3.1-pro", "info");
	});

	it("toggles fast by base model id so context sibling variants share the preference", async () => {
		const { ctx, commands, handlers } = createHarness({ modelId: "gpt-5.5@1m" });
		await handlers.get("session_start")({}, ctx);

		await commands.get("cursor-fast").handler("", ctx);

		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(getEffectiveFastForModelId("gpt-5.5@272k")).toBe(true);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "gpt-5.5": true },
		});
	});

	it("clears Cursor status when model_select moves from Cursor fast model to non-cursor model", async () => {
		const { ctx, handlers } = createHarness({ modelId: "composer-2" });
		await handlers.get("session_start")({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");

		await handlers.get("model_select")({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("ignores malformed global config without throwing", async () => {
		writeFileSync(__testUtils.getConfigPath(), "{not json");
		const { ctx, handlers } = createHarness({ modelId: "gpt-5.5@1m" });

		await expect(handlers.get("session_start")({}, ctx)).resolves.toBeUndefined();

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(false);
	});

	it("does not apply or persist --cursor-fast for unsupported Cursor models", async () => {
		const { pi, ctx, handlers } = createHarness({ modelId: "gemini-3.1-pro", cursorFastFlag: true });

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("clears Cursor status for non-cursor models", async () => {
		const { ctx, handlers } = createHarness({ provider: "anthropic", modelId: "claude-sonnet-4-5" });

		await handlers.get("session_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("refreshes Cursor fast status on turn_start after session_start without a model", async () => {
		const { ctx, handlers } = createHarness();
		await handlers.get("session_start")({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);

		ctx.model = { provider: "cursor", id: "composer-2", api: "cursor-sdk" };
		await handlers.get("turn_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
	});

	it("recognizes cursor-sdk api models when updating footer status", async () => {
		const { ctx, handlers } = createHarness({
			modelId: "composer-2",
			provider: "other-provider",
		});
		ctx.model = { provider: "other-provider", id: "composer-2", api: "cursor-sdk" };

		await handlers.get("turn_start")({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
	});
});
