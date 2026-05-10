import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

vi.mock("../src/model-discovery.js", () => ({
	discoverModels: vi.fn(),
}));

vi.mock("../src/cursor-provider.js", () => ({
	streamCursor: vi.fn(),
}));

import extensionFactory from "../src/index.js";
import { discoverModels } from "../src/model-discovery.js";
import { streamCursor } from "../src/cursor-provider.js";
import {
	__testUtils as nativeToolDisplayTestUtils,
	canRenderCursorToolNatively,
	recordCursorNativeToolDisplay,
} from "../src/cursor-native-tool-display.js";

const mockedDiscover = vi.mocked(discoverModels);
const mockedStreamCursor = vi.mocked(streamCursor);

type DiscoverOptions = Parameters<typeof discoverModels>[0];
type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;
type TestExtensionContext = Pick<ExtensionContext, "hasUI"> & {
	ui: Pick<ExtensionContext["ui"], "notify" | "setStatus">;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
};
type TestEventHandler = (event: unknown, ctx: TestExtensionContext) => Promise<void> | void;

function createBuiltinToolInfo(name: string): ToolInfo {
	return {
		name,
		description: "",
		parameters: Type.Object({}),
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	};
}

async function runSessionStartHandlers(pi: ReturnType<typeof createMockPi>, ctxOverrides: Partial<TestExtensionContext> = {}): Promise<void> {
	const notify = vi.fn();
	const ctx: TestExtensionContext = {
		hasUI: true,
		ui: { notify, setStatus: vi.fn() },
		sessionManager: { getBranch: vi.fn(() => []) },
		...ctxOverrides,
	};
	for (const handler of pi._handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, ctx);
	}
}

function createMockPi(existingTools?: ToolInfo[]) {
	const registered: Array<{ name: string; config: ProviderConfig }> = [];
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, TestEventHandler[]>();
	const initialTools = existingTools ?? ["read", "bash", "ls"].map(createBuiltinToolInfo);
	return {
		registerProvider: vi.fn((name: string, config: ProviderConfig) => {
			registered.push({ name, config });
		}),
		registerFlag: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((tool: RegisteredTool) => {
			tools.push(tool);
		}),
		getAllTools: vi.fn(() => {
			const toolsByName = new Map<string, ToolInfo>();
			for (const tool of initialTools) toolsByName.set(tool.name, tool);
			for (const tool of tools) {
				toolsByName.set(tool.name, {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					sourceInfo: { source: "test", path: "pi-cursor-sdk-test", scope: "temporary", origin: "top-level" },
				});
			}
			return [...toolsByName.values()];
		}),
		sendMessage: vi.fn(),
		on: vi.fn((event: string, handler: TestEventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
		getFlag: vi.fn().mockReturnValue(false),
		appendEntry: vi.fn(),
		_registered: registered,
		_tools: tools,
		_handlers: handlers,
	};
}

describe("extension factory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
		delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
		nativeToolDisplayTestUtils.reset();
	});

	it("registers Cursor fast controls and one provider with correct fields", async () => {
		const mockModels = [
			{
				id: "composer-2",
				name: "Cursor Composer 2",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		];
		mockedDiscover.mockResolvedValueOnce(mockModels);

		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-no-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ description: expect.stringContaining("Toggle Cursor fast") }),
		);
		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		expect(pi._tools.map((tool) => tool.name)).toEqual(["read", "bash", "ls"]);
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("model_select", expect.any(Function));
		expect(mockedDiscover).toHaveBeenCalledOnce();
		expect(pi.registerProvider).toHaveBeenCalledOnce();

		const [call] = pi._registered;
		expect(call.name).toBe("cursor");
		expect(call.config.name).toBe("Cursor");
		expect(call.config.apiKey).toBe("CURSOR_API_KEY");
		expect(call.config.api).toBe("cursor-sdk");
		expect(call.config.models).toBe(mockModels);
		expect(call.config.streamSimple).toBe(mockedStreamCursor);
	});

	it("registers provider even with fallback models", async () => {
		mockedDiscover.mockResolvedValueOnce([
			{
				id: "composer-2",
				name: "Cursor Composer 2",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
			{
				id: "gpt-5.5@1m",
				name: "GPT-5.5 @ 1m",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 16384,
			},
		]);

		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);

		expect(pi.registerProvider).toHaveBeenCalledOnce();
		const [call] = pi._registered;
		expect(call.config.models).toHaveLength(2);
	});

	it("notifies interactive users when fallback models are registered", async () => {
		mockedDiscover.mockImplementationOnce(async (options: DiscoverOptions) => {
			options.onFallback({
				reason: "missing-api-key",
				message:
					"Cursor model discovery needs an API key from /login (Use an API key -> Cursor), CURSOR_API_KEY, or --api-key. Using fallback Cursor models so /login and model selection still work; fallback models can run once auth exists. After adding auth to an already-started pi session, run /reload or restart pi to refresh the full live Cursor model catalog.",
			});
			return [
				{
					id: "composer-2",
					name: "Cursor Composer 2",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			];
		});

		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);

		const notify = vi.fn();
		const ctx = {
			hasUI: true,
			ui: { notify, setStatus: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => []) },
		};
		const sessionHandlers = pi._handlers.get("session_start") ?? [];
		await sessionHandlers.at(-1)!({}, ctx);

		expect(notify).toHaveBeenCalledWith(
			"Cursor model discovery needs an API key from /login (Use an API key -> Cursor), CURSOR_API_KEY, or --api-key. Using fallback Cursor models so /login and model selection still work; fallback models can run once auth exists. After adding auth to an already-started pi session, run /reload or restart pi to refresh the full live Cursor model catalog.",
			"warning",
		);
	});

	it("does not notify fallback discovery issues without UI", async () => {
		mockedDiscover.mockImplementationOnce(async (options: DiscoverOptions) => {
			options.onFallback({ reason: "empty-model-list", message: "Cursor model discovery returned no models; using fallback Cursor model list." });
			return [];
		});

		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);

		const notify = vi.fn();
		const ctx = { hasUI: false, ui: { notify, setStatus: vi.fn() }, sessionManager: { getBranch: vi.fn(() => []) } };
		const sessionHandlers = pi._handlers.get("session_start") ?? [];
		await sessionHandlers.at(-1)!({}, ctx);

		expect(notify).not.toHaveBeenCalled();
	});

	it("registered native Cursor tool wrappers return recorded Cursor results without executing built-ins", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		recordCursorNativeToolDisplay({
			id: "cursor-tool-1",
			toolName: "read",
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "# pi-cursor-sdk" }] },
			isError: false,
		});

		const readTool = pi._tools.find((tool) => tool.name === "read");
		const result = await readTool.execute("cursor-tool-1", { path: "README.md" }, undefined, undefined, {});

		expect(result).toEqual({
			content: [{ type: "text", text: "# pi-cursor-sdk" }],
			details: undefined,
			terminate: true,
		});
	});

	it("does not register native Cursor tool wrappers when native display is disabled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(canRenderCursorToolNatively("read")).toBe(false);
	});

	it("does not register native Cursor tool wrappers when native tool registration is disabled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi();
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(canRenderCursorToolNatively("read")).toBe(false);
	});

	it("skips only native Cursor tool wrappers owned by another extension", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createMockPi([
			{
				name: "read",
				description: "hashline read",
				parameters: Type.Object({}),
				sourceInfo: {
					source: "package",
					path: "/opt/homebrew/lib/node_modules/pi-hashline-edit/index.ts",
					scope: "user",
					origin: "package",
				},
			},
			createBuiltinToolInfo("bash"),
			createBuiltinToolInfo("ls"),
		]);
		await extensionFactory(pi as unknown as ExtensionAPI);
		await runSessionStartHandlers(pi);

		expect(pi._tools.map((tool) => tool.name)).toEqual(["bash", "ls"]);
		expect(canRenderCursorToolNatively("read")).toBe(false);
		expect(canRenderCursorToolNatively("bash")).toBe(true);
		expect(canRenderCursorToolNatively("ls")).toBe(true);
	});
});
