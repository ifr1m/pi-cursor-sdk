import {
	createBashToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { CursorPiToolDisplay } from "./cursor-tool-transcript.js";

const NATIVE_CURSOR_TOOL_NAMES = ["read", "bash", "ls"] as const;
type NativeCursorToolName = (typeof NATIVE_CURSOR_TOOL_NAMES)[number];
const NATIVE_CURSOR_TOOL_DISPLAY_ENV = "PI_CURSOR_NATIVE_TOOL_DISPLAY";
// Registration-only kill switch for users who want transcript fallback without shadowing read/bash/ls.
const NATIVE_CURSOR_TOOL_REGISTRATION_ENV = "PI_CURSOR_REGISTER_NATIVE_TOOLS";

export interface CursorNativeToolDisplayItem extends CursorPiToolDisplay {
	id: string;
	terminate?: boolean;
}

const registeredNativeToolNames = new Set<NativeCursorToolName>();
const nativeToolResults = new Map<string, CursorNativeToolDisplayItem>();

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off") return false;
	return undefined;
}

function isCursorNativeToolDisplayRequested(): boolean {
	const override = readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV);
	if (override !== undefined) return override;
	return process.stdout.isTTY === true;
}

function isNativeCursorToolName(toolName: string): toolName is NativeCursorToolName {
	return NATIVE_CURSOR_TOOL_NAMES.some((nativeToolName) => nativeToolName === toolName);
}

function isCursorNativeToolRegistrationRequested(): boolean {
	return readBooleanEnv(NATIVE_CURSOR_TOOL_REGISTRATION_ENV) !== false && isCursorNativeToolDisplayRequested();
}

export function isCursorNativeToolDisplayEnabled(): boolean {
	return registeredNativeToolNames.size > 0;
}

export function isCursorNativeToolDisplayRuntimeEnabled(): boolean {
	return isCursorNativeToolDisplayRequested() && registeredNativeToolNames.size > 0;
}

export function canRenderCursorToolNatively(toolName: string): boolean {
	return isNativeCursorToolName(toolName) && registeredNativeToolNames.has(toolName);
}

export function recordCursorNativeToolDisplay(item: CursorNativeToolDisplayItem): boolean {
	if (!canRenderCursorToolNatively(item.toolName)) return false;
	nativeToolResults.set(item.id, item);
	return true;
}

export function deleteCursorNativeToolDisplay(id: string): void {
	nativeToolResults.delete(id);
}

function consumeCursorNativeToolDisplay(id: string): CursorNativeToolDisplayItem | undefined {
	const item = nativeToolResults.get(id);
	if (item) nativeToolResults.delete(id);
	return item;
}

export const __testUtils = {
	nativeToolResultCount: () => nativeToolResults.size,
	reset(): void {
		registeredNativeToolNames.clear();
		nativeToolResults.clear();
	},
};

function wrapNativeCursorTool<TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cursorDisplay = consumeCursorNativeToolDisplay(toolCallId);
			if (cursorDisplay) {
				return {
					content: cursorDisplay.result.content,
					details: cursorDisplay.result.details as TDetails,
					terminate: cursorDisplay.terminate ?? true,
				};
			}
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

function registerNativeCursorTool(pi: ExtensionAPI, toolName: NativeCursorToolName, cwd: string): void {
	if (toolName === "read") {
		pi.registerTool(wrapNativeCursorTool(createReadToolDefinition(cwd)));
		return;
	}
	if (toolName === "bash") {
		pi.registerTool(wrapNativeCursorTool(createBashToolDefinition(cwd)));
		return;
	}
	pi.registerTool(wrapNativeCursorTool(createLsToolDefinition(cwd)));
}

function hasNonBuiltinTool(pi: ExtensionAPI, toolName: NativeCursorToolName): boolean {
	const existingTool = pi.getAllTools().find((tool) => tool.name === toolName);
	return existingTool !== undefined && existingTool.sourceInfo.source !== "builtin";
}

function registerAvailableNativeCursorTools(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!isCursorNativeToolRegistrationRequested()) {
		registeredNativeToolNames.clear();
		return;
	}

	const cwd = process.cwd();
	const skippedToolNames: string[] = [];
	for (const toolName of NATIVE_CURSOR_TOOL_NAMES) {
		if (registeredNativeToolNames.has(toolName)) continue;
		if (hasNonBuiltinTool(pi, toolName)) {
			skippedToolNames.push(toolName);
			continue;
		}
		registerNativeCursorTool(pi, toolName, cwd);
		registeredNativeToolNames.add(toolName);
	}

	if (skippedToolNames.length > 0 && readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) === true && ctx.hasUI) {
		ctx.ui.notify(
			`Cursor native tool replay skipped for ${skippedToolNames.join(", ")} because another extension already provides ${skippedToolNames.length === 1 ? "that tool" : "those tools"}. Cursor will use scrubbed activity transcripts for skipped tools.`,
			"warning",
		);
	}
}

export function registerCursorNativeToolDisplay(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		registerAvailableNativeCursorTools(pi, ctx);
	});
}
