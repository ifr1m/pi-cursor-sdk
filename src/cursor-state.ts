import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentModeOption } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	buildCursorToolManifestText,
	CURSOR_TOOL_MANIFEST_ENV,
	resolveCursorToolManifestEnabled,
} from "./cursor-tool-manifest.js";
import {
	buildCursorPiToolBridgeSnapshot,
	CURSOR_PI_TOOL_BRIDGE_ENV,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-snapshot.js";
import {
	CURSOR_SETTING_SOURCES_ENV,
	getEffectiveCursorSettingSources,
} from "./cursor-setting-sources.js";
import { isCursorModel } from "./cursor-model.js";
import { getCursorModelMetadata } from "./model-discovery.js";

const FAST_ENTRY_TYPE = "cursor-fast-state";
const MODE_ENTRY_TYPE = "cursor-mode-state";
const GLOBAL_CONFIG_FILE = "cursor-sdk.json";

export type CursorAgentMode = AgentModeOption;

const DEFAULT_CURSOR_AGENT_MODE: AgentModeOption = "agent";

interface CursorFastEntryData {
	modelId?: string;
	baseModelId?: string;
	fast: boolean;
}

interface CursorModeEntryData {
	mode: AgentModeOption;
}

interface CursorGlobalConfig {
	fastDefaults?: Record<string, boolean>;
}

type CursorRuntimeControlsExtensionApi = Pick<
	ExtensionAPI,
	"appendEntry" | "getFlag" | "registerFlag" | "registerCommand" | "on" | "getActiveTools" | "getAllTools"
>;

type CursorCliModeState =
	| { kind: "unset" }
	| { kind: "valid"; mode: AgentModeOption }
	| { kind: "invalid"; raw: string; message: string };

const sessionFastPreferences = new Map<string, boolean>();
let globalFastPreferences = new Map<string, boolean>();
let cliForceFast = false;
let cliForceNoFast = false;
let sessionCursorAgentMode: AgentModeOption | undefined;
let cliCursorModeState: CursorCliModeState = { kind: "unset" };

export function isCursorAgentMode(value: unknown): value is AgentModeOption {
	return value === "agent" || value === "plan";
}

export function parseCursorAgentMode(raw: unknown): AgentModeOption | undefined {
	if (typeof raw !== "string") return undefined;
	const mode = raw.trim();
	return isCursorAgentMode(mode) ? mode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCursorFastEntryData(value: unknown): value is CursorFastEntryData {
	if (!isRecord(value)) return false;
	return (typeof value.modelId === "string" || typeof value.baseModelId === "string") && typeof value.fast === "boolean";
}

function getCursorFastEntryModelId(data: CursorFastEntryData): string {
	return data.modelId ?? data.baseModelId ?? "";
}

function isCursorModeEntryData(value: unknown): value is CursorModeEntryData {
	return isRecord(value) && isCursorAgentMode(value.mode);
}

function parseCursorGlobalConfig(value: unknown): CursorGlobalConfig | undefined {
	if (!isRecord(value)) return undefined;
	const { fastDefaults } = value;
	if (fastDefaults === undefined) return {};
	if (!isRecord(fastDefaults)) return undefined;
	return {
		fastDefaults: Object.fromEntries(
			Object.entries(fastDefaults).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
		),
	};
}

function getConfigPath(): string {
	return join(getAgentDir(), GLOBAL_CONFIG_FILE);
}

function loadGlobalFastPreferences(): Map<string, boolean> {
	const path = getConfigPath();
	if (!existsSync(path)) return new Map();
	try {
		const parsed = parseCursorGlobalConfig(JSON.parse(readFileSync(path, "utf-8")));
		return new Map(Object.entries(parsed?.fastDefaults ?? {}));
	} catch {
		return new Map();
	}
}

function saveGlobalFastPreferences(): void {
	const path = getConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	const config: CursorGlobalConfig = {
		fastDefaults: Object.fromEntries([...globalFastPreferences.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function restoreSessionFastPreferences(ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> }): void {
	sessionFastPreferences.clear();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
		if (isCursorFastEntryData(entry.data)) {
			const modelId = getCursorFastEntryModelId(entry.data);
			if (modelId) sessionFastPreferences.set(modelId, entry.data.fast);
		}
	}
}

function restoreSessionCursorMode(ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> }): void {
	sessionCursorAgentMode = undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		if (isCursorModeEntryData(entry.data)) {
			sessionCursorAgentMode = entry.data.mode;
		}
	}
}

function getFastPreferenceModelId(metadata: NonNullable<ReturnType<typeof getCursorModelMetadata>>): string {
	return metadata.selectionModelId || metadata.baseModelId;
}

function getVirtualFastBaseModelId(modelId: string): string {
	return modelId.replace(/:(?:fast|slow)$/, "");
}

function getStoredFastPreference(metadata: NonNullable<ReturnType<typeof getCursorModelMetadata>>): boolean | undefined {
	const preferenceModelId = getFastPreferenceModelId(metadata);
	return (
		sessionFastPreferences.get(preferenceModelId) ??
		(preferenceModelId !== metadata.baseModelId ? sessionFastPreferences.get(metadata.baseModelId) : undefined) ??
		globalFastPreferences.get(preferenceModelId) ??
		(preferenceModelId !== metadata.baseModelId ? globalFastPreferences.get(metadata.baseModelId) : undefined)
	);
}

function getEffectiveFast(modelId: string): boolean | undefined {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata?.supportsFast) return undefined;
	if (cliForceNoFast) return false;
	if (cliForceFast) return true;
	if (metadata.fastOverride !== undefined) return metadata.fastOverride;
	return getStoredFastPreference(metadata) ?? metadata.defaultFast;
}

function formatInvalidCursorMode(raw: string): string {
	return `Invalid --cursor-mode "${raw}". Use "agent" or "plan".`;
}

export function getEffectiveCursorAgentMode(): AgentModeOption {
	switch (cliCursorModeState.kind) {
		case "valid":
			return cliCursorModeState.mode;
		case "invalid":
			throw new Error(cliCursorModeState.message);
		case "unset":
			return sessionCursorAgentMode ?? DEFAULT_CURSOR_AGENT_MODE;
	}
}

function formatCursorStatus(fast: boolean | undefined): string | undefined {
	const parts: string[] = [];
	if (fast === true) parts.push("fast");
	if (cliCursorModeState.kind === "invalid") {
		parts.push("mode invalid");
	} else if (getEffectiveCursorAgentMode() === "plan") {
		parts.push("plan");
	}
	return parts.length > 0 ? `cursor ${parts.join(" · ")}` : undefined;
}

function updateCursorStatus(ctx: Pick<ExtensionContext, "model" | "ui">, model = ctx.model): void {
	if (!model || !isCursorModel(model)) {
		ctx.ui.setStatus("cursor", undefined);
		return;
	}
	const metadata = getCursorModelMetadata(model.id);
	const fast = metadata?.supportsFast ? getEffectiveFast(model.id) : undefined;
	ctx.ui.setStatus("cursor", formatCursorStatus(fast));
}

function getCurrentCursorMetadata(ctx: Pick<ExtensionContext, "model">) {
	const model = ctx.model;
	if (!model || !isCursorModel(model)) return undefined;
	return getCursorModelMetadata(model.id);
}

function restoreMapValue(map: Map<string, boolean>, key: string, previous: boolean | undefined): void {
	if (previous === undefined) {
		map.delete(key);
	} else {
		map.set(key, previous);
	}
}

function persistFastPreference(pi: Pick<ExtensionAPI, "appendEntry">, modelId: string, fast: boolean): void {
	const previousSession = sessionFastPreferences.get(modelId);
	const previousGlobal = globalFastPreferences.get(modelId);
	let savedGlobal = false;
	sessionFastPreferences.set(modelId, fast);
	globalFastPreferences.set(modelId, fast);
	try {
		saveGlobalFastPreferences();
		savedGlobal = true;
		pi.appendEntry<CursorFastEntryData>(FAST_ENTRY_TYPE, { modelId, fast });
	} catch (error) {
		restoreMapValue(sessionFastPreferences, modelId, previousSession);
		restoreMapValue(globalFastPreferences, modelId, previousGlobal);
		if (savedGlobal) {
			try {
				saveGlobalFastPreferences();
			} catch {
				// Preserve the original append failure reported to the user.
			}
		}
		throw error;
	}
}

function persistCursorModePreference(pi: Pick<ExtensionAPI, "appendEntry">, mode: AgentModeOption): void {
	const previousMode = sessionCursorAgentMode;
	sessionCursorAgentMode = mode;
	try {
		pi.appendEntry<CursorModeEntryData>(MODE_ENTRY_TYPE, { mode });
	} catch (error) {
		sessionCursorAgentMode = previousMode;
		throw error;
	}
}

function restoreCliCursorMode(raw: boolean | string | undefined, hasUI: boolean, notify: ExtensionContext["ui"]["notify"]): void {
	cliCursorModeState = { kind: "unset" };
	if (raw === undefined || raw === "" || raw === false) return;
	const parsed = parseCursorAgentMode(raw);
	if (parsed) {
		cliCursorModeState = { kind: "valid", mode: parsed };
		return;
	}
	const rawText = String(raw);
	const message = formatInvalidCursorMode(rawText);
	cliCursorModeState = { kind: "invalid", raw: rawText, message };
	if (hasUI) {
		notify(message, "error");
		return;
	}
	throw new Error(message);
}

function formatEffectiveCursorSettingSourcesLabel(raw: string | undefined = process.env[CURSOR_SETTING_SOURCES_ENV]): string {
	const effective = getEffectiveCursorSettingSources(raw);
	const effectiveLabel = effective === undefined ? "none" : effective.join(",");
	const rawLabel = raw?.trim() ? raw.trim() : "(unset → all)";
	return `${rawLabel} (effective: ${effectiveLabel})`;
}

export function formatCursorToolsDebugReport(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
	env: Record<string, string | undefined> = process.env,
): string {
	const bridgeEnabled = resolveCursorPiToolBridgeEnabled(env);
	const manifestEnabled = resolveCursorToolManifestEnabled(env);
	const lines = [
		"Cursor tool surfaces (current session):",
		`${CURSOR_PI_TOOL_BRIDGE_ENV}: ${bridgeEnabled ? "enabled" : "disabled"}`,
		`${CURSOR_TOOL_MANIFEST_ENV}: ${manifestEnabled ? "enabled" : "disabled"}`,
		`${CURSOR_SETTING_SOURCES_ENV}: ${formatEffectiveCursorSettingSourcesLabel(env[CURSOR_SETTING_SOURCES_ENV])}`,
	];

	let bridgeSnapshot;
	if (bridgeEnabled) {
		try {
			bridgeSnapshot = buildCursorPiToolBridgeSnapshot(pi);
		} catch {
			lines.push("Pi bridge snapshot: unavailable (extension tool APIs required).");
		}
	}

	lines.push(buildCursorToolManifestText({ bridgeSnapshot, piBridgeEnabled: bridgeEnabled }));
	return lines.join("\n");
}

function emitCursorToolsDebugReport(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): void {
	const report = formatCursorToolsDebugReport(pi);
	if (ctx.hasUI) {
		ctx.ui.notify(report, "info");
		return;
	}
	console.log(report);
}

export function getEffectiveFastForModelId(modelId: string): boolean | undefined {
	return getEffectiveFast(modelId);
}

export function registerCursorRuntimeControls(pi: CursorRuntimeControlsExtensionApi): void {
	pi.registerFlag("cursor-fast", {
		description: "Force Cursor fast mode for this run when the selected Cursor model supports it",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-no-fast", {
		description: "Force Cursor fast mode off for this run when the selected Cursor model supports it",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("cursor-mode", {
		description: "Set Cursor SDK conversation mode for this run: agent or plan",
		type: "string",
		default: "",
	});

	pi.registerCommand("cursor-fast", {
		description: "Toggle Cursor fast mode for the selected Cursor model",
		handler: async (_args, ctx) => {
			const metadata = getCurrentCursorMetadata(ctx);
			if (!metadata?.supportsFast || !ctx.model) {
				const modelName = ctx.model?.id ?? "current model";
				ctx.ui.notify(`Fast mode not supported by ${modelName}`, "info");
				return;
			}
			if (cliForceNoFast) {
				ctx.ui.notify("Cursor fast is forced off by --cursor-no-fast", "info");
				return;
			}
			if (cliForceFast) {
				ctx.ui.notify("Cursor fast is forced by --cursor-fast", "info");
				return;
			}
			if (metadata.fastOverride !== undefined) {
				const state = metadata.fastOverride ? "enabled" : "disabled";
				ctx.ui.notify(
					`Cursor fast is fixed ${state} by selected model ${metadata.piModelId}; choose ${getVirtualFastBaseModelId(metadata.piModelId)} to use /cursor-fast preferences`,
					"info",
				);
				return;
			}

			const preferenceModelId = getFastPreferenceModelId(metadata);
			const current = getEffectiveFast(metadata.piModelId) ?? false;
			const next = !current;
			try {
				persistFastPreference(pi, preferenceModelId, next);
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(`Failed to save Cursor fast preference: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			updateCursorStatus(ctx);
			ctx.ui.notify(`Cursor fast ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("cursor-tools", {
		description: "Show live Cursor tool surfaces for this session (maintainer debug)",
		handler: async (_args, ctx) => {
			emitCursorToolsDebugReport(pi, ctx);
		},
	});

	pi.registerCommand("cursor-mode", {
		description: "Set Cursor SDK conversation mode: agent or plan",
		handler: async (args, ctx) => {
			const usage = "Usage: /cursor-mode agent|plan";
			const mode = parseCursorAgentMode(args);
			if (!args.trim()) {
				try {
					ctx.ui.notify(`Cursor mode is ${getEffectiveCursorAgentMode()}. ${usage}`, "info");
				} catch (error) {
					ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} ${usage}`, "error");
				}
				return;
			}
			if (!mode) {
				ctx.ui.notify(`Invalid Cursor mode "${args.trim()}". ${usage}`, "error");
				return;
			}
			if (cliCursorModeState.kind === "valid") {
				ctx.ui.notify(`Cursor mode is forced to ${cliCursorModeState.mode} by --cursor-mode`, "info");
				return;
			}
			const clearedInvalidCliMode = cliCursorModeState.kind === "invalid";
			try {
				persistCursorModePreference(pi, mode);
				if (clearedInvalidCliMode) cliCursorModeState = { kind: "unset" };
			} catch (error) {
				updateCursorStatus(ctx);
				ctx.ui.notify(`Failed to save Cursor mode preference: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			updateCursorStatus(ctx);
			ctx.ui.notify(
				clearedInvalidCliMode
					? `Cursor mode set to ${mode}; cleared invalid --cursor-mode override`
					: `Cursor mode set to ${mode}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		globalFastPreferences = loadGlobalFastPreferences();
		cliForceFast = pi.getFlag("cursor-fast") === true;
		cliForceNoFast = pi.getFlag("cursor-no-fast") === true;
		restoreSessionFastPreferences(ctx);
		restoreSessionCursorMode(ctx);
		restoreCliCursorMode(pi.getFlag("cursor-mode"), ctx.hasUI, ctx.ui.notify.bind(ctx.ui));
		updateCursorStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		updateCursorStatus(ctx, event.model);
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateCursorStatus(ctx);
	});
}

function resetCursorModeStateForTests(): void {
	sessionCursorAgentMode = undefined;
	cliCursorModeState = { kind: "unset" };
}

export const __testUtils = {
	FAST_ENTRY_TYPE,
	MODE_ENTRY_TYPE,
	DEFAULT_CURSOR_AGENT_MODE,
	getConfigPath,
	loadGlobalFastPreferences,
	sessionFastPreferences,
	getSessionCursorAgentMode: () => sessionCursorAgentMode,
	getCliCursorAgentMode: () => (cliCursorModeState.kind === "valid" ? cliCursorModeState.mode : undefined),
	getCliCursorModeState: () => cliCursorModeState,
	resetCursorModeStateForTests,
};
