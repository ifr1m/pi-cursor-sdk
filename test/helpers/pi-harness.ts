import { vi, type MockedFunction } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	ModelRegistry,
	type BeforeAgentStartEvent,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionHandler,
	type ProviderConfig,
	type SessionStartEvent,
	type ToolDefinition,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { CursorNativeToolDisplayExtensionApi } from "../../src/cursor-native-tool-display-registration.js";

export type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;

export type ExtensionContextOverrides = Omit<Partial<ExtensionContext>, "sessionManager" | "ui"> & {
	sessionManager?: Partial<ExtensionContext["sessionManager"]>;
	ui?: Partial<ExtensionContext["ui"]>;
};

export type HarnessOn = <E extends HarnessEventName>(
	event: E,
	handler: ExtensionHandler<HarnessEventMap[E]>,
) => void;

export type HarnessEventName =
	| "session_start"
	| "model_select"
	| "before_agent_start"
	| "turn_start"
	| "session_shutdown"
	| "session_tree"
	| "session_before_tree";

type HarnessEventHandler<E extends HarnessEventName> = Extract<
	ExtensionAPI["on"],
	(event: E, handler: ExtensionHandler<unknown, unknown>) => void
>;

export type HarnessEventMap = {
	[E in HarnessEventName]: HarnessEventHandler<E> extends (
		event: E,
		handler: ExtensionHandler<infer EventPayload, unknown>,
	) => void
		? EventPayload
		: never;
};

/** @deprecated Use ExtensionContextOverrides */
export type TestExtensionContext = ExtensionContextOverrides;

type MockFn<T extends (...args: never[]) => unknown> = MockedFunction<T>;

export interface PiHarnessOptions {
	/** Tool catalog available before extension registration. */
	initialTools?: ToolInfo[];
	/** Active tool names returned by getActiveTools. */
	activeTools?: string[];
	/** Default value returned by getFlag when a name is not in flagValues. */
	defaultFlagValue?: boolean;
	/** Per-flag values returned by getFlag. */
	flagValues?: Record<string, boolean>;
}

export interface EventHarness {
	on: MockFn<HarnessOn>;
	invokeEvent: <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	invokeEventWithContext: <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctx: ExtensionContext,
	) => Promise<void>;
	runSessionStart: (
		ctxOverrides?: ExtensionContextOverrides,
		eventOverrides?: Partial<SessionStartEvent>,
	) => Promise<void>;
	runModelSelect: (model: ExtensionContext["model"], ctxOverrides?: ExtensionContextOverrides) => Promise<void>;
	runBeforeAgentStart: (ctxOverrides?: ExtensionContextOverrides) => Promise<void>;
	runTurnStart: (ctxOverrides?: ExtensionContextOverrides) => Promise<void>;
	runSessionShutdown: (
		eventOverrides?: Partial<HarnessEventMap["session_shutdown"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionTree: (
		eventOverrides?: Partial<HarnessEventMap["session_tree"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionBeforeTree: (
		eventOverrides?: Partial<HarnessEventMap["session_before_tree"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
}

export interface PiHarness extends EventHarness {
	registerProvider: MockFn<ExtensionAPI["registerProvider"]>;
	registerFlag: MockFn<ExtensionAPI["registerFlag"]>;
	registerCommand: MockFn<ExtensionAPI["registerCommand"]>;
	registerTool: ReturnType<typeof vi.fn<ExtensionAPI["registerTool"]>>;
	getAllTools: MockFn<ExtensionAPI["getAllTools"]>;
	getActiveTools: MockFn<ExtensionAPI["getActiveTools"]>;
	setActiveTools: MockFn<ExtensionAPI["setActiveTools"]>;
	sendMessage: MockFn<ExtensionAPI["sendMessage"]>;
	getFlag: MockFn<ExtensionAPI["getFlag"]>;
	appendEntry: MockFn<ExtensionAPI["appendEntry"]>;
	_registered: Array<{ name: string; config: ProviderConfig }>;
	_commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>;
	_tools: RegisteredTool[];
	_activeToolNames: () => string[];
}

export interface BridgePiHarness {
	getActiveTools: MockFn<ExtensionAPI["getActiveTools"]>;
	getAllTools: MockFn<ExtensionAPI["getAllTools"]>;
	setActiveTools: MockFn<ExtensionAPI["setActiveTools"]>;
	on: MockFn<HarnessOn>;
}

const DEFAULT_BUILTIN_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "edit", "write"] as const;
const DEFAULT_ACTIVE_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

let sharedTestModelRegistry: ModelRegistry | undefined;

function getSharedTestModelRegistry(): ModelRegistry {
	sharedTestModelRegistry ??= ModelRegistry.inMemory(AuthStorage.inMemory());
	return sharedTestModelRegistry;
}

function createDefaultSystemPromptOptions(cwd: string): BuildSystemPromptOptions {
	return {
		cwd,
		selectedTools: ["read", "bash", "edit", "write"],
	};
}

function createMinimalSessionManager(overrides: Partial<ExtensionContext["sessionManager"]> = {}): ExtensionContext["sessionManager"] {
	return {
		getCwd: vi.fn(() => process.cwd()),
		getSessionDir: vi.fn(() => ""),
		getSessionId: vi.fn(() => "test-session"),
		getSessionFile: vi.fn(() => undefined),
		getLeafId: vi.fn(() => null),
		getLeafEntry: vi.fn(() => undefined),
		getEntry: vi.fn(() => undefined),
		getLabel: vi.fn(() => undefined),
		getBranch: vi.fn(() => []),
		getHeader: vi.fn(() => null),
		getEntries: vi.fn(() => []),
		getTree: vi.fn(() => []),
		getSessionName: vi.fn(() => undefined),
		...overrides,
	};
}

function createMinimalExtensionUi(): ExtensionContext["ui"] {
	return {
		select: vi.fn(async () => undefined),
		confirm: vi.fn(async () => false),
		input: vi.fn(async () => undefined),
		notify: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		setHeader: vi.fn(),
		setTitle: vi.fn(),
		custom: vi.fn(async () => undefined as never),
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn(() => ""),
		editor: vi.fn(async () => undefined),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(() => undefined),
		theme: {} as ExtensionContext["ui"]["theme"],
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(() => undefined),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} satisfies ExtensionContext["ui"];
}

function createMinimalExtensionContextInternal(overrides: ExtensionContextOverrides = {}): ExtensionContext {
	const cwd = overrides.cwd ?? process.cwd();
	const base: ExtensionContext = {
		ui: createMinimalExtensionUi(),
		hasUI: true,
		cwd,
		sessionManager: createMinimalSessionManager(),
		modelRegistry: getSharedTestModelRegistry(),
		model: makeModel("composer-2.5"),
		isIdle: vi.fn(() => true),
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: vi.fn(() => false),
		shutdown: vi.fn(),
		getContextUsage: vi.fn(() => undefined),
		compact: vi.fn(),
		getSystemPrompt: vi.fn(() => ""),
	};
	return {
		...base,
		...overrides,
		ui: {
			...base.ui,
			...overrides.ui,
		},
		sessionManager: {
			...base.sessionManager,
			...overrides.sessionManager,
		},
	};
}

function createHarnessEventApi() {
	const handlers = new Map<HarnessEventName, ExtensionHandler<HarnessEventMap[HarnessEventName]>[]>();

	const on = vi.fn<HarnessOn>((event, handler) => {
		const existing = handlers.get(event) ?? [];
		handlers.set(event, [...existing, handler as ExtensionHandler<HarnessEventMap[HarnessEventName]>]);
	});

	const invokeEventWithContext = async <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctx: ExtensionContext,
	): Promise<void> => {
		for (const handler of handlers.get(event) ?? []) {
			await (handler as ExtensionHandler<HarnessEventMap[E]>)(payload, ctx);
		}
	};

	const invokeEvent = async <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEventWithContext(event, payload, createExtensionTestContext(ctxOverrides));
	};

	const runSessionStart = async (
		ctxOverrides: ExtensionContextOverrides = {},
		eventOverrides: Partial<SessionStartEvent> = {},
	): Promise<void> => {
		await invokeEvent(
			"session_start",
			{ type: "session_start", reason: "startup", ...eventOverrides },
			ctxOverrides,
		);
	};

	const runModelSelect = async (
		model: ExtensionContext["model"],
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"model_select",
			{ type: "model_select", model, previousModel: undefined, source: "set" },
			{ ...ctxOverrides, model },
		);
	};

	const runBeforeAgentStart = async (ctxOverrides: ExtensionContextOverrides = {}): Promise<void> => {
		const ctx = createExtensionTestContext(ctxOverrides);
		await invokeEventWithContext(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "start",
				systemPrompt: "",
				systemPromptOptions: createDefaultSystemPromptOptions(ctx.cwd),
			} satisfies BeforeAgentStartEvent,
			ctx,
		);
	};

	const runTurnStart = async (ctxOverrides: ExtensionContextOverrides = {}): Promise<void> => {
		await invokeEvent("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctxOverrides);
	};

	const runSessionShutdown = async (
		eventOverrides: Partial<HarnessEventMap["session_shutdown"]> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit", ...eventOverrides },
			ctxOverrides,
		);
	};

	const runSessionTree = async (
		eventOverrides: Partial<HarnessEventMap["session_tree"]> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_tree",
			{ type: "session_tree", newLeafId: null, oldLeafId: null, ...eventOverrides },
			ctxOverrides,
		);
	};

	const runSessionBeforeTree = async (
		eventOverrides: Partial<HarnessEventMap["session_before_tree"]> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_before_tree",
			{
				type: "session_before_tree",
				preparation: {
					targetId: "entry-1",
					oldLeafId: null,
					commonAncestorId: null,
					entriesToSummarize: [],
					userWantsSummary: false,
				},
				signal: AbortSignal.timeout(60_000),
				...eventOverrides,
			},
			ctxOverrides,
		);
	};

	return {
		on,
		invokeEvent,
		invokeEventWithContext,
		runSessionStart,
		runModelSelect,
		runBeforeAgentStart,
		runTurnStart,
		runSessionShutdown,
		runSessionTree,
		runSessionBeforeTree,
	};
}

export function createBuiltinToolInfo(
	name: string,
	parameters: TSchema = Type.Object({}),
	description = "",
): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	};
}

/** Generic test-scoped tool metadata (extension-registered tools, bridge MCP tools, etc.). */
export function createTestToolInfo(
	name: string,
	parameters: TSchema = Type.Object({}),
	description = `${name} tool`,
): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: { source: "test", path: `test:${name}`, scope: "temporary", origin: "top-level" },
	};
}

export function createExtensionTestContext(ctxOverrides: ExtensionContextOverrides = {}): ExtensionContext {
	return createMinimalExtensionContextInternal(ctxOverrides);
}

export function makeModel(id = "test-model"): Model<"cursor-sdk"> {
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

export function makeContext(messages: Context["messages"] = [{ role: "user", content: "Hello", timestamp: 1 }]): Context {
	return {
		systemPrompt: "Be helpful.",
		messages,
	};
}

export function makeAssistantMessage(text = "Done", timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

export async function collectEvents<TEvent>(stream: AsyncIterable<TEvent>): Promise<TEvent[]> {
	const events: TEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

export async function collectAssistantEvents(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	return collectEvents(stream);
}

/** Event-hook-only fake pi surface (session cwd, scoped listeners, etc.). */
export function createEventHarness(): EventHarness {
	return createHarnessEventApi();
}

export function createBridgePiHarness(options: { active: string[]; tools: ToolInfo[] }): BridgePiHarness {
	return {
		getActiveTools: vi.fn<ExtensionAPI["getActiveTools"]>(() => [...options.active]),
		getAllTools: vi.fn<ExtensionAPI["getAllTools"]>(() => [...options.tools]),
		setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>(),
		on: vi.fn<HarnessOn>(),
	};
}

/** Canonical configurable fake pi surface for extension, provider, and session tests. */
export function createPiHarness(options: PiHarnessOptions = {}): PiHarness {
	const eventApi = createHarnessEventApi();
	const registered: Array<{ name: string; config: ProviderConfig }> = [];
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }
	>();
	const tools: RegisteredTool[] = [];
	const initialTools =
		options.initialTools ?? [...DEFAULT_BUILTIN_TOOL_NAMES].map((name) => createBuiltinToolInfo(name));
	let activeToolNames = [...(options.activeTools ?? DEFAULT_ACTIVE_TOOL_NAMES)];

	const resolveFlagValue = (name: string): boolean => {
		if (Object.prototype.hasOwnProperty.call(options.flagValues ?? {}, name)) {
			return options.flagValues?.[name] ?? false;
		}
		return options.defaultFlagValue ?? false;
	};

	return {
		...eventApi,
		registerProvider: vi.fn<ExtensionAPI["registerProvider"]>((name: string, config: ProviderConfig) => {
			registered.push({ name, config });
		}),
		registerFlag: vi.fn<ExtensionAPI["registerFlag"]>(),
		registerCommand: vi.fn<ExtensionAPI["registerCommand"]>((name: string, command) => {
			commands.set(name, {
				description: command.description,
				handler: command.handler as (args: string, ctx: ExtensionContext) => Promise<void> | void,
			});
		}),
		registerTool: vi.fn<ExtensionAPI["registerTool"]>((tool) => {
			tools.push(tool as RegisteredTool);
		}),
		getAllTools: vi.fn<ExtensionAPI["getAllTools"]>(() => {
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
		getActiveTools: vi.fn<ExtensionAPI["getActiveTools"]>(() => [...activeToolNames]),
		setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>((toolNames: string[]) => {
			activeToolNames = [...toolNames];
		}),
		sendMessage: vi.fn<ExtensionAPI["sendMessage"]>(),
		getFlag: vi.fn<ExtensionAPI["getFlag"]>((name: string) => resolveFlagValue(name)),
		appendEntry: vi.fn<ExtensionAPI["appendEntry"]>(),
		_registered: registered,
		_commands: commands,
		_tools: tools,
		_activeToolNames: () => [...activeToolNames],
	};
}

export type { CursorNativeToolDisplayExtensionApi };
