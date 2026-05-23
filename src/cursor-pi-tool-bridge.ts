import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServerConfig } from "@cursor/sdk";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionHandler,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolInfo,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
	CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV,
	CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	type CursorPiToolBridgeDiagnosticEvent,
	type CursorPiToolBridgeLifecycleDiagnosticFields,
	type CursorPiToolBridgeRejectionKind,
	type CursorPiToolBridgeRequestDiagnosticFields,
	serializeCursorPiToolBridgeDiagnostic,
	writeCursorPiToolBridgeDiagnostic,
} from "./cursor-pi-tool-bridge-diagnostics.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import type {
	CursorPiBridgeToolDefinition,
	CursorPiBridgeToolRequest,
	CursorPiMcpInputSchema,
	CursorPiToolBridge,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshot,
	CursorPiToolBridgeSnapshotOptions,
} from "./cursor-pi-tool-bridge-types.js";
import {
	asToolResultMessage,
	containsKnownMcpToolName,
	convertPiContentToMcpContent,
	createMcpToolName,
	getStringField,
	isRecord,
	normalizeMcpArgs,
	normalizeMcpInputSchema,
	snapshotToolToMcpTool,
	stableNameHash,
	waitForProtocolFlush,
} from "./cursor-pi-tool-bridge-mcp.js";
import { isExcludedFromCursorBridgeExposure } from "./cursor-tool-names.js";

export type {
	CursorPiBridgeToolDefinition,
	CursorPiBridgeToolRequest,
	CursorPiMcpInputSchema,
	CursorPiToolBridge,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshot,
	CursorPiToolBridgeSnapshotOptions,
} from "./cursor-pi-tool-bridge-types.js";
export type { CursorPiToolBridgeDiagnosticEvent } from "./cursor-pi-tool-bridge-diagnostics.js";
export { resolveCursorPiToolBridgeDebugEnabled } from "./cursor-pi-tool-bridge-diagnostics.js";

const CURSOR_PI_TOOL_BRIDGE_ENV = "PI_CURSOR_PI_TOOL_BRIDGE";
const CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";
const LOOPBACK_HOST = "127.0.0.1";
const MCP_SERVER_NAME = "pi_tools";
const MCP_ENDPOINT_ROOT = "/cursor-pi-tool-bridge";
const MCP_SERVER_VERSION = "0.1.0";
const HTTP_SERVER_CLOSE_GRACE_MS = 250;
const OVERLAPPING_CURSOR_NATIVE_PI_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);

type CursorPiToolBridgeSnapshotApi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;

interface CursorPiToolBridgeExtensionApi extends CursorPiToolBridgeSnapshotApi {
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
}

interface PendingBridgeCall {
	request: CursorPiBridgeToolRequest;
	resolve: (result: CallToolResult) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	settled: boolean;
}

interface CursorPiToolBridgeActiveToolExecution {
	toolCallId: string;
	abort: () => Promise<void> | void;
	cancelPending: (reason: string) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

class CursorPiToolBridgeToolExecutionAbortTracker {
	private readonly activeExecutions = new Map<string, CursorPiToolBridgeActiveToolExecution>();
	private processSignalHandlersInstalled = false;

	track(
		toolCallId: string,
		options: {
			signal?: AbortSignal;
			abort: () => Promise<void> | void;
			cancelPending: (reason: string) => void;
		},
	): boolean {
		this.finish(toolCallId);
		const execution: CursorPiToolBridgeActiveToolExecution = {
			toolCallId,
			abort: options.abort,
			cancelPending: options.cancelPending,
			signal: options.signal,
		};
		if (options.signal?.aborted) {
			this.cancelExecution(execution, "Cursor pi bridge tool execution was already aborted");
			this.abortExecution(execution);
			return false;
		}

		execution.onAbort = () => {
			this.cancelExecution(execution, "Cursor pi bridge tool execution was aborted");
			this.finish(toolCallId);
		};
		execution.signal?.addEventListener("abort", execution.onAbort, { once: true });
		this.activeExecutions.set(toolCallId, execution);
		this.installProcessSignalHandlers();
		return true;
	}

	finish(toolCallId: string): void {
		const execution = this.activeExecutions.get(toolCallId);
		if (!execution) return;
		if (execution.onAbort) execution.signal?.removeEventListener("abort", execution.onAbort);
		this.activeExecutions.delete(toolCallId);
		this.uninstallProcessSignalHandlersIfIdle();
	}

	finishAll(): void {
		for (const toolCallId of [...this.activeExecutions.keys()]) this.finish(toolCallId);
	}

	abortAll(reason: string): void {
		for (const execution of [...this.activeExecutions.values()]) {
			this.cancelExecution(execution, reason);
			this.abortExecution(execution);
			this.finish(execution.toolCallId);
		}
	}

	getActiveCount(): number {
		return this.activeExecutions.size;
	}

	emitProcessAbortSignalForTests(signal: NodeJS.Signals): void {
		this.abortActiveExecutions(signal, { preserveProcessSignalBehavior: true });
	}

	private readonly handleSigint = (): void => {
		this.abortActiveExecutions("SIGINT");
	};

	private readonly handleSigterm = (): void => {
		this.abortActiveExecutions("SIGTERM");
	};

	private installProcessSignalHandlers(): void {
		if (this.processSignalHandlersInstalled) return;
		this.processSignalHandlersInstalled = true;
		process.on("SIGINT", this.handleSigint);
		process.on("SIGTERM", this.handleSigterm);
	}

	private uninstallProcessSignalHandlersIfIdle(): void {
		if (!this.processSignalHandlersInstalled || this.activeExecutions.size > 0) return;
		this.processSignalHandlersInstalled = false;
		process.off("SIGINT", this.handleSigint);
		process.off("SIGTERM", this.handleSigterm);
	}

	private abortActiveExecutions(
		signal: NodeJS.Signals,
		options: { preserveProcessSignalBehavior?: boolean } = {},
	): void {
		if (this.activeExecutions.size === 0) return;
		const shouldRestoreDefaultSignalBehavior =
			options.preserveProcessSignalBehavior !== true && !this.hasExternalProcessSignalListeners(signal);
		this.abortAll(`Cursor pi bridge tool execution interrupted by ${signal}`);
		if (shouldRestoreDefaultSignalBehavior) this.restoreDefaultProcessSignalBehavior(signal);
	}

	private cancelExecution(execution: CursorPiToolBridgeActiveToolExecution, reason: string): void {
		try {
			execution.cancelPending(reason);
		} catch {
			// Cancellation is best-effort during process abort/shutdown cleanup; keep aborting siblings.
		}
	}

	private abortExecution(execution: CursorPiToolBridgeActiveToolExecution): void {
		try {
			Promise.resolve(execution.abort()).catch(() => undefined);
		} catch {
			// Abort is best-effort during process abort/shutdown cleanup; keep aborting siblings.
		}
	}

	private hasExternalProcessSignalListeners(signal: NodeJS.Signals): boolean {
		const ownHandler = signal === "SIGINT" ? this.handleSigint : this.handleSigterm;
		return process.listeners(signal).some((listener) => listener !== ownHandler);
	}

	private restoreDefaultProcessSignalBehavior(signal: NodeJS.Signals): void {
		setImmediate(() => {
			process.kill(process.pid, signal);
		});
	}
}

const bridgeToolExecutionAbortTracker = new CursorPiToolBridgeToolExecutionAbortTracker();

function createEmptySnapshot(): CursorPiToolBridgeSnapshot {
	return {
		tools: [],
		mcpToolNameToPiToolName: new Map(),
		piToolNameToMcpToolName: new Map(),
	};
}

export function resolveCursorPiToolBridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_ENV], true);
}

export function resolveCursorPiToolBridgeBuiltinsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV], false);
}

function isOverlappingCursorNativePiToolName(toolName: string): boolean {
	return OVERLAPPING_CURSOR_NATIVE_PI_BUILTIN_TOOL_NAMES.has(toolName);
}

export function buildCursorPiToolBridgeSurfaceSignature(snapshot: CursorPiToolBridgeSnapshot): string {
	if (snapshot.tools.length === 0) return "bridge:empty";
	const serializedTools = snapshot.tools
		.map((tool) =>
			JSON.stringify({
				piToolName: tool.piToolName,
				mcpToolName: tool.mcpToolName,
				description: tool.description,
				inputSchema: tool.inputSchema,
				source: tool.sourceInfo?.source,
				path: tool.sourceInfo?.path,
				scope: tool.sourceInfo?.scope,
			}),
		)
		.sort()
		.join("\0");
	return `bridge:on:${stableNameHash(serializedTools)}`;
}

export function buildCursorPiToolBridgeSnapshot(
	pi: CursorPiToolBridgeSnapshotApi,
	options: CursorPiToolBridgeSnapshotOptions = {},
): CursorPiToolBridgeSnapshot {
	const activeToolNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();
	const usedMcpToolNames = new Set<string>();
	const mcpToolNameToPiToolName = new Map<string, string>();
	const piToolNameToMcpToolName = new Map<string, string>();
	const tools: CursorPiBridgeToolDefinition[] = [];

	const exposeOverlappingBuiltins = options.exposeOverlappingBuiltins === true;

	for (const tool of allTools) {
		if (!activeToolNames.has(tool.name)) continue;
		if (isExcludedFromCursorBridgeExposure(tool.name)) continue;
		if (!exposeOverlappingBuiltins && isOverlappingCursorNativePiToolName(tool.name)) continue;

		const mcpToolName = createMcpToolName(tool.name, usedMcpToolNames);
		const description = tool.description || `Run pi tool ${tool.name}`;
		mcpToolNameToPiToolName.set(mcpToolName, tool.name);
		piToolNameToMcpToolName.set(tool.name, mcpToolName);
		tools.push({
			piToolName: tool.name,
			mcpToolName,
			description,
			inputSchema: normalizeMcpInputSchema(tool.parameters),
			sourceInfo: tool.sourceInfo,
		});
	}

	return { tools, mcpToolNameToPiToolName, piToolNameToMcpToolName };
}

class CursorPiToolBridgeRunImpl implements CursorPiToolBridgeRun {
	readonly id: string;
	readonly enabled: boolean;
	readonly snapshot: CursorPiToolBridgeSnapshot;
	mcpServers?: Record<string, McpServerConfig>;

	private readonly registry: CursorPiToolBridgeRegistry;
	private readonly env: Record<string, string | undefined>;
	private readonly endpointPath: string;
	private readonly knownMcpToolNames: ReadonlySet<string>;
	private readonly knownCursorMcpCallIds = new Set<string>();
	private readonly queuedRequests: CursorPiBridgeToolRequest[] = [];
	private readonly pendingByPiToolCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByBridgeCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByCursorMcpCallId = new Map<string, PendingBridgeCall>();
	private onToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	private liveRunHandlerDetached = false;
	private mcpServer?: McpProtocolServer;
	private mcpTransport?: StreamableHTTPServerTransport;
	private toolCallCounter = 0;
	private disposed = false;

	constructor(
		registry: CursorPiToolBridgeRegistry,
		env: Record<string, string | undefined>,
		snapshot: CursorPiToolBridgeSnapshot,
		enabled: boolean,
		options: CursorPiToolBridgeRunOptions = {},
	) {
		this.registry = registry;
		this.env = env;
		this.snapshot = snapshot;
		this.enabled = enabled;
		this.onToolRequest = options.onToolRequest;
		this.id = `cursor-pi-bridge-run-${randomUUID()}`;
		this.endpointPath = `${MCP_ENDPOINT_ROOT}/${randomUUID()}/mcp`;
		this.knownMcpToolNames = new Set(snapshot.tools.map((tool) => tool.mcpToolName));
	}

	async start(): Promise<void> {
		if (!this.enabled) return;
		await this.createMcpServer();
		const endpointUrl = await this.registry.registerRun(this.endpointPath, this);
		this.mcpServers = { [MCP_SERVER_NAME]: { type: "http", url: endpointUrl } };
	}

	emitStartDiagnostics(bridgeEnabled: boolean): void {
		const base = this.lifecycleDiagnosticFields();
		this.emitDiagnostic({ event: "run_created", ...base });
		if (!this.enabled) {
			this.emitDiagnostic({
				event: "run_skipped",
				...base,
				reason: bridgeEnabled ? "no_exposed_tools" : "disabled",
			});
			return;
		}
		this.emitDiagnostic({
			event: "tools_exposed",
			...base,
			pairs: this.snapshot.tools.map((tool) => ({
				piToolName: tool.piToolName,
				mcpToolName: tool.mcpToolName,
			})),
		});
	}

	async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (this.disposed || !this.mcpTransport) {
			res.writeHead(410, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cursor pi tool bridge run is disposed" }));
			return;
		}
		await this.mcpTransport.handleRequest(req, res);
	}

	takeQueuedToolRequests(): CursorPiBridgeToolRequest[] {
		return this.queuedRequests.splice(0);
	}

	setOnToolRequest(handler?: (request: CursorPiBridgeToolRequest) => void): void {
		if (!handler) {
			this.liveRunHandlerDetached = true;
			this.rejectQueuedToolRequestsWithoutHandler("Cursor pi tool bridge has no active live run");
		} else {
			this.liveRunHandlerDetached = false;
		}
		this.onToolRequest = handler;
		if (handler) {
			for (const request of this.queuedRequests.splice(0)) {
				handler(request);
			}
		}
	}

	resolveToolResults(toolResults: readonly ToolResultMessage[]): void {
		for (const toolResult of toolResults) {
			const pending = this.pendingByPiToolCallId.get(toolResult.toolCallId);
			if (!pending || pending.settled) continue;
			this.resolvePending(pending, {
				content: convertPiContentToMcpContent(toolResult.content),
				isError: toolResult.isError || undefined,
			});
		}
	}

	resolveToolResultsFromContext(context: Context): void {
		this.resolveToolResults(context.messages.map(asToolResultMessage).filter((message): message is ToolResultMessage => message !== undefined));
	}

	hasPendingPiToolCallId(piToolCallId: string): boolean {
		return this.pendingByPiToolCallId.has(piToolCallId);
	}

	cancelPendingPiToolCallId(piToolCallId: string, reason: string): boolean {
		const pending = this.pendingByPiToolCallId.get(piToolCallId);
		if (!pending) return false;
		this.rejectPending(pending, new Error(reason), "cancelled");
		return true;
	}

	isBridgeMcpToolCall(toolCall: unknown): boolean {
		if (!isRecord(toolCall)) return false;
		const toolName = getStringField(toolCall, ["name", "toolName", "mcpToolName"]);
		if (toolName && this.knownMcpToolNames.has(toolName)) return true;

		const cursorMcpCallId = getStringField(toolCall, ["call_id", "callId", "id", "toolCallId", "requestId"]);
		if (cursorMcpCallId && this.knownCursorMcpCallIds.has(cursorMcpCallId)) return true;

		if (containsKnownMcpToolName(toolCall, this.knownMcpToolNames)) return true;

		return false;
	}

	cancel(reason: string): void {
		const error = new Error(reason);
		const pendingCount = this.pendingCount();
		const queuedCount = this.queuedRequests.length;
		if (pendingCount > 0 || queuedCount > 0) {
			this.emitDiagnostic({
				event: "run_cancelled",
				...this.lifecycleDiagnosticFields(pendingCount),
				queuedCount,
				cancelledRequestCount: pendingCount,
			});
		}
		this.queuedRequests.splice(0);
		for (const pending of [...this.pendingByBridgeCallId.values()]) {
			this.rejectPending(pending, error, "cancelled");
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel("Cursor pi tool bridge run disposed");
		await waitForProtocolFlush();
		await Promise.allSettled([
			this.mcpTransport?.close(),
			this.mcpServer?.close(),
		]);
		await this.registry.unregisterRun(this.endpointPath, this);
		this.emitDiagnostic({
			event: "run_disposed",
			...this.lifecycleDiagnosticFields(),
		});
	}

	private async createMcpServer(): Promise<void> {
		const server = new McpProtocolServer(
			{ name: "pi-cursor-sdk-tool-bridge", version: MCP_SERVER_VERSION },
			{ capabilities: { tools: {} } },
		);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
		});

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: this.snapshot.tools.map(snapshotToolToMcpTool),
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			return this.enqueueToolRequest(request.params.name, request.params.arguments, String(extra.requestId), extra.signal);
		});

		this.mcpServer = server;
		this.mcpTransport = transport;
		await server.connect(transport);
	}

	private enqueueToolRequest(mcpToolName: string, argsValue: unknown, cursorMcpCallId: string, signal?: AbortSignal): Promise<CallToolResult> {
		const piToolName = this.snapshot.mcpToolNameToPiToolName.get(mcpToolName);
		if (!piToolName) {
			return Promise.resolve({
				content: [{ type: "text", text: `Unknown pi bridge tool: ${mcpToolName}` }],
				isError: true,
			});
		}
		if (this.disposed) return Promise.reject(new Error("Cursor pi tool bridge run is disposed"));

		this.toolCallCounter += 1;
		const bridgeCallId = `${this.id}-bridge-${this.toolCallCounter}`;
		const request: CursorPiBridgeToolRequest = {
			runId: this.id,
			bridgeCallId,
			cursorMcpCallId,
			piToolCallId: `${this.id}-tool-${this.toolCallCounter}`,
			piToolName,
			mcpToolName,
			args: normalizeMcpArgs(argsValue),
		};

		return new Promise<CallToolResult>((resolve, reject) => {
			const pending: PendingBridgeCall = {
				request,
				resolve,
				reject,
				signal,
				settled: false,
			};
			pending.onAbort = () => {
				this.rejectPending(pending, new Error("Cursor MCP bridge tool request was aborted"), "cancelled");
			};
			if (signal?.aborted) {
				pending.onAbort();
				return;
			}
			signal?.addEventListener("abort", pending.onAbort, { once: true });
			this.pendingByPiToolCallId.set(request.piToolCallId, pending);
			this.pendingByBridgeCallId.set(request.bridgeCallId, pending);
			this.pendingByCursorMcpCallId.set(cursorMcpCallId, pending);
			this.knownCursorMcpCallIds.add(cursorMcpCallId);
			if (!this.onToolRequest) {
				if (this.liveRunHandlerDetached) {
					this.rejectPending(pending, new Error("Cursor pi tool bridge has no active live run"), "cancelled");
					return;
				}
				this.queuedRequests.push(request);
				this.emitRequestQueuedDiagnostic(request);
				return;
			}
			this.emitRequestQueuedDiagnostic(request);
			this.onToolRequest(request);
		});
	}

	private rejectQueuedToolRequestsWithoutHandler(reason: string): void {
		while (this.queuedRequests.length > 0) {
			const request = this.queuedRequests.shift()!;
			const pending = this.pendingByPiToolCallId.get(request.piToolCallId);
			if (pending) this.rejectPending(pending, new Error(reason), "cancelled");
		}
	}

	private resolvePending(pending: PendingBridgeCall, result: CallToolResult): void {
		if (pending.settled) return;
		pending.settled = true;
		this.removePending(pending);
		this.emitRequestResolvedDiagnostic(pending.request, result.isError === true);
		pending.resolve(result);
	}

	private rejectPending(pending: PendingBridgeCall, error: Error, kind: "cancelled" | "error" = "error"): void {
		if (pending.settled) return;
		pending.settled = true;
		this.removePending(pending);
		this.emitRequestRejectedDiagnostic(pending.request, kind);
		pending.reject(error);
	}

	private lifecycleDiagnosticFields(pendingCount = this.pendingCount()): CursorPiToolBridgeLifecycleDiagnosticFields {
		return {
			runId: this.id,
			enabled: this.enabled,
			exposedToolCount: this.snapshot.tools.length,
			pendingCount,
		};
	}

	private requestDiagnosticFields(request: CursorPiBridgeToolRequest): CursorPiToolBridgeRequestDiagnosticFields {
		return {
			runId: this.id,
			bridgeCallId: request.bridgeCallId,
			cursorMcpCallId: request.cursorMcpCallId,
			piToolCallId: request.piToolCallId,
			mcpToolName: request.mcpToolName,
			piToolName: request.piToolName,
			pendingCount: this.pendingCount(),
		};
	}

	private emitRequestQueuedDiagnostic(request: CursorPiBridgeToolRequest): void {
		this.emitDiagnostic({ event: "request_queued", ...this.requestDiagnosticFields(request) });
	}

	private emitRequestResolvedDiagnostic(request: CursorPiBridgeToolRequest, isError: boolean): void {
		this.emitDiagnostic({ event: "request_resolved", ...this.requestDiagnosticFields(request), isError });
	}

	private emitRequestRejectedDiagnostic(request: CursorPiBridgeToolRequest, rejectionKind: CursorPiToolBridgeRejectionKind): void {
		this.emitDiagnostic({ event: "request_rejected", ...this.requestDiagnosticFields(request), rejectionKind });
	}

	private emitDiagnostic(event: CursorPiToolBridgeDiagnosticEvent): void {
		writeCursorPiToolBridgeDiagnostic(this.env, event);
	}

	private pendingCount(): number {
		return this.pendingByBridgeCallId.size;
	}

	private removePending(pending: PendingBridgeCall): void {
		pending.signal?.removeEventListener("abort", pending.onAbort ?? (() => undefined));
		this.pendingByPiToolCallId.delete(pending.request.piToolCallId);
		this.pendingByBridgeCallId.delete(pending.request.bridgeCallId);
		if (pending.request.cursorMcpCallId) this.pendingByCursorMcpCallId.delete(pending.request.cursorMcpCallId);
		const queuedIndex = this.queuedRequests.findIndex((request) => request.bridgeCallId === pending.request.bridgeCallId);
		if (queuedIndex >= 0) this.queuedRequests.splice(queuedIndex, 1);
	}
}

class CursorPiToolBridgeRegistry implements CursorPiToolBridge {
	private readonly pi: CursorPiToolBridgeSnapshotApi;
	private readonly env: Record<string, string | undefined>;
	private readonly runs = new Set<CursorPiToolBridgeRunImpl>();
	private readonly routes = new Map<string, CursorPiToolBridgeRunImpl>();
	private httpServer?: HttpServer;
	private listenPromise?: Promise<void>;

	constructor(
		pi: CursorPiToolBridgeSnapshotApi,
		env: Record<string, string | undefined> = process.env,
	) {
		this.pi = pi;
		this.env = env;
	}

	isEnabled(): boolean {
		return resolveCursorPiToolBridgeEnabled(this.env);
	}

	getToolSurfaceSignature(): string {
		if (!this.isEnabled()) return "bridge:off";
		const snapshot = buildCursorPiToolBridgeSnapshot(this.pi, {
			exposeOverlappingBuiltins: resolveCursorPiToolBridgeBuiltinsEnabled(this.env),
		});
		return buildCursorPiToolBridgeSurfaceSignature(snapshot);
	}

	async createRun(options: CursorPiToolBridgeRunOptions = {}): Promise<CursorPiToolBridgeRun> {
		const bridgeEnabled = this.isEnabled();
		const snapshot = bridgeEnabled
			? buildCursorPiToolBridgeSnapshot(this.pi, {
				exposeOverlappingBuiltins: resolveCursorPiToolBridgeBuiltinsEnabled(this.env),
			})
			: createEmptySnapshot();
		const run = new CursorPiToolBridgeRunImpl(this, this.env, snapshot, bridgeEnabled && snapshot.tools.length > 0, options);
		this.runs.add(run);
		await run.start();
		run.emitStartDiagnostics(bridgeEnabled);
		return run;
	}

	async disposeAll(reason = "Cursor pi tool bridge disposed"): Promise<void> {
		await Promise.all([...this.runs].map(async (run) => {
			run.cancel(reason);
			await run.dispose();
		}));
	}

	async registerRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<string> {
		await this.ensureHttpServer();
		this.routes.set(pathname, run);
		const address = this.getHttpServerAddress();
		if (!address) throw new Error("Cursor pi tool bridge HTTP server is not listening");
		return `http://${LOOPBACK_HOST}:${address.port}${pathname}`;
	}

	async unregisterRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<void> {
		if (this.routes.get(pathname) === run) this.routes.delete(pathname);
		this.runs.delete(run);
		if (this.routes.size === 0) await this.closeHttpServer();
	}

	getHttpServerAddress(): AddressInfo | undefined {
		const address = this.httpServer?.address();
		return isRecord(address) && typeof address.port === "number" ? address as AddressInfo : undefined;
	}

	getEndpointCount(): number {
		return this.routes.size;
	}

	hasPendingPiToolCallId(piToolCallId: string): boolean {
		for (const run of this.runs) {
			if (run.hasPendingPiToolCallId(piToolCallId)) return true;
		}
		return false;
	}

	cancelPendingPiToolCallId(piToolCallId: string, reason: string): boolean {
		for (const run of this.runs) {
			if (run.cancelPendingPiToolCallId(piToolCallId, reason)) return true;
		}
		return false;
	}

	private async ensureHttpServer(): Promise<void> {
		if (this.httpServer) {
			await this.listenPromise;
			return;
		}

		const server = createServer((req, res) => {
			void this.handleHttpRequest(req, res);
		});
		this.httpServer = server;
		this.listenPromise = new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(0, LOOPBACK_HOST);
		});
		await this.listenPromise;
	}

	private async closeHttpServer(): Promise<void> {
		const server = this.httpServer;
		if (!server) return;
		this.httpServer = undefined;
		this.listenPromise = undefined;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let closeTimer: ReturnType<typeof setTimeout> | undefined;
			const settle = (error?: Error): void => {
				if (settled) return;
				settled = true;
				if (closeTimer) clearTimeout(closeTimer);
				if (error) reject(error);
				else resolve();
			};

			closeTimer = setTimeout(() => settle(), HTTP_SERVER_CLOSE_GRACE_MS);
			closeTimer.unref?.();

			server.close((error) => {
				settle(error ?? undefined);
			});
			server.closeIdleConnections();
			server.closeAllConnections();
		});
	}

	private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.socket.localAddress !== LOOPBACK_HOST) {
			res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cursor pi tool bridge only accepts loopback requests" }));
			return;
		}

		const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
		const run = this.routes.get(url.pathname);
		if (!run) {
			res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cursor pi tool bridge endpoint not found" }));
			return;
		}

		try {
			await run.handleHttpRequest(req, res);
		} catch (error) {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}
}

let registeredCursorPiToolBridge: CursorPiToolBridgeRegistry | undefined;

export function registerCursorPiToolBridge(pi: CursorPiToolBridgeExtensionApi): CursorPiToolBridge {
	bridgeToolExecutionAbortTracker.abortAll("Cursor pi tool bridge extension reloaded");
	void registeredCursorPiToolBridge?.disposeAll("Cursor pi tool bridge extension reloaded");
	const bridge = new CursorPiToolBridgeRegistry(pi);
	registeredCursorPiToolBridge = bridge;
	pi.on("tool_call", (event, ctx) => {
		if (!bridge.hasPendingPiToolCallId(event.toolCallId)) return undefined;
		const trackingStarted = bridgeToolExecutionAbortTracker.track(event.toolCallId, {
			signal: ctx.signal,
			abort: () => {
				void ctx.abort();
			},
			cancelPending: (reason) => {
				bridge.cancelPendingPiToolCallId(event.toolCallId, reason);
			},
		});
		if (trackingStarted) return undefined;
		return { block: true, reason: "Cursor pi bridge tool execution was aborted before it started" };
	});
	pi.on("tool_result", (event) => {
		bridgeToolExecutionAbortTracker.finish(event.toolCallId);
	});
	pi.on("session_shutdown", async (event) => {
		const reason = `Cursor pi tool bridge session shutdown: ${event.reason}`;
		bridgeToolExecutionAbortTracker.abortAll(reason);
		await bridge.disposeAll(reason);
	});
	return bridge;
}

export function getRegisteredCursorPiToolBridge(): CursorPiToolBridge | undefined {
	return registeredCursorPiToolBridge;
}

export const __testUtils = {
	CURSOR_PI_TOOL_BRIDGE_ENV,
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV,
	CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	LOOPBACK_HOST,
	MCP_SERVER_NAME,
	createRegistry(
		pi: CursorPiToolBridgeSnapshotApi,
		env: Record<string, string | undefined> = process.env,
	) {
		return new CursorPiToolBridgeRegistry(pi, env);
	},
	getRegisteredBridgeForTests() {
		return registeredCursorPiToolBridge;
	},
	serializeDiagnosticForTests(event: CursorPiToolBridgeDiagnosticEvent) {
		return serializeCursorPiToolBridgeDiagnostic(event);
	},
	getActiveBridgeToolExecutionAbortCount() {
		return bridgeToolExecutionAbortTracker.getActiveCount();
	},
	emitBridgeToolExecutionProcessAbortSignalForTests(signal: NodeJS.Signals) {
		bridgeToolExecutionAbortTracker.emitProcessAbortSignalForTests(signal);
	},
	resetRegisteredBridgeForTests() {
		bridgeToolExecutionAbortTracker.abortAll("Cursor pi tool bridge test reset");
		const bridge = registeredCursorPiToolBridge;
		registeredCursorPiToolBridge = undefined;
		return bridge?.disposeAll("Cursor pi tool bridge test reset") ?? Promise.resolve();
	},
};
