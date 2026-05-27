import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import type {
	CursorReplayGenerateImageSummaryArgs,
	CursorReplayMcpSummaryArgs,
	CursorReplayPathSummaryArgs,
	CursorReplayPlanSummaryArgs,
	CursorReplayReadLintsSummaryArgs,
	CursorReplayRecordScreenSummaryArgs,
	CursorReplaySemSearchSummaryArgs,
	CursorReplayTaskSummaryArgs,
	CursorReplayTodoSummaryArgs,
	CursorReplayWebFetchSummaryArgs,
	CursorReplayWebSearchSummaryArgs,
} from "./cursor-replay-summary-args.js";
import type { CursorReplayGenerateImageDetailFields } from "./cursor-replay-tool-details.js";
import { asRecord } from "./cursor-record-utils.js";
import {
	firstNonEmptyLine,
	formatDisplayPath,
	getArray,
	getNumber,
	getRecord,
	getString,
	truncateArg,
} from "./cursor-transcript-utils.js";
import { extractWebFetchTarget, extractWebSearchQuery } from "./cursor-web-tool-args.js";

export interface CursorReplayActivityBuildContext {
	args: Record<string, unknown>;
	result: { status: string | undefined; value: unknown; error: unknown };
	options: { cwd?: string };
}

export function buildDeleteReplaySummaryArgs({ args, options }: CursorReplayActivityBuildContext): CursorReplayPathSummaryArgs {
	const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	return displayPath ? { path: displayPath } : {};
}

export function buildDeleteReplayDetailFields({ args, result, options }: CursorReplayActivityBuildContext): {
	path?: string;
	fileSize?: number;
} {
	const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	const value = asRecord(result.value);
	return {
		path: displayPath,
		fileSize: getNumber(value, "fileSize"),
	};
}

export function buildEmptyReplayDetailFields(): Record<string, never> {
	return {};
}

export function buildCollapsedReplayDetailFields(): { collapseDetailsByDefault: true } {
	return { collapseDetailsByDefault: true };
}

export function buildReadLintsReplaySummaryArgs({
	args,
	result,
	options,
}: CursorReplayActivityBuildContext): CursorReplayReadLintsSummaryArgs {
	const paths = getReadLintPaths(args, result, options);
	const diagnosticCount = getReadLintDiagnostics(result, options).length;
	return {
		...(paths.length > 0 ? { paths } : {}),
		...(paths.length === 1 ? { path: paths[0] } : {}),
		...(paths.length > 0 ? { diagnosticCount } : {}),
	};
}

export function buildTodoReplaySummaryArgs(
	args: Record<string, unknown>,
	result: CursorReplayActivityBuildContext["result"],
): CursorReplayTodoSummaryArgs {
	const todos = getTodoItems(args, result);
	const totalCount = getNumber(asRecord(result.value), "totalCount") ?? getNumber(args, "totalCount") ?? todos.length;
	const completedCount = todos.filter((todo) => todo.status === "completed").length;
	const inProgressCount = todos.filter((todo) => todo.status === "inProgress").length;
	const pendingCount = todos.filter((todo) => todo.status === "pending").length;
	return todos.length > 0
		? { totalCount, completedCount, inProgressCount, pendingCount }
		: { totalCount };
}

export function buildCreatePlanReplaySummaryArgs({ args, result }: CursorReplayActivityBuildContext): CursorReplayPlanSummaryArgs {
	const plan = getString(args, "plan") ?? getString(asRecord(result.value) ?? {}, "plan");
	const planTitle = plan ? firstNonEmptyLine(plan) : undefined;
	return {
		...buildTodoReplaySummaryArgs(args, result),
		...(planTitle ? { planTitle: truncateArg(planTitle) } : {}),
	};
}

export function buildTaskReplaySummaryArgs({ args, result }: CursorReplayActivityBuildContext): CursorReplayTaskSummaryArgs {
	const description = getString(args, "description") ?? getString(asRecord(result.value), "description") ?? "task";
	const preview = firstNonEmptyLine(collectTaskText(result));
	return {
		description: truncateArg(description),
		...(preview ? { preview: truncateArg(preview) } : {}),
	};
}

export function buildGenerateImageReplaySummaryArgs({
	args,
	result,
	options,
}: CursorReplayActivityBuildContext): CursorReplayGenerateImageSummaryArgs {
	const prompt = getString(args, "prompt") ?? getString(args, "description") ?? "image";
	const imageDisplayPath = getGenerateImageDisplayPath(args, result, options);
	return {
		prompt: truncateArg(prompt),
		...(imageDisplayPath ? { path: imageDisplayPath } : {}),
	};
}

export function buildMcpReplaySummaryArgs({ args, result }: CursorReplayActivityBuildContext): CursorReplayMcpSummaryArgs {
	const toolName = getString(args, "toolName") ?? "mcp";
	const preview = getMcpResultPreview(result);
	return {
		toolName: truncateArg(toolName),
		...(preview ? { preview } : {}),
	};
}

export function buildSemSearchReplaySummaryArgs({ args }: CursorReplayActivityBuildContext): CursorReplaySemSearchSummaryArgs {
	const query = getString(args, "query") ?? "semantic search";
	const targetDirectories = (getArray(args, "targetDirectories") ?? []).filter((entry): entry is string => typeof entry === "string");
	return {
		query: truncateArg(query),
		...(targetDirectories.length > 0 ? { targetDirectories } : {}),
	};
}

export function buildRecordScreenReplaySummaryArgs({
	args,
	result,
	options,
}: CursorReplayActivityBuildContext): CursorReplayRecordScreenSummaryArgs {
	const mode = getString(args, "mode");
	const value = asRecord(result.value) ?? {};
	const path = getString(value, "path");
	const recordingDurationMs = getNumber(value, "recordingDurationMs");
	return {
		...(mode ? { mode } : {}),
		...(path ? { path: formatDisplayPath(path, options.cwd) } : {}),
		...(recordingDurationMs !== undefined ? { recordingDurationMs } : {}),
	};
}

export function buildWebSearchReplaySummaryArgs({ args }: CursorReplayActivityBuildContext): CursorReplayWebSearchSummaryArgs {
	const query = extractWebSearchQuery(args);
	return query ? { query: truncateArg(query) } : {};
}

export function buildWebFetchReplaySummaryArgs({ args }: CursorReplayActivityBuildContext): CursorReplayWebFetchSummaryArgs {
	const url = extractWebFetchTarget(args);
	return url ? { url: truncateArg(url) } : {};
}

export function buildGenerateImageReplayDetailFields(
	context: CursorReplayActivityBuildContext,
	contentText: string,
): CursorReplayGenerateImageDetailFields {
	const { args, result, options } = context;
	const imagePath = getGenerateImagePath(args, result);
	const imageDisplayPath = getGenerateImageDisplayPath(args, result, options);
	return {
		imagePath,
		imageDisplayPath,
		imageMimeType: inferImageMimeType(imagePath),
		expandedText: contentText,
	};
}

function getReadLintPaths(args: Record<string, unknown>, result: CursorReplayActivityBuildContext["result"], options: CursorReplayActivityBuildContext["options"]): string[] {
	const explicitPaths = Array.isArray(args.paths)
		? args.paths.filter((entry): entry is string => typeof entry === "string")
		: typeof args.path === "string"
			? [args.path]
			: [];
	const resultPaths = (getArray(asRecord(result.value), "fileDiagnostics") ?? [])
		.map((file) => getString(asRecord(file), "path"))
		.filter((entry): entry is string => Boolean(entry));
	return [...new Set([...explicitPaths, ...resultPaths].map((entry) => formatDisplayPath(entry, options.cwd)))];
}

function getReadLintDiagnostics(result: CursorReplayActivityBuildContext["result"], options: CursorReplayActivityBuildContext["options"]): string[] {
	const value = asRecord(result.value);
	const files = getArray(value, "fileDiagnostics") ?? [];
	const lines: string[] = [];
	for (const file of files) {
		const fileRecord = asRecord(file);
		const pathValue = getString(fileRecord, "path");
		const path = pathValue ? formatDisplayPath(pathValue, options.cwd) : "unknown";
		const diagnostics = getArray(fileRecord, "diagnostics") ?? [];
		for (const diagnostic of diagnostics) {
			const diagnosticRecord = asRecord(diagnostic);
			const severity = getString(diagnosticRecord, "severity") ?? "diagnostic";
			const message = getString(diagnosticRecord, "message") ?? "";
			const source = getString(diagnosticRecord, "source");
			lines.push(`${path}: ${severity}${source ? ` ${source}` : ""}: ${message}`);
		}
	}
	return lines;
}

function getTodoItems(args: Record<string, unknown>, result: CursorReplayActivityBuildContext["result"]): Array<{ content: string; status?: string }> {
	const value = asRecord(result.value);
	const rawTodos = getArray(value, "todos") ?? getArray(args, "todos") ?? [];
	const todos: Array<{ content: string; status?: string }> = [];
	for (const todo of rawTodos) {
		const record = asRecord(todo);
		const content = getString(record, "content");
		if (!content) continue;
		const status = getString(record, "status");
		todos.push(status ? { content, status } : { content });
	}
	return todos;
}

function collectTaskText(result: CursorReplayActivityBuildContext["result"]): string {
	const value = asRecord(result.value);
	const success = getRecord(getRecord(value, "result"), "success");
	const command = getString(success, "command");
	const stdout = getString(success, "stdout");
	const interleavedOutput = getString(success, "interleavedOutput");
	const assistantMessages = (getArray(value, "conversationSteps") ?? [])
		.map((step) => getString(getRecord(asRecord(step), "assistantMessage"), "text"))
		.filter((entry): entry is string => Boolean(entry));
	const parts = [command ? `$ ${command}` : undefined, stdout || interleavedOutput, ...assistantMessages].filter((part): part is string => Boolean(part));
	return parts.join("\n");
}

function getGenerateImagePath(args: Record<string, unknown>, result: CursorReplayActivityBuildContext["result"]): string | undefined {
	const value = asRecord(result.value);
	return getString(value, "filePath") ?? getString(args, "filePath") ?? getString(args, "path");
}

function getGenerateImageDisplayPath(args: Record<string, unknown>, result: CursorReplayActivityBuildContext["result"], options: CursorReplayActivityBuildContext["options"]): string | undefined {
	const path = getGenerateImagePath(args, result);
	return path ? formatDisplayPath(path, options.cwd) : undefined;
}

function inferImageMimeType(path: string | undefined): string | undefined {
	const lower = path?.toLowerCase();
	if (!lower) return undefined;
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	return undefined;
}

function getMcpContentText(entry: unknown): string | undefined {
	const record = asRecord(entry);
	const directText = getString(record, "text");
	if (directText) return directText;
	const nestedText = getRecord(record, "text");
	return getString(nestedText, "text");
}

function getMcpResultPreview(result: CursorReplayActivityBuildContext["result"]): string | undefined {
	if (result.status === "error") return undefined;
	const value = asRecord(result.value);
	const content = getArray(value, "content") ?? [];
	for (const entry of content) {
		const text = getMcpContentText(entry);
		if (text) {
			const line = firstNonEmptyLine(text);
			if (line) return truncateArg(scrubSensitiveText(line), 120);
		}
	}
	return undefined;
}
