import {
	classifyCursorWebToolKind as classifyCursorWebToolKindFromRegistry,
	type CursorWebToolKind,
} from "./cursor-tool-presentation-registry.js";
import { normalizeCursorToolName as normalizeToolName } from "./cursor-tool-presentation-registry.js";
import { extractWebFetchTarget, extractWebSearchQuery } from "./cursor-web-tool-args.js";

export type { CursorWebToolKind } from "./cursor-tool-presentation-registry.js";
export { extractWebFetchTarget, extractWebSearchQuery } from "./cursor-web-tool-args.js";

function getMcpToolName(args: Record<string, unknown>): string | undefined {
	const toolName = typeof args.toolName === "string" ? args.toolName : typeof args.tool_name === "string" ? args.tool_name : undefined;
	const trimmed = toolName?.trim();
	return trimmed || undefined;
}

export function classifyCursorWebToolKind(name: string | undefined): CursorWebToolKind | undefined {
	return classifyCursorWebToolKindFromRegistry(name);
}

/**
 * Maps SDK/host/MCP tool names to transcript display keys.
 * Web search/fetch often arrives as MCP `toolName` values, not dedicated SDK ToolTypes.
 */
export function resolveTranscriptToolName(rawName: string, args: Record<string, unknown>): string {
	const normalized = normalizeToolName(rawName);
	const directWebKind = classifyCursorWebToolKind(rawName) ?? classifyCursorWebToolKind(normalized);
	if (directWebKind) return directWebKind;
	if (normalized === "mcp") {
		const mcpWebKind = classifyCursorWebToolKind(getMcpToolName(args));
		if (mcpWebKind) return mcpWebKind;
	}
	return normalized;
}
