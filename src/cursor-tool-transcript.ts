import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME, getCursorReplayDisplayLabel } from "./cursor-tool-names.js";
import {
	asRecord,
	formatDisplayPath,
	formatError,
	formatDiffString,
	getNumber,
	getString,
	getToolArgs,
	getToolName,
	getToolResult,
	limitText,
	normalizeResult,
	normalizeToolName,
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
import { resolveCursorEditDiff } from "./cursor-edit-diff.js";

export type { CursorPiToolDisplay } from "./cursor-transcript-utils.js";

export function getCursorCreatePlanText(toolCall: unknown): string | undefined {
	const name = normalizeToolName(getToolName(toolCall));
	if (name !== "createPlan") return undefined;
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));
	const plan = getString(args, "plan") ?? getString(asRecord(result.value), "plan");
	const trimmed = plan?.trim();
	return trimmed || undefined;
}

export function formatCursorToolTranscript(toolCall: unknown, options: TranscriptOptions = {}): string {
	const name = normalizeToolName(getToolName(toolCall));
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));

	switch (name) {
		case "read":
			return formatRead(args, result, options);
		case "shell":
			return formatShell(args, result, options);
		case "ls":
			return formatLs(args, result, options);
		case "glob":
			return formatGlob(args, result, options);
		case "grep":
			return formatGrep(args, result, options);
		case "write":
			return formatWrite(args, result, options);
		case "edit":
			return formatEdit(args, result, options);
		case "delete":
			return formatDelete(args, result, options);
		case "readLints":
			return formatReadLints(args, result, options);
		case "updateTodos":
			return formatTodos(args, result, options, "updateTodos");
		case "createPlan":
			return formatPlan(args, result, options);
		case "task":
			return formatTask(args, result, options);
		case "generateImage":
			return formatGenerateImage(args, result, options);
		case "mcp":
			return formatMcp(args, result, options);
		default:
			return formatFallback(name, args, result, options);
	}
}

function buildGenericPiToolDisplay(name: string, args: Record<string, unknown>, result: NormalizedResult, options: TranscriptOptions): CursorPiToolDisplay {
	const isError = result.status === "error";
	return {
		toolName: name,
		args,
		result: textToolResult(isError ? formatError(result.error) : limitText(stringifyUnknown(result.value), options)),
		isError,
	};
}

export function buildCursorPiToolDisplay(toolCall: unknown, options: TranscriptOptions = {}): CursorPiToolDisplay {
	const rawName = getToolName(toolCall);
	const name = normalizeToolName(rawName);
	const args = getToolArgs(toolCall);
	const result = normalizeResult(getToolResult(toolCall));
	const context = { args, result, options };

	if (name === "read") {
		const isError = result.status === "error";
		return {
			toolName: "read",
			args: buildReadDisplayArgs(args, options),
			result: textToolResult(isError ? formatError(result.error) : formatNativeReadDisplayContent(args, result, options)),
			isError,
		};
	}

	if (name === "shell") {
		const shellOutput = getShellOutput(result, args);
		const isError = result.status === "error" || shellOutput.timedOut || (shellOutput.exitCode !== undefined && shellOutput.exitCode !== 0);
		return {
			toolName: "bash",
			args: buildShellDisplayArgs(args),
			result: textToolResult(result.status === "error" ? formatError(result.error) : limitText(shellOutput.text, options)),
			isError,
		};
	}

	if (name === "grep") {
		const isError = result.status === "error";
		const outputText = isError ? formatError(result.error) : getGrepBody(result, options);
		return {
			toolName: "grep",
			args: buildGrepDisplayArgs(args, options),
			result: textToolResult(outputText),
			isError,
		};
	}

	if (name === "glob") {
		const isError = result.status === "error";
		return {
			toolName: "find",
			args: buildFindDisplayArgs(args, options),
			result: textToolResult(isError ? formatError(result.error) : getGlobBody(result, options)),
			isError,
		};
	}

	if (name === "ls") {
		return {
			toolName: "ls",
			args,
			result: textToolResult(result.status === "error" ? formatError(result.error) : getLsBody(result, options).trim()),
			isError: result.status === "error",
		};
	}

	if (name === "edit") {
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

	if (name === "write") {
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

	const activityDisplay = buildStandardActivityReplayDisplay(name, context);
	if (activityDisplay) return activityDisplay;

	return buildGenericPiToolDisplay(name, args, result, options);
}

export function mergeCursorToolCalls(startedToolCall: unknown, completedToolCall: unknown): unknown {
	const started = asRecord(startedToolCall);
	const completed = asRecord(completedToolCall);
	if (!started) return completedToolCall;
	if (!completed) return startedToolCall;
	return {
		...started,
		...completed,
		name: completed.name ?? started.name,
		type: completed.type ?? started.type,
		args: completed.args ?? started.args,
		input: completed.input ?? started.input,
		result: completed.result ?? started.result,
	};
}
