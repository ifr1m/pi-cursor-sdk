import type { Context, Message, ToolCall } from "@earendil-works/pi-ai";
import type { SDKImage } from "@cursor/sdk";

export interface CursorPrompt {
	text: string;
	images: SDKImage[];
}

function isTextBlock(block: { type: string }): block is { type: "text"; text: string } {
	return block.type === "text";
}

function isImageBlock(block: { type: string }): block is { type: "image"; data: string; mimeType: string } {
	return block.type === "image";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function extractLatestImages(messages: Message[]): SDKImage[] {
	// Find the last user message and extract images only from it
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") return [];

		const images: SDKImage[] = [];
		for (const block of msg.content) {
			if (isImageBlock(block) && block.data && block.mimeType) {
				images.push({ data: block.data, mimeType: block.mimeType });
			}
		}
		return images;
	}
	return [];
}

function formatContentBlocks(content: string | { type: string; text?: string; data?: string; mimeType?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (isTextBlock(block)) return block.text;
			if (isImageBlock(block)) return "[image omitted from transcript]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function formatToolCall(toolCall: ToolCall): string {
	const args = JSON.stringify(toolCall.arguments);
	return `Tool call (${toolCall.name}, call ${toolCall.id}): ${args}`;
}

export function buildCursorPrompt(context: Context): CursorPrompt {
	const parts: string[] = [];

	if (context.systemPrompt) {
		parts.push(`System instructions from pi:\n${context.systemPrompt}`);
	}

	for (const msg of context.messages) {
		switch (msg.role) {
			case "user": {
				const text = formatContentBlocks(msg.content);
				if (text) parts.push(`User: ${text}`);
				break;
			}
			case "assistant": {
				const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: String(msg.content) }];
				const textParts: string[] = [];
				for (const block of blocks) {
					if (isTextBlock(block)) {
						textParts.push(block.text);
					} else if (isToolCallBlock(block)) {
						textParts.push(formatToolCall(block));
					}
					// Omit thinking content from transcript
				}
				if (textParts.length > 0) {
					parts.push(`Assistant: ${textParts.join("\n")}`);
				}
				break;
			}
			case "toolResult": {
				const text = formatContentBlocks(msg.content);
				const label = msg.isError ? "Tool error" : "Tool result";
				parts.push(`${label} (${msg.toolName}, call ${msg.toolCallId}): ${text}`);
				break;
			}
		}
	}

	parts.push("Answer the latest user request above using your capabilities. Do not assume access to pi tools.");

	const images = extractLatestImages(context.messages);

	return { text: parts.join("\n\n"), images };
}
