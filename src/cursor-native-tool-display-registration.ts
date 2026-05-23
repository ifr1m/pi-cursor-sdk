import type { ExtensionAPI, ExtensionContext, ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES,
	CURSOR_REPLAY_TOOL_NAMES,
	isNativeCursorToolName,
	NATIVE_CURSOR_TOOL_NAMES,
	registerNativeCursorTool,
	type NativeCursorToolName,
} from "./cursor-native-tool-display-tools.js";
import {
	isCursorNativeToolDisplayRequested,
	isCursorNativeToolRegistrationRequested,
	NATIVE_CURSOR_TOOL_DISPLAY_ENV,
	readBooleanEnv,
	registeredNativeToolNames,
} from "./cursor-native-tool-display-state.js";
import { isCursorReplayToolName } from "./cursor-tool-names.js";

type CursorNativeToolRegistryApi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "registerTool" | "setActiveTools">;

export interface CursorNativeToolDisplayExtensionApi extends CursorNativeToolRegistryApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "model_select", handler: (event: { model: ExtensionContext["model"] }, ctx: ExtensionContext) => Promise<void> | void): void;
}

function hasNonBuiltinTool(pi: Pick<ExtensionAPI, "getAllTools">, toolName: NativeCursorToolName): boolean {
	const existingTool = pi.getAllTools().find((tool) => tool.name === toolName);
	return existingTool !== undefined && existingTool.sourceInfo.source !== "builtin";
}

type NativeRegistrationContext = { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "notify">; model?: ExtensionContext["model"] };

function isCursorModel(model: ExtensionContext["model"]): boolean {
	return model?.provider === "cursor" || model?.api === "cursor-sdk";
}

export function syncRegisteredNativeCursorToolsForModel(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, model: ExtensionContext["model"]): void {
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
		for (const toolName of CURSOR_REPLAY_TOOL_NAMES) {
			if (!activeToolNames.delete(toolName)) continue;
			changed = true;
		}
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

function registerAvailableNativeCursorTools(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext): void {
	if (!isCursorNativeToolRegistrationRequested()) {
		registeredNativeToolNames.clear();
		return;
	}

	const skippedToolNames: string[] = [];
	for (const toolName of NATIVE_CURSOR_TOOL_NAMES) {
		if (registeredNativeToolNames.has(toolName)) continue;
		if (hasNonBuiltinTool(pi, toolName)) {
			skippedToolNames.push(toolName);
			continue;
		}
		registerNativeCursorTool(pi, toolName);
		registeredNativeToolNames.add(toolName);
	}

	syncRegisteredNativeCursorToolsForModel(pi, ctx.model);

	if (skippedToolNames.length > 0 && readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) === true && ctx.hasUI) {
		ctx.ui.notify(
			`Cursor native tool replay skipped for ${skippedToolNames.join(", ")} because another extension already provides ${skippedToolNames.length === 1 ? "that tool" : "those tools"}. Cursor will use scrubbed activity transcripts for skipped tools.`,
			"warning",
		);
	}
}

export function registerCursorNativeToolDisplay(pi: CursorNativeToolDisplayExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		registerAvailableNativeCursorTools(pi, ctx);
	});
	pi.on("model_select", (event) => {
		syncRegisteredNativeCursorToolsForModel(pi, event.model);
	});
}

export { isNativeCursorToolName, isCursorNativeToolDisplayRequested };
