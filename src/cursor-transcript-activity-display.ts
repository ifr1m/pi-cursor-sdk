import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME, getCursorReplayDisplayLabel, type CursorReplayLegacyToolName } from "./cursor-tool-names.js";
import {
	asRecord,
	firstNonEmptyLine,
	formatDisplayPath,
	formatError,
	getNumber,
	getString,
	truncateArg,
	type CursorPiToolDisplay,
	type NormalizedResult,
	type PiToolDisplayResult,
	type TranscriptOptions,
} from "./cursor-transcript-utils.js";
import {
	collectTaskText,
	formatDelete,
	formatGenerateImage,
	formatMcp,
	formatPlan,
	formatReadLints,
	formatTask,
	formatTodos,
	getGenerateImageDisplayPath,
	getGenerateImagePath,
	getReadLintDiagnostics,
	getReadLintPaths,
	getTaskDescription,
	getTodoItems,
	getTodoTotalCount,
	inferImageMimeType,
	summarizePlan,
	summarizeTask,
	summarizeTodos,
} from "./cursor-transcript-tool-formatters.js";
interface ActivityReplayContext {
	args: Record<string, unknown>;
	result: NormalizedResult;
	options: TranscriptOptions;
}

interface ActivityReplaySpec {
	labelKey: CursorReplayLegacyToolName;
	format: (context: ActivityReplayContext) => string;
	buildActivityArgs: (context: ActivityReplayContext) => Record<string, unknown>;
	buildActivitySummary: (context: ActivityReplayContext) => string | undefined;
	buildDetails: (context: ActivityReplayContext, contentText: string) => Record<string, unknown>;
}

function textToolResult(text: string, details?: unknown): PiToolDisplayResult {
	return { content: [{ type: "text", text }], details };
}

function buildCursorActivityDisplayArgs(
	args: Record<string, unknown>,
	activityTitle: string,
	activitySummary: string | undefined,
): Record<string, unknown> {
	const trimmedSummary = activitySummary?.trim();
	return {
		...args,
		activityTitle,
		...(trimmedSummary ? { activitySummary: trimmedSummary } : {}),
	};
}

function buildReplaySummaryDisplay(
	toolName: string,
	args: Record<string, unknown>,
	result: NormalizedResult,
	contentText: string,
	details: Record<string, unknown>,
): CursorPiToolDisplay {
	const isError = result.status === "error";
	const summary = isError ? formatError(result.error) : firstNonEmptyLine(contentText);
	return {
		toolName,
		args,
		result: textToolResult(contentText, {
			...details,
			summary: details.summary ?? summary,
			expandedText: details.expandedText ?? contentText,
		}),
		isError,
	};
}

function buildActivityReplayDisplay(
	cursorToolName: string,
	spec: ActivityReplaySpec,
	context: ActivityReplayContext,
): CursorPiToolDisplay {
	const activityTitle = getCursorReplayDisplayLabel(spec.labelKey);
	const activitySummary = spec.buildActivitySummary(context);
	const activityArgs = buildCursorActivityDisplayArgs(
		spec.buildActivityArgs(context),
		activityTitle,
		activitySummary,
	);
	const contentText = spec.format(context).trimEnd();
	const details = spec.buildDetails(context, contentText);
	return buildReplaySummaryDisplay(
		CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
		activityArgs,
		context.result,
		contentText,
		{
			cursorToolName,
			title: activityTitle,
			summary: context.result.status === "error" ? undefined : details.summary ?? activitySummary,
			...details,
		},
	);
}

const ACTIVITY_REPLAY_SPECS: Record<string, ActivityReplaySpec> = {
	delete: {
		labelKey: "cursor_delete",
		format: ({ args, result, options }) => formatDelete(args, result, options),
		buildActivityArgs: ({ args, options }) => {
			const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
			return displayPath ? { path: displayPath } : {};
		},
		buildActivitySummary: ({ args, options }) => {
			const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
			return displayPath ?? "file";
		},
		buildDetails: ({ args, result, options }) => {
			const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
			const value = asRecord(result.value);
			return {
				path: displayPath,
				fileSize: getNumber(value, "fileSize"),
				summary: result.status === "error" ? undefined : displayPath ? `deleted ${displayPath}` : "deleted file",
			};
		},
	},
	readLints: {
		labelKey: "cursor_read_lints",
		format: ({ args, result, options }) => formatReadLints(args, result, options),
		buildActivityArgs: ({ args, result, options }) => {
			const paths = getReadLintPaths(args, result, options);
			const diagnosticCount = getReadLintDiagnostics(result, options).length;
			return { paths, diagnosticCount };
		},
		buildActivitySummary: ({ args, result, options }) => {
			const paths = getReadLintPaths(args, result, options);
			const diagnosticCount = getReadLintDiagnostics(result, options).length;
			return `${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}${paths.length > 0 ? ` in ${paths.join(", ")}` : ""}`;
		},
		buildDetails: () => ({}),
	},
	updateTodos: {
		labelKey: "cursor_update_todos",
		format: ({ args, result, options }) => formatTodos(args, result, options, "updateTodos"),
		buildActivityArgs: ({ args, result }) => {
			const todos = getTodoItems(args, result);
			return { totalCount: getTodoTotalCount(args, result, todos) };
		},
		buildActivitySummary: ({ args, result }) => summarizeTodos(args, result),
		buildDetails: () => ({}),
	},
	createPlan: {
		labelKey: "cursor_create_plan",
		format: ({ args, result, options }) => formatPlan(args, result, options),
		buildActivityArgs: ({ args, result }) => {
			const todos = getTodoItems(args, result);
			return { totalCount: getTodoTotalCount(args, result, todos) };
		},
		buildActivitySummary: ({ args, result }) => summarizePlan(args, result),
		buildDetails: () => ({}),
	},
	task: {
		labelKey: "cursor_task",
		format: ({ args, result, options }) => formatTask(args, result, options),
		buildActivityArgs: ({ args, result }) => {
			const description = getTaskDescription(args, result);
			return { description: truncateArg(description) };
		},
		buildActivitySummary: ({ args, result }) => {
			const description = getTaskDescription(args, result);
			return summarizeTask(description, collectTaskText(result));
		},
		buildDetails: () => ({}),
	},
	generateImage: {
		labelKey: "cursor_generate_image",
		format: ({ args, result, options }) => formatGenerateImage(args, result, options),
		buildActivityArgs: ({ args }) => {
			const prompt = getString(args, "prompt") ?? getString(args, "description") ?? "image";
			return { prompt: truncateArg(prompt) };
		},
		buildActivitySummary: ({ args, result, options }) => {
			const prompt = getString(args, "prompt") ?? getString(args, "description") ?? "image";
			const imageDisplayPath = getGenerateImageDisplayPath(args, result, options);
			return imageDisplayPath ?? truncateArg(prompt);
		},
		buildDetails: ({ args, result, options }, contentText) => {
			const imagePath = getGenerateImagePath(args, result);
			const imageDisplayPath = getGenerateImageDisplayPath(args, result, options);
			return {
				imagePath,
				imageDisplayPath,
				imageMimeType: inferImageMimeType(imagePath),
				summary: result.status === "error" ? undefined : imageDisplayPath ? `saved ${imageDisplayPath}` : "image generated",
				expandedText: contentText,
			};
		},
	},
	mcp: {
		labelKey: "cursor_mcp",
		format: ({ args, result, options }) => formatMcp(args, result, options),
		buildActivityArgs: ({ args }) => {
			const toolName = getString(args, "toolName") ?? "mcp";
			return { toolName: truncateArg(toolName) };
		},
		buildActivitySummary: ({ args }) => truncateArg(getString(args, "toolName") ?? "mcp"),
		buildDetails: ({ result }, contentText) => ({
			summary: result.status === "error" ? undefined : firstNonEmptyLine(contentText) ?? "MCP result captured",
		}),
	},
};

export function buildStandardActivityReplayDisplay(
	toolName: string,
	context: ActivityReplayContext,
): CursorPiToolDisplay | undefined {
	const spec = ACTIVITY_REPLAY_SPECS[toolName];
	if (!spec) return undefined;
	return buildActivityReplayDisplay(toolName, spec, context);
}

export { buildCursorActivityDisplayArgs, buildReplaySummaryDisplay, textToolResult };
