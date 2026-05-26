import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCursorFastControls, getEffectiveFastForModelId, __testUtils } from "../src/cursor-state.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeHarnessModel,
	makeModel,
} from "./helpers/pi-harness.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

function createFastHarness(options: {
	modelId?: string;
	provider?: string;
	branch?: SessionEntry[];
	cursorFastFlag?: boolean;
	cursorNoFastFlag?: boolean;
} = {}) {
	const pi = createPiHarness({
		flagValues: {
			"cursor-fast": options.cursorFastFlag ?? false,
			"cursor-no-fast": options.cursorNoFastFlag ?? false,
		},
	});
	const ctx = createExtensionTestContext({
		model: options.modelId
			? {
					...makeModel(options.modelId),
					provider: options.provider ?? "cursor",
					api: "cursor-sdk",
				}
			: undefined,
		sessionManager: {
			getBranch: vi.fn<ExtensionContext["sessionManager"]["getBranch"]>(() => options.branch ?? []),
		},
	});
	registerCursorFastControls(pi);
	const commandCtx = createExtensionCommandContext({
		model: ctx.model,
		ui: ctx.ui,
		sessionManager: ctx.sessionManager,
	});
	return { pi, ctx, commandCtx, commands: pi._commands };
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
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");

		await commands.get("cursor-fast")!.handler("", commandCtx);

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
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("rolls fast state back when the session journal append fails", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2" });
		pi.appendEntry.mockImplementationOnce(() => {
			throw new Error("journal unavailable");
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Cursor fast preference"), "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "composer-2": true },
		});
	});

	it("restores fast state from the active session branch", async () => {
		const { pi, ctx } = createFastHarness({
			modelId: "composer-2",
			branch: [
				{
					type: "custom",
					id: "fast-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: __testUtils.FAST_ENTRY_TYPE,
					data: { baseModelId: "composer-2", fast: false },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
	});

	it("uses global fast defaults for new sessions", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true } }));
		const { pi, ctx } = createFastHarness({ modelId: "gpt-5.5@1m" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
	});

	it("forces fast with the CLI flag without writing session state", async () => {
		const { pi, ctx } = createFastHarness({ modelId: "gpt-5.5@1m", cursorFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("forces fast off with --cursor-no-fast without writing session state", async () => {
		const { pi, ctx } = createFastHarness({ modelId: "composer-2", cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("lets --cursor-no-fast win when both one-run force flags are set", async () => {
		const { pi, ctx } = createFastHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not apply --cursor-no-fast to unsupported Cursor models", async () => {
		const { pi, ctx } = createFastHarness({ modelId: "gemini-3.1-pro", cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not let /cursor-fast persist while --cursor-no-fast is active", async () => {
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "composer-2", cursorNoFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("mentions --cursor-no-fast when both force flags block /cursor-fast", async () => {
		const { ctx, commandCtx, commands, pi } = createFastHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
	});

	it("does not let /cursor-fast persist an opposite value when --cursor-fast is active", async () => {
		const { pi, ctx, commandCtx, commands } = createFastHarness({ modelId: "gpt-5.5@1m", cursorFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced by --cursor-fast", "info");
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("notifies and no-ops when the selected model does not support fast", async () => {
		const { ctx, commandCtx, commands, pi } = createFastHarness({ modelId: "gemini-3.1-pro" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Fast mode not supported by gemini-3.1-pro", "info");
	});

	it("toggles fast by base model id so context sibling variants share the preference", async () => {
		const { ctx, commandCtx, commands, pi } = createFastHarness({ modelId: "gpt-5.5@1m" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(true);
		expect(getEffectiveFastForModelId("gpt-5.5@272k")).toBe(true);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "gpt-5.5": true },
		});
	});

	it("clears Cursor status when model_select moves from Cursor fast model to non-cursor model", async () => {
		const { pi, ctx } = createFastHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");

		await pi.invokeEventWithContext(
			"model_select",
			{
				type: "model_select",
				model: makeHarnessModel("anthropic", "anthropic-messages", "claude-sonnet-4-5"),
				previousModel: ctx.model!,
				source: "set",
			},
			ctx,
		);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("ignores malformed global config without throwing", async () => {
		writeFileSync(__testUtils.getConfigPath(), "{not json");
		const { pi, ctx } = createFastHarness({ modelId: "gpt-5.5@1m" });

		await expect(
			pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx),
		).resolves.toBeUndefined();

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("gpt-5.5@1m")).toBe(false);
	});

	it("does not apply or persist --cursor-fast for unsupported Cursor models", async () => {
		const { pi, ctx } = createFastHarness({ modelId: "gemini-3.1-pro", cursorFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("clears Cursor status for non-cursor models", async () => {
		const { pi, ctx } = createFastHarness({ provider: "anthropic", modelId: "claude-sonnet-4-5" });

		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("refreshes Cursor fast status on turn_start after session_start without a model", async () => {
		const { pi, ctx } = createFastHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);

		ctx.model = makeModel("composer-2");
		await pi.invokeEventWithContext("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
	});

	it("recognizes cursor-sdk api models when updating footer status", async () => {
		const { pi, ctx } = createFastHarness({
			modelId: "composer-2",
			provider: "other-provider",
		});
		ctx.model = { ...makeModel("composer-2"), provider: "other-provider", api: "cursor-sdk" };

		await pi.invokeEventWithContext("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor fast");
	});
});
