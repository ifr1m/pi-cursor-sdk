import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME, getCursorReplayDisplayLabel } from "./cursor-tool-names.js";
import { resolveCursorEditDiff } from "./cursor-edit-diff.js";
import {
	asRecord,
	formatDisplayPath,
	formatDiffString,
	formatError,
	getNumber,
	getString,
	limitText,
	stringifyUnknown,
	type CursorPiToolDisplay,
	type NormalizedResult,
	type TranscriptOptions,
} from "./cursor-transcript-utils.js";
import {
	buildCursorActivityDisplayArgs,
	buildReplaySummaryDisplay,
	buildStandardActivityReplayDisplay,
	textToolResult,
} from "./cursor-transcript-activity-display.js";
import {
	buildCursorEditActivityDisplayArgs,
	buildFindDisplayArgs,
	buildGrepDisplayArgs,
	buildNativeEditDisplayArgs,
	buildReadDisplayArgs,
	buildShellDisplayArgs,
	buildWriteDisplayArgs,
	formatDelete,
	formatEdit,
	formatFallback,
	formatGenerateImage,
	formatGlob,
	formatGrep,
	formatLs,
	formatMcp,
	formatPlan,
	formatRead,
	formatReadLints,
	formatShell,
	formatTask,
	formatTodos,
	formatWrite,
	formatNativeReadDisplayContent,
	getCursorWriteArgContent,
	getGlobBody,
	getGrepBody,
	getLsBody,
	getShellOutput,
} from "./cursor-transcript-tool-formatters.js";

export interface ToolDisplayContext {
	rawName: string;
	name: string;
	args: Record<string, unknown>;
	result: NormalizedResult;
	options: TranscriptOptions;
}

interface ToolDisplaySpec {
	formatTranscript: (context: ToolDisplayContext) => string;
	buildPiToolDisplay: (context: ToolDisplayContext) => CursorPiToolDisplay;
}

function buildGenericPiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { name, args, result, options } = context;
	const isError = result.status === "error";
	return {
		toolName: name,
		args,
		result: textToolResult(isError ? formatError(result.error) : limitText(stringifyUnknown(result.value), options)),
		isError,
	};
}

function buildEditPiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { rawName, args, result, options } = context;
	const value = asRecord(result.value);
	const rawDiff = resolveCursorEditDiff(value);
	const normalizedDiff = formatDiffString(rawDiff, options);
	const nativeEditArgs = buildNativeEditDisplayArgs(rawName, args, options);
	const baseActivityArgs = buildCursorEditActivityDisplayArgs(args, options);
	const displayPath = typeof baseActivityArgs.path === "string" ? baseActivityArgs.path : undefined;
	const activityTitle = getCursorReplayDisplayLabel("cursor_edit");
	const activityArgs = buildCursorActivityDisplayArgs(baseActivityArgs, activityTitle, displayPath);
	const contentText = formatEdit(activityArgs, result, options);
	const details = {
		cursorToolName: "edit",
		path: displayPath,
		linesAdded: getNumber(value, "linesAdded"),
		linesRemoved: getNumber(value, "linesRemoved"),
		diffString: normalizedDiff,
		diff: normalizedDiff,
		firstChangedLine: getNumber(value, "firstChangedLine"),
	};
	if (nativeEditArgs) {
		return {
			toolName: "edit",
			args: nativeEditArgs,
			result: textToolResult(contentText, details),
			isError: result.status === "error",
		};
	}
	return buildReplaySummaryDisplay(
		CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
		activityArgs,
		result,
		contentText.trimEnd(),
		{
			...details,
			title: activityTitle,
			summary: result.status === "error" ? undefined : displayPath ?? "replayed",
		},
	);
}

function buildWritePiToolDisplay(context: ToolDisplayContext): CursorPiToolDisplay {
	const { args, result, options } = context;
	const value = asRecord(result.value);
	const content = getCursorWriteArgContent(args);
	const displayArgs = buildWriteDisplayArgs(args, options);
	const displayPath = typeof args.path === "string" ? formatDisplayPath(args.path, options.cwd) : undefined;
	const contentText = formatWrite(args, result, options).trimEnd();
	const details = {
		cursorToolName: "write",
		path: displayPath,
		linesCreated: getNumber(value, "linesCreated"),
		fileSize: getNumber(value, "fileSize"),
		fileContentAfterWrite: getString(value, "fileContentAfterWrite"),
		expandedText: contentText,
	};
	if (content === undefined) {
		const activityTitle = getCursorReplayDisplayLabel("cursor_write");
		return buildReplaySummaryDisplay(
			CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			buildCursorActivityDisplayArgs(displayArgs, activityTitle, displayPath ?? "file"),
			result,
			contentText,
			{
				...details,
				title: activityTitle,
				summary: result.status === "error" ? undefined : displayPath ?? "wrote file",
			},
		);
	}
	return {
		toolName: "write",
		args: displayArgs,
		result: textToolResult(contentText, details),
		isError: result.status === "error",
	};
}

const TOOL_DISPLAY_SPECS: Record<string, ToolDisplaySpec> = {
	read: {
		formatTranscript: ({ args, result, options }) => formatRead(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const isError = result.status === "error";
			return {
				toolName: "read",
				args: buildReadDisplayArgs(args, options),
				result: textToolResult(isError ? formatError(result.error) : formatNativeReadDisplayContent(args, result, options)),
				isError,
			};
		},
	},
	shell: {
		formatTranscript: ({ args, result, options }) => formatShell(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const shellOutput = getShellOutput(result, args);
			const isError = result.status === "error" || shellOutput.timedOut || (shellOutput.exitCode !== undefined && shellOutput.exitCode !== 0);
			return {
				toolName: "bash",
				args: buildShellDisplayArgs(args),
				result: textToolResult(result.status === "error" ? formatError(result.error) : limitText(shellOutput.text, options)),
				isError,
			};
		},
	},
	grep: {
		formatTranscript: ({ args, result, options }) => formatGrep(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const isError = result.status === "error";
			return {
				toolName: "grep",
				args: buildGrepDisplayArgs(args, options),
				result: textToolResult(isError ? formatError(result.error) : getGrepBody(result, options)),
				isError,
			};
		},
	},
	glob: {
		formatTranscript: ({ args, result, options }) => formatGlob(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => {
			const isError = result.status === "error";
			return {
				toolName: "find",
				args: buildFindDisplayArgs(args, options),
				result: textToolResult(isError ? formatError(result.error) : getGlobBody(result, options)),
				isError,
			};
		},
	},
	ls: {
		formatTranscript: ({ args, result, options }) => formatLs(args, result, options),
		buildPiToolDisplay: ({ args, result, options }) => ({
			toolName: "ls",
			args,
			result: textToolResult(result.status === "error" ? formatError(result.error) : getLsBody(result, options).trim()),
			isError: result.status === "error",
		}),
	},
	edit: {
		formatTranscript: ({ args, result, options }) => formatEdit(args, result, options),
		buildPiToolDisplay: buildEditPiToolDisplay,
	},
	write: {
		formatTranscript: ({ args, result, options }) => formatWrite(args, result, options),
		buildPiToolDisplay: buildWritePiToolDisplay,
	},
	delete: {
		formatTranscript: ({ args, result, options }) => formatDelete(args, result, options),
		buildPiToolDisplay: (context) => buildStandardActivityReplayDisplay("delete", context) ?? buildGenericPiToolDisplay(context),
	},
	readLints: {
		formatTranscript: ({ args, result, options }) => formatReadLints(args, result, options),
		buildPiToolDisplay: (context) => buildStandardActivityReplayDisplay("readLints", context) ?? buildGenericPiToolDisplay(context),
	},
	updateTodos: {
		formatTranscript: ({ args, result, options }) => formatTodos(args, result, options, "updateTodos"),
		buildPiToolDisplay: (context) => buildStandardActivityReplayDisplay("updateTodos", context) ?? buildGenericPiToolDisplay(context),
	},
	createPlan: {
		formatTranscript: ({ args, result, options }) => formatPlan(args, result, options),
		buildPiToolDisplay: (context) => buildStandardActivityReplayDisplay("createPlan", context) ?? buildGenericPiToolDisplay(context),
	},
	task: {
		formatTranscript: ({ args, result, options }) => formatTask(args, result, options),
		buildPiToolDisplay: (context) => buildStandardActivityReplayDisplay("task", context) ?? buildGenericPiToolDisplay(context),
	},
	generateImage: {
		formatTranscript: ({ args, result, options }) => formatGenerateImage(args, result, options),
		buildPiToolDisplay: (context) => buildStandardActivityReplayDisplay("generateImage", context) ?? buildGenericPiToolDisplay(context),
	},
	mcp: {
		formatTranscript: ({ args, result, options }) => formatMcp(args, result, options),
		buildPiToolDisplay: (context) => buildStandardActivityReplayDisplay("mcp", context) ?? buildGenericPiToolDisplay(context),
	},
};

export function formatCursorToolTranscriptFromSpec(context: ToolDisplayContext): string {
	const spec = TOOL_DISPLAY_SPECS[context.name];
	if (spec) return spec.formatTranscript(context);
	return formatFallback(context.name, context.args, context.result, context.options);
}

export function buildCursorPiToolDisplayFromSpec(context: ToolDisplayContext): CursorPiToolDisplay {
	const spec = TOOL_DISPLAY_SPECS[context.name];
	if (spec) return spec.buildPiToolDisplay(context);
	return buildGenericPiToolDisplay(context);
}
