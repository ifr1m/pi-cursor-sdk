import {
	createBashToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { CursorPiToolDisplay } from "./cursor-tool-transcript.js";

const NATIVE_CURSOR_TOOL_NAMES = new Set(["read", "bash", "ls"]);

export interface CursorNativeToolDisplayItem extends CursorPiToolDisplay {
	id: string;
}

let nativeToolDisplayEnabled = false;
const nativeToolResults = new Map<string, CursorNativeToolDisplayItem>();

export function isCursorNativeToolDisplayEnabled(): boolean {
	return nativeToolDisplayEnabled;
}

export function isCursorNativeToolDisplayRuntimeEnabled(): boolean {
	if (!nativeToolDisplayEnabled) return false;
	const override = process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return process.stdout.isTTY === true;
}

export function canRenderCursorToolNatively(toolName: string): boolean {
	return NATIVE_CURSOR_TOOL_NAMES.has(toolName);
}

export function recordCursorNativeToolDisplay(item: CursorNativeToolDisplayItem): void {
	if (!nativeToolDisplayEnabled || !canRenderCursorToolNatively(item.toolName)) return;
	nativeToolResults.set(item.id, item);
}

function consumeCursorNativeToolDisplay(id: string): CursorNativeToolDisplayItem | undefined {
	const item = nativeToolResults.get(id);
	if (item) nativeToolResults.delete(id);
	return item;
}

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
					terminate: true,
				};
			}
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

export function registerCursorNativeToolDisplay(pi: ExtensionAPI): void {
	nativeToolDisplayEnabled = true;
	const cwd = process.cwd();
	pi.registerTool(wrapNativeCursorTool(createReadToolDefinition(cwd)));
	pi.registerTool(wrapNativeCursorTool(createBashToolDefinition(cwd)));
	pi.registerTool(wrapNativeCursorTool(createLsToolDefinition(cwd)));
}
