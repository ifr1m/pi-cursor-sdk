import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, ExtensionHandler, SessionStartEvent, TurnStartEvent } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES,
	isNativeCursorToolName,
	NATIVE_CURSOR_TOOL_NAMES,
	registerNativeCursorTool,
	type NativeCursorToolName,
} from "./cursor-native-tool-display-tools.js";
import { isCursorModel } from "./cursor-model.js";
import {
	isCursorNativeToolDisplayRequested,
	isCursorNativeToolRegistrationRequested,
	NATIVE_CURSOR_TOOL_DISPLAY_ENV,
	readBooleanEnv,
	registeredNativeToolNames,
	skippedNativeToolNames,
} from "./cursor-native-tool-display-state.js";
import { isCursorReplayToolName } from "./cursor-tool-names.js";

export const CURSOR_CORE_PI_REPLAY_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const CORE_PI_TOOL_NAMES = new Set<string>(CURSOR_CORE_PI_REPLAY_TOOL_NAMES);

function isCursorCorePiReplayToolName(toolName: string): toolName is (typeof CURSOR_CORE_PI_REPLAY_TOOL_NAMES)[number] {
	return CORE_PI_TOOL_NAMES.has(toolName);
}

type CursorNativeToolActivationApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
type CursorNativeToolRegistryApi = CursorNativeToolActivationApi & Pick<ExtensionAPI, "getAllTools" | "registerTool">;

export interface CursorNativeToolDisplayExtensionApi extends CursorNativeToolRegistryApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "model_select", handler: (event: { model: ExtensionContext["model"] }, ctx: ExtensionContext) => Promise<void> | void): void;
}

function hasNonBuiltinTool(pi: Pick<ExtensionAPI, "getAllTools">, toolName: NativeCursorToolName): boolean {
	const existingTool = pi.getAllTools().find((tool) => tool.name === toolName);
	return existingTool !== undefined && existingTool.sourceInfo.source !== "builtin";
}

type NativeRegistrationContext = { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "notify">; model?: ExtensionContext["model"] };

function registerNativeCursorToolsFromSet(
	pi: CursorNativeToolRegistryApi,
	toolNames: readonly NativeCursorToolName[],
): NativeCursorToolName[] {
	const newlySkippedToolNames: NativeCursorToolName[] = [];
	for (const toolName of toolNames) {
		if (registeredNativeToolNames.has(toolName) || skippedNativeToolNames.has(toolName)) continue;
		if (hasNonBuiltinTool(pi, toolName)) {
			skippedNativeToolNames.add(toolName);
			newlySkippedToolNames.push(toolName);
			continue;
		}
		registerNativeCursorTool(pi, toolName);
		registeredNativeToolNames.add(toolName);
	}
	return newlySkippedToolNames;
}

function notifySkippedNativeCursorToolsIfNeeded(ctx: NativeRegistrationContext, skippedToolNames: readonly NativeCursorToolName[]): void {
	if (skippedToolNames.length === 0 || readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== true || !ctx.hasUI) return;
	ctx.ui.notify(
		`Cursor native tool replay skipped for ${skippedToolNames.join(", ")} because another extension already provides ${skippedToolNames.length === 1 ? "that tool" : "those tools"}. Cursor will use scrubbed activity transcripts for skipped tools.`,
		"warning",
	);
}

function hasAttemptedNativeCursorToolRegistration(): boolean {
	return registeredNativeToolNames.size > 0 || skippedNativeToolNames.size > 0;
}

export function syncRegisteredNativeCursorToolsForModel(
	pi: CursorNativeToolActivationApi,
	model: ExtensionContext["model"],
): void {
	if (registeredNativeToolNames.size === 0) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	if (isCursorModel(model)) {
		for (const toolName of registeredNativeToolNames) {
			if (isCursorReplayToolName(toolName) && !CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES.some((activeReplayToolName) => activeReplayToolName === toolName)) continue;
			if (activeToolNames.has(toolName)) continue;
			activeToolNames.add(toolName);
			changed = true;
		}
	} else {
		for (const toolName of registeredNativeToolNames) {
			if (isCursorCorePiReplayToolName(toolName)) continue;
			if (!activeToolNames.delete(toolName)) continue;
			changed = true;
		}
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

function ensureNativeCursorToolsRegisteredForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext): void {
	if (!isCursorNativeToolRegistrationRequested()) {
		registeredNativeToolNames.clear();
		skippedNativeToolNames.clear();
		return;
	}
	if (!isCursorModel(ctx.model) || hasAttemptedNativeCursorToolRegistration()) return;

	const nonCoreToolNames = NATIVE_CURSOR_TOOL_NAMES.filter((toolName) => !isCursorCorePiReplayToolName(toolName));
	const skippedToolNames = [
		...registerNativeCursorToolsFromSet(pi, nonCoreToolNames),
		...registerNativeCursorToolsFromSet(pi, CURSOR_CORE_PI_REPLAY_TOOL_NAMES),
	];
	notifySkippedNativeCursorToolsIfNeeded(ctx, skippedToolNames);
}

function ensureThenSyncNativeCursorToolsForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext): void {
	if (isCursorModel(ctx.model) && !hasAttemptedNativeCursorToolRegistration()) {
		ensureNativeCursorToolsRegisteredForModel(pi, ctx);
	}
	syncRegisteredNativeCursorToolsForModel(pi, ctx.model);
}

export function registerCursorNativeToolDisplay(pi: CursorNativeToolDisplayExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		ensureThenSyncNativeCursorToolsForModel(pi, ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		ensureThenSyncNativeCursorToolsForModel(pi, ctx);
	});
	pi.on("turn_start", (_event, ctx) => {
		ensureThenSyncNativeCursorToolsForModel(pi, ctx);
	});
	pi.on("model_select", (event, ctx) => {
		ensureThenSyncNativeCursorToolsForModel(pi, { ...ctx, model: event.model });
	});
}

export { isNativeCursorToolName, isCursorNativeToolDisplayRequested };
