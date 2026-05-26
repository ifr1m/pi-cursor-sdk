import { vi, type MockedFunction } from "vitest";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	ModelRegistry,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionHandler,
	type ProviderConfig,
	type ProviderModelConfig,
	type RegisteredCommand,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolInfo,
	type ToolResultEvent,
	type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import type { CursorNativeToolDisplayExtensionApi } from "../../src/cursor-native-tool-display-registration.js";
import type cursorExtensionFactory from "../../src/index.js";

export type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;

export type ExtensionContextOverrides = Omit<Partial<ExtensionContext>, "sessionManager" | "ui"> & {
	sessionManager?: Partial<ExtensionContext["sessionManager"]>;
	ui?: Partial<ExtensionContext["ui"]>;
};

export type ExtensionCommandContextOverrides = Omit<
	Partial<ExtensionCommandContext>,
	"sessionManager" | "ui"
> & {
	sessionManager?: Partial<ExtensionCommandContext["sessionManager"]>;
	ui?: Partial<ExtensionCommandContext["ui"]>;
};

export type RegisteredCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export type HarnessOn = ExtensionAPI["on"];

export type HarnessEventName =
	| "session_start"
	| "model_select"
	| "before_agent_start"
	| "turn_start"
	| "session_shutdown"
	| "session_compact"
	| "session_tree"
	| "session_before_tree"
	| "tool_call"
	| "tool_result";

/** Matches installed pi `ModelSelectEvent` (not re-exported from package root). */
export type HarnessModelSelectEvent = {
	type: "model_select";
	model: NonNullable<ExtensionContext["model"]>;
	previousModel: ExtensionContext["model"];
	source: "set" | "cycle" | "restore";
};

export type HarnessEventMap = {
	session_start: SessionStartEvent;
	model_select: HarnessModelSelectEvent;
	before_agent_start: BeforeAgentStartEvent;
	turn_start: TurnStartEvent;
	session_shutdown: SessionShutdownEvent;
	session_compact: SessionCompactEvent;
	session_tree: SessionTreeEvent;
	session_before_tree: SessionBeforeTreeEvent;
	tool_call: ToolCallEvent;
	tool_result: ToolResultEvent;
};

/** Combined invoke result for before_agent_start (matches installed pi ExtensionRunner). */
export type HarnessBeforeAgentStartCombinedResult = {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
};

/** Combined invoke result for tool_result (matches installed pi ExtensionRunner.emitToolResult). */
export type HarnessToolResultCombinedResult = {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
};

/** Combined invoke result for session_before_tree (matches installed pi ExtensionRunner.emit). */
export type HarnessSessionBeforeTreeCombinedResult = {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
	};
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
};

/** Invoke result types for harness events that return values to the caller (combined shapes where pi aggregates). */
export type HarnessEventResultMap = {
	tool_call: ToolCallEventResult;
	before_agent_start: HarnessBeforeAgentStartCombinedResult;
	tool_result: HarnessToolResultCombinedResult;
	session_before_tree: HarnessSessionBeforeTreeCombinedResult;
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
	) => Promise<HarnessEventInvokeResult<E>>;
	invokeEventWithContext: <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctx: ExtensionContext,
	) => Promise<HarnessEventInvokeResult<E>>;
	runSessionStart: (
		ctxOverrides?: ExtensionContextOverrides,
		eventOverrides?: Partial<SessionStartEvent>,
	) => Promise<void>;
	runModelSelect: (
		model: NonNullable<ExtensionContext["model"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runBeforeAgentStart: (
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<HarnessEventInvokeResult<"before_agent_start">>;
	runTurnStart: (ctxOverrides?: ExtensionContextOverrides) => Promise<void>;
	runSessionShutdown: (
		eventOverrides?: Partial<HarnessEventMap["session_shutdown"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionCompact: (
		eventOverrides?: Partial<SessionCompactEvent>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionTree: (
		eventOverrides?: Partial<HarnessEventMap["session_tree"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<void>;
	runSessionBeforeTree: (
		eventOverrides?: Partial<HarnessEventMap["session_before_tree"]>,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<HarnessEventInvokeResult<"session_before_tree">>;
	runToolCall: (
		event: ToolCallEvent,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<ToolCallEventResult | undefined>;
	runToolCallWithContext: (
		event: ToolCallEvent,
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	runToolResult: (
		event: ToolResultEvent,
		ctxOverrides?: ExtensionContextOverrides,
	) => Promise<HarnessEventInvokeResult<"tool_result">>;
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
	runCommand: (
		name: string,
		args?: string,
		ctxOverrides?: ExtensionCommandContextOverrides,
	) => Promise<void>;
	_registered: Array<{ name: string; config: ProviderConfig }>;
	_commands: Map<string, RegisteredCommandOptions>;
	_tools: RegisteredTool[];
	_activeToolNames: () => string[];
}

export interface BridgePiHarness extends EventHarness {
	getActiveTools: MockFn<ExtensionAPI["getActiveTools"]>;
	getAllTools: MockFn<ExtensionAPI["getAllTools"]>;
	setActiveTools: MockFn<ExtensionAPI["setActiveTools"]>;
}

export type HarnessEventInvokeResult<E extends HarnessEventName> = E extends keyof HarnessEventResultMap
	? HarnessEventResultMap[E] | undefined
	: void;

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

function createMinimalExtensionCommandContextInternal(
	overrides: ExtensionCommandContextOverrides = {},
): ExtensionCommandContext {
	const base = createMinimalExtensionContextInternal(overrides) as ExtensionCommandContext;
	return {
		...base,
		...overrides,
		waitForIdle: overrides.waitForIdle ?? vi.fn(async () => undefined),
		newSession: overrides.newSession ?? vi.fn(async () => ({ cancelled: false })),
		fork: overrides.fork ?? vi.fn(async () => ({ cancelled: false })),
		navigateTree: overrides.navigateTree ?? vi.fn(async () => ({ cancelled: false })),
		switchSession: overrides.switchSession ?? vi.fn(async () => ({ cancelled: false })),
		reload: overrides.reload ?? vi.fn(async () => undefined),
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

type HarnessStoredHandler =
	| ExtensionHandler<ToolCallEvent, ToolCallEventResult>
	| ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>
	| ExtensionHandler<ToolResultEvent, HarnessToolResultCombinedResult>
	| ExtensionHandler<SessionBeforeTreeEvent, HarnessSessionBeforeTreeCombinedResult>
	| ExtensionHandler<HarnessEventMap[Exclude<HarnessEventName, "tool_call" | "before_agent_start" | "tool_result" | "session_before_tree">]>;

function createBeforeAgentStartContext(
	baseCtx: ExtensionContext,
	getSystemPrompt: () => string,
): ExtensionContext {
	return {
		...baseCtx,
		getSystemPrompt,
	};
}

async function invokeBeforeAgentStartHandlers(
	payload: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	handlers: readonly HarnessStoredHandler[],
): Promise<HarnessBeforeAgentStartCombinedResult | undefined> {
	let currentSystemPrompt = payload.systemPrompt;
	const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
	let systemPromptModified = false;
	for (const handler of handlers) {
		const event: BeforeAgentStartEvent = {
			...payload,
			systemPrompt: currentSystemPrompt,
		};
		const chainedCtx = createBeforeAgentStartContext(ctx, () => currentSystemPrompt);
		const result = await (handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>)(
			event,
			chainedCtx,
		);
		if (!result) continue;
		if (result.message) {
			messages.push(result.message);
		}
		if (result.systemPrompt !== undefined) {
			currentSystemPrompt = result.systemPrompt;
			systemPromptModified = true;
		}
	}
	if (messages.length === 0 && !systemPromptModified) {
		return undefined;
	}
	return {
		messages: messages.length > 0 ? messages : undefined,
		systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
	};
}

async function invokeToolResultHandlers(
	payload: ToolResultEvent,
	ctx: ExtensionContext,
	handlers: readonly HarnessStoredHandler[],
): Promise<HarnessToolResultCombinedResult | undefined> {
	const currentEvent: ToolResultEvent = { ...payload };
	let modified = false;
	for (const handler of handlers) {
		const result = await (handler as ExtensionHandler<ToolResultEvent, HarnessToolResultCombinedResult>)(
			currentEvent,
			ctx,
		);
		if (!result) continue;
		if (result.content !== undefined) {
			currentEvent.content = result.content;
			modified = true;
		}
		if (result.details !== undefined) {
			currentEvent.details = result.details;
			modified = true;
		}
		if (result.isError !== undefined) {
			currentEvent.isError = result.isError;
			modified = true;
		}
	}
	if (!modified) {
		return undefined;
	}
	return {
		content: currentEvent.content,
		details: currentEvent.details,
		isError: currentEvent.isError,
	};
}

async function invokeSessionBeforeTreeHandlers(
	payload: SessionBeforeTreeEvent,
	ctx: ExtensionContext,
	handlers: readonly HarnessStoredHandler[],
): Promise<HarnessSessionBeforeTreeCombinedResult | undefined> {
	let result: HarnessSessionBeforeTreeCombinedResult | undefined;
	for (const handler of handlers) {
		const handlerResult = await (
			handler as ExtensionHandler<SessionBeforeTreeEvent, HarnessSessionBeforeTreeCombinedResult>
		)(payload, ctx);
		if (handlerResult) {
			result = handlerResult;
			if (result.cancel) {
				return result;
			}
		}
	}
	return result;
}

function createHarnessEventApi() {
	const handlers = new Map<HarnessEventName, HarnessStoredHandler[]>();

	const on = vi.fn(((event: HarnessEventName, handler: HarnessStoredHandler) => {
		const existing = handlers.get(event) ?? [];
		handlers.set(event, [...existing, handler]);
	}) as HarnessOn);

	const invokeEventWithContext = async <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctx: ExtensionContext,
	): Promise<HarnessEventInvokeResult<E>> => {
		const eventHandlers = handlers.get(event) ?? [];
		if (event === "before_agent_start") {
			return (await invokeBeforeAgentStartHandlers(
				payload as BeforeAgentStartEvent,
				ctx,
				eventHandlers,
			)) as HarnessEventInvokeResult<E>;
		}
		if (event === "tool_result") {
			return (await invokeToolResultHandlers(
				payload as ToolResultEvent,
				ctx,
				eventHandlers,
			)) as HarnessEventInvokeResult<E>;
		}
		if (event === "session_before_tree") {
			return (await invokeSessionBeforeTreeHandlers(
				payload as SessionBeforeTreeEvent,
				ctx,
				eventHandlers,
			)) as HarnessEventInvokeResult<E>;
		}
		if (event === "tool_call") {
			const toolCallPayload = payload as ToolCallEvent;
			let toolCallResult: ToolCallEventResult | undefined;
			for (const handler of eventHandlers) {
				const result = await (handler as ExtensionHandler<ToolCallEvent, ToolCallEventResult>)(
					toolCallPayload,
					ctx,
				);
				if (result) {
					toolCallResult = result;
					if (result.block) {
						return toolCallResult as HarnessEventInvokeResult<E>;
					}
				}
			}
			return toolCallResult as HarnessEventInvokeResult<E>;
		}
		for (const handler of eventHandlers) {
			await (handler as ExtensionHandler<HarnessEventMap[E]>)(payload, ctx);
		}
		return undefined as HarnessEventInvokeResult<E>;
	};

	const invokeEvent = async <E extends HarnessEventName>(
		event: E,
		payload: HarnessEventMap[E],
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<HarnessEventInvokeResult<E>> => {
		return invokeEventWithContext(event, payload, createExtensionTestContext(ctxOverrides));
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
		model: NonNullable<ExtensionContext["model"]>,
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"model_select",
			{ type: "model_select", model, previousModel: undefined, source: "set" },
			{ ...ctxOverrides, model },
		);
	};

	const runBeforeAgentStart = async (
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<HarnessEventInvokeResult<"before_agent_start">> => {
		const ctx = createExtensionTestContext(ctxOverrides);
		return invokeEventWithContext(
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

	const runSessionCompact = async (
		eventOverrides: Partial<SessionCompactEvent> = {},
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<void> => {
		await invokeEvent(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: {
					type: "compaction",
					id: "compaction-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					summary: "summary",
					firstKeptEntryId: "entry-1",
					tokensBefore: 0,
				},
				fromExtension: false,
				...eventOverrides,
			},
			ctxOverrides,
		);
	};

	const runToolCallWithContext = async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		return invokeEventWithContext("tool_call", event, ctx);
	};

	const runToolCall = async (
		event: ToolCallEvent,
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<ToolCallEventResult | undefined> => {
		return runToolCallWithContext(event, createExtensionTestContext(ctxOverrides));
	};

	const runToolResult = async (
		event: ToolResultEvent,
		ctxOverrides: ExtensionContextOverrides = {},
	): Promise<HarnessEventInvokeResult<"tool_result">> => {
		return invokeEvent("tool_result", event, ctxOverrides);
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
	): Promise<HarnessEventInvokeResult<"session_before_tree">> => {
		return invokeEvent(
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
		on: on as MockFn<HarnessOn>,
		invokeEvent,
		invokeEventWithContext,
		runSessionStart,
		runModelSelect,
		runBeforeAgentStart,
		runTurnStart,
		runSessionShutdown,
		runSessionCompact,
		runSessionTree,
		runSessionBeforeTree,
		runToolCall,
		runToolCallWithContext,
		runToolResult,
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

export function createExtensionCommandContext(
	ctxOverrides: ExtensionCommandContextOverrides = {},
): ExtensionCommandContext {
	return createMinimalExtensionCommandContextInternal(ctxOverrides);
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

export function makeHarnessModel<TApi extends Api>(
	provider: string,
	api: TApi,
	id: string,
	overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

export function getHarnessRegisteredTool(tools: readonly RegisteredTool[], name: string): RegisteredTool {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) {
		throw new Error(`Tool not registered: ${name}`);
	}
	return tool;
}

export function makeProviderModelConfig(
	id: string,
	overrides: Partial<ProviderModelConfig> = {},
): ProviderModelConfig {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

/** Pi harness surface accepted by `src/index.ts` extension factory registration. */
export type CursorExtensionRegistrationPi = Parameters<typeof cursorExtensionFactory>[0];

export function createExtensionRegistrationPi(
	options: PiHarnessOptions = {},
): PiHarness & CursorExtensionRegistrationPi {
	return createPiHarness(options) as unknown as PiHarness & CursorExtensionRegistrationPi;
}

/** HTTP MCP URL for a bridge run's `pi_tools` server (narrows SDK union config). */
export function getCursorPiBridgeMcpUrl(run: { mcpServers?: Record<string, unknown> }): string {
	const piTools = run.mcpServers?.pi_tools;
	if (!piTools || typeof piTools !== "object" || !("url" in piTools) || typeof piTools.url !== "string") {
		throw new Error("Bridge run has no pi_tools HTTP MCP URL");
	}
	return piTools.url;
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
	const eventApi = createHarnessEventApi();
	return {
		...eventApi,
		getActiveTools: vi.fn<ExtensionAPI["getActiveTools"]>(() => [...options.active]),
		getAllTools: vi.fn<ExtensionAPI["getAllTools"]>(() => [...options.tools]),
		setActiveTools: vi.fn<ExtensionAPI["setActiveTools"]>(),
	};
}

/** Canonical configurable fake pi surface for extension, provider, and session tests. */
export function createPiHarness(options: PiHarnessOptions = {}): PiHarness {
	const eventApi = createHarnessEventApi();
	const registered: Array<{ name: string; config: ProviderConfig }> = [];
	const commands = new Map<string, RegisteredCommandOptions>();
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

	const runCommand = async (
		name: string,
		args = "",
		ctxOverrides: ExtensionCommandContextOverrides = {},
	): Promise<void> => {
		const command = commands.get(name);
		if (!command) {
			throw new Error(`Command not registered: ${name}`);
		}
		await command.handler(args, createExtensionCommandContext(ctxOverrides));
	};

	return {
		...eventApi,
		registerProvider: vi.fn<ExtensionAPI["registerProvider"]>((name: string, config: ProviderConfig) => {
			registered.push({ name, config });
		}),
		registerFlag: vi.fn<ExtensionAPI["registerFlag"]>(),
		registerCommand: vi.fn<ExtensionAPI["registerCommand"]>((name: string, command) => {
			commands.set(name, command);
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
		runCommand,
		_registered: registered,
		_commands: commands,
		_tools: tools,
		_activeToolNames: () => [...activeToolNames],
	};
}

export type { CursorNativeToolDisplayExtensionApi };
