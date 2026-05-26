import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import { getCursorToolLifecycleLabelKind } from "./cursor-tool-presentation-registry.js";
import { extractWebSearchQuery } from "./cursor-web-tool-activity.js";
import { firstNonEmptyLine, getArray, getString, truncateArg } from "./cursor-transcript-utils.js";
import { classifyCursorToolVisibility } from "./cursor-tool-visibility.js";

/** Defer pending lifecycle lines so fast start+complete pairs coalesce into the completed replay card only. */
export const CURSOR_TOOL_LIFECYCLE_DEFER_MS = 75;

export function isCursorToolLifecycleEligible(toolCall: unknown): boolean {
	return classifyCursorToolVisibility(toolCall).lifecycleEligible;
}

function getCursorToolLifecycleTitle(toolCall: unknown): string {
	const visibility = classifyCursorToolVisibility(toolCall);
	return visibility.lifecycleTitle ?? `Cursor ${visibility.normalizedName}`;
}

/** Prefixes that commonly introduce path/URI values in free-text pending lifecycle details. */
const LIFECYCLE_DETAIL_PATH_PREFIX = String.raw`(?:^|[\s'"({=,:;\[\]{}])`;

function containsCursorLifecycleUnsafeDetail(text: string): boolean {
	if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
	if (/\bwww\.\S+/i.test(text)) return true;
	if (new RegExp(`${LIFECYCLE_DETAIL_PATH_PREFIX}~\\/\\S*`).test(text)) return true;
	if (new RegExp(`${LIFECYCLE_DETAIL_PATH_PREFIX}\\/\\S+`).test(text)) return true;
	if (new RegExp(`${LIFECYCLE_DETAIL_PATH_PREFIX}[A-Za-z]:[\\\\/]`).test(text)) return true;
	return false;
}

function scrubLifecycleDetail(value: string | undefined, apiKey?: string): string | undefined {
	if (!value?.trim()) return undefined;
	const scrubbed = truncateCursorDisplayLine(scrubSensitiveText(value, apiKey));
	if (containsCursorLifecycleUnsafeDetail(scrubbed)) return undefined;
	return scrubbed;
}

export function buildCursorToolLifecycleLabel(toolCall: unknown, apiKey?: string): string | undefined {
	const visibility = classifyCursorToolVisibility(toolCall);
	const args = visibility.args;

	switch (getCursorToolLifecycleLabelKind(visibility.normalizedKey)) {
		case "task": {
			return scrubLifecycleDetail(getString(args, "description"), apiKey) ?? "task";
		}
		case "shell": {
			return "shell";
		}
		case "mcp": {
			return scrubLifecycleDetail(getString(args, "toolName"), apiKey) ?? "mcp";
		}
		case "generateImage": {
			return scrubLifecycleDetail(getString(args, "prompt") ?? getString(args, "description"), apiKey) ?? "image generation";
		}
		case "recordScreen": {
			return scrubLifecycleDetail(getString(args, "mode"), apiKey) ?? "screen recording";
		}
		case "semSearch": {
			return scrubLifecycleDetail(getString(args, "query"), apiKey) ?? "semantic search";
		}
		case "webSearch": {
			return scrubLifecycleDetail(extractWebSearchQuery(args), apiKey) ?? "web search";
		}
		case "webFetch": {
			return "web fetch";
		}
		case "createPlan": {
			const plan = getString(args, "plan");
			return scrubLifecycleDetail(plan ? firstNonEmptyLine(plan) ?? plan : undefined, apiKey) ?? "plan";
		}
		case "updateTodos": {
			const todos = getArray(args, "todos") ?? getArray(args, "items");
			if (todos && todos.length > 0) return truncateArg(`${todos.length} item${todos.length === 1 ? "" : "s"}`);
			return "todos";
		}
		default:
			return undefined;
	}
}

export function formatCursorToolLifecycleProgressText(toolCall: unknown, apiKey?: string): string | undefined {
	const label = buildCursorToolLifecycleLabel(toolCall, apiKey);
	if (!label) return undefined;
	return `${getCursorToolLifecycleTitle(toolCall)}: ${label}\n`;
}
