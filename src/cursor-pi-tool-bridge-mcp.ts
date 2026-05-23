import { createHash } from "node:crypto";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildCursorPiBridgeMcpToolDescription, CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX } from "./cursor-bridge-contract.js";
import type { CursorPiBridgeToolDefinition, CursorPiMcpInputSchema } from "./cursor-pi-tool-bridge-types.js";
import { getFirstStringByKeys } from "./cursor-record-utils.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function normalizeMcpInputSchema(schema: unknown): CursorPiMcpInputSchema {
	if (isRecord(schema) && schema.type === "object") return schema as CursorPiMcpInputSchema;
	return { type: "object", properties: {} };
}

export function normalizeMcpArgs(args: unknown): Record<string, unknown> {
	return isRecord(args) ? { ...args } : {};
}

export function waitForProtocolFlush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function sanitizeMcpToolNameStem(toolName: string): string {
	const stem = toolName
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return stem || "tool";
}

export function stableNameHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function createMcpToolName(piToolName: string, usedMcpToolNames: Set<string>): string {
	const baseName = `${CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX}${sanitizeMcpToolNameStem(piToolName)}`;
	if (!usedMcpToolNames.has(baseName)) {
		usedMcpToolNames.add(baseName);
		return baseName;
	}

	const hashedName = `${baseName}__${stableNameHash(piToolName)}`;
	if (!usedMcpToolNames.has(hashedName)) {
		usedMcpToolNames.add(hashedName);
		return hashedName;
	}

	let counter = 2;
	let candidate = `${hashedName}_${counter}`;
	while (usedMcpToolNames.has(candidate)) {
		counter += 1;
		candidate = `${hashedName}_${counter}`;
	}
	usedMcpToolNames.add(candidate);
	return candidate;
}

export function snapshotToolToMcpTool(tool: CursorPiBridgeToolDefinition): Tool {
	return {
		name: tool.mcpToolName,
		description: buildCursorPiBridgeMcpToolDescription({
			piToolName: tool.piToolName,
			mcpToolName: tool.mcpToolName,
			piToolDescription: tool.description,
		}),
		inputSchema: tool.inputSchema,
		_meta: { piToolName: tool.piToolName },
	};
}

export function convertPiContentToMcpContent(content: unknown): CallToolResult["content"] {
	if (!Array.isArray(content)) {
		return [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }];
	}

	const mcpContent: CallToolResult["content"] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			mcpContent.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			mcpContent.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		mcpContent.push({ type: "text", text: JSON.stringify(block) });
	}

	return mcpContent.length > 0 ? mcpContent : [{ type: "text", text: "" }];
}

export function asToolResultMessage(value: Context["messages"][number]): ToolResultMessage | undefined {
	return value.role === "toolResult" ? value : undefined;
}

export function getStringField(record: Record<string, unknown>, fields: string[]): string | undefined {
	return getFirstStringByKeys(record, fields, { nonEmpty: true });
}

export function containsKnownMcpToolName(value: unknown, knownMcpToolNames: ReadonlySet<string>, depth = 0): boolean {
	if (depth > 4) return false;
	if (Array.isArray(value)) return value.some((entry) => containsKnownMcpToolName(entry, knownMcpToolNames, depth + 1));
	if (!isRecord(value)) return false;

	for (const field of ["tool", "toolName", "name", "mcpToolName", "serverToolName"]) {
		const fieldValue = value[field];
		if (typeof fieldValue === "string" && knownMcpToolNames.has(fieldValue)) return true;
	}

	for (const nestedField of ["args", "arguments", "input"]) {
		if (containsKnownMcpToolName(value[nestedField], knownMcpToolNames, depth + 1)) return true;
	}

	return false;
}
