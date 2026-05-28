import { parseEnvBoolean } from "./cursor-env-boolean.js";
import type { CursorPiToolBridgeSnapshot } from "./cursor-pi-tool-bridge-types.js";

export const CURSOR_TOOL_MANIFEST_ENV = "PI_CURSOR_TOOL_MANIFEST";

/**
 * Representative @cursor/sdk@1.0.14 local-agent ToolType values; actual exposure can vary by run.
 * See docs/cursor-native-tool-replay.md#sdk-tooltype-replay-matrix.
 */
export const CURSOR_HOST_TOOL_MANIFEST_SUMMARY =
	"read, shell, grep, glob, ls, edit, write, delete, readLints, updateTodos, createPlan, task, generateImage, mcp, semSearch, recordScreen, and web search/fetch when exposed";

export function resolveCursorToolManifestEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return parseEnvBoolean(env[CURSOR_TOOL_MANIFEST_ENV], true);
}

export function buildCursorToolManifestText(options: {
	bridgeSnapshot?: CursorPiToolBridgeSnapshot;
	/** When false, bridge is off via PI_CURSOR_PI_TOOL_BRIDGE=0 (not merely empty). */
	piBridgeEnabled?: boolean;
} = {}): string {
	const piBridgeEnabled = options.piBridgeEnabled ?? true;
	const lines = [
		"Callable tool surfaces this run:",
		`- Cursor SDK host tools (callable; not listed in MCP listTools): ${CURSOR_HOST_TOOL_MANIFEST_SUMMARY}.`,
		"- Configured Cursor MCP servers: discovered at runtime via MCP listTools (depends on Cursor settings and PI_CURSOR_SETTING_SOURCES).",
	];
	const bridgeTools = options.bridgeSnapshot?.tools ?? [];
	if (!piBridgeEnabled) {
		lines.push("- Pi bridge: disabled (PI_CURSOR_PI_TOOL_BRIDGE=0).");
	} else if (bridgeTools.length === 0) {
		lines.push("- Pi bridge: no pi__* tools exposed this run.");
	} else {
		const names = [...bridgeTools.map((tool) => tool.mcpToolName)].sort().join(", ");
		lines.push(`- Pi bridge (call pi__* MCP names; pi shows real pi tool names): ${names}.`);
	}
	lines.push("- Not callable: cursor-replay-* IDs, pi history tool names, and transcript labels.");
	return lines.join("\n");
}
