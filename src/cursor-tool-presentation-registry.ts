/**
 * Canonical Cursor tool presentation metadata.
 * Names, labels, visibility, replay, lifecycle, web remapping, and alias normalization
 * derive from this registry — do not duplicate tool lists in sibling modules.
 */

import {
	formatReplaySemSearchQuery,
	readCursorReplaySummaryString,
	summarizeReplayGenericActivity,
	summarizeReplayMcp,
	summarizeReplayPath,
	summarizeReplayPlan,
	summarizeReplayReadLints,
	summarizeReplayRecordScreen,
	summarizeReplayTask,
	summarizeReplayTodoCount,
	withActivitySummaryFallback,
	type CursorReplayActivitySummaryOverride,
	type CursorReplayGenerateImageSummaryArgs,
	type CursorReplayPathSummaryArgs,
	type CursorReplayPlanSummaryArgs,
	type CursorReplayReadLintsSummaryArgs,
	type CursorReplayRecordScreenSummaryArgs,
	type CursorReplaySemSearchSummaryArgs,
	type CursorReplaySummaryArgs,
	type CursorReplayTaskSummaryArgs,
	type CursorReplayTodoSummaryArgs,
	type CursorReplayWebFetchSummaryArgs,
	type CursorReplayWebSearchSummaryArgs,
} from "./cursor-replay-summary-args.js";
import {
	buildCollapsedReplayDetailFields,
	buildCreatePlanReplaySummaryArgs,
	buildDeleteReplayDetailFields,
	buildDeleteReplaySummaryArgs,
	buildEmptyReplayDetailFields,
	buildGenerateImageReplayDetailFields,
	buildGenerateImageReplaySummaryArgs,
	buildMcpReplaySummaryArgs,
	buildReadLintsReplaySummaryArgs,
	buildRecordScreenReplaySummaryArgs,
	buildSemSearchReplaySummaryArgs,
	buildTaskReplaySummaryArgs,
	buildTodoReplaySummaryArgs,
	buildWebFetchReplaySummaryArgs,
	buildWebSearchReplaySummaryArgs,
	type CursorReplayActivityBuildContext,
} from "./cursor-replay-activity-builders.js";
import { CURSOR_REPLAY_SOURCE_TOOL_NAMES, type CursorReplaySourceToolName } from "./cursor-replay-source-names.js";
import type {
	CursorReplayActivityDetailFields,
	CursorReplayGenerateImageDetailFields,
} from "./cursor-replay-tool-details.js";

export const CURSOR_REPLAY_ACTIVITY_TOOL_NAME = "cursor" as const;

export type CursorWebToolKind = "webSearch" | "webFetch";

export type CursorReplaySideEffectCategory = "file_mutations" | "real_tool_work";

export type CursorToolLifecycleLabelKind =
	| "task"
	| "shell"
	| "mcp"
	| "generateImage"
	| "recordScreen"
	| "semSearch"
	| "webSearch"
	| "webFetch"
	| "createPlan"
	| "updateTodos";

export type CursorReplayCallSummaryBuilder<T extends CursorReplayActivitySummaryOverride = CursorReplaySummaryArgs> = (
	args: T | undefined,
) => string | undefined;

export interface CursorToolVisibilityPolicy {
	incompleteTitle?: string;
	lifecycleTitle?: string;
	lifecycleEligible?: boolean;
	fastLocalDiscovery?: boolean;
}

export interface CursorToolActivityReplaySpec<TArgs extends CursorReplaySummaryArgs = CursorReplaySummaryArgs> {
	buildActivityArgs: (context: CursorReplayActivityBuildContext) => TArgs;
	buildDetails: (context: CursorReplayActivityBuildContext, contentText: string) => CursorReplayActivityDetailFields;
}

export interface CursorToolGenerateImageReplaySpec {
	buildActivityArgs: (context: CursorReplayActivityBuildContext) => CursorReplayGenerateImageSummaryArgs;
	buildDetails: (context: CursorReplayActivityBuildContext, contentText: string) => CursorReplayGenerateImageDetailFields;
}

export interface CursorToolPresentationSpec {
	normalizedName: CursorReplaySourceToolName;
	/** Raw SDK/host names that resolve to this tool via {@link normalizeCursorToolName}. */
	nameAliases?: readonly string[];
	replayLegacyName?: string;
	/** Human-readable SDK operation label for replay-only tool descriptions when it differs from {@link normalizedName}. */
	replayOperationLabel?: string;
	promptLabel: string;
	displayLabel: string;
	visibility: CursorToolVisibilityPolicy;
	webKind?: CursorWebToolKind;
	/** Regexes matched against lowercased trimmed tool names for {@link classifyCursorWebToolKind}. */
	webNamePatterns?: readonly RegExp[];
	lifecycleLabelKind?: CursorToolLifecycleLabelKind;
	replayCallSummary?: CursorReplayCallSummaryBuilder;
	/** Short label for replay-only tool definitions (for example `edit` for `cursor_edit`). */
	replayWrapperLabel?: string;
	/** Whether replay-only wrappers describe file mutations or other recorded tool work. */
	replaySideEffectCategory?: CursorReplaySideEffectCategory;
	activityReplay?: CursorToolActivityReplaySpec;
	generateImageReplay?: CursorToolGenerateImageReplaySpec;
}

const WEB_SEARCH_NAME_PATTERN =
	/^(?:web[-_ ]?search|search[-_ ]?web|websearch|browser[-_ ]?search|cursor[-_ ]?web[-_ ]?search)$/i;
const WEB_FETCH_NAME_PATTERN =
	/^(?:web[-_ ]?fetch|fetch[-_ ]?web|webfetch|browser[-_ ]?fetch|fetch[-_ ]?url|cursor[-_ ]?web[-_ ]?fetch)$/i;

export const CURSOR_TOOL_PRESENTATION_SPECS = [
	{
		normalizedName: "read",
		nameAliases: ["read_file"],
		promptLabel: "read",
		displayLabel: "read",
		visibility: { incompleteTitle: "Cursor read", fastLocalDiscovery: true },
	},
	{
		normalizedName: "grep",
		nameAliases: ["grep_search", "search"],
		promptLabel: "grep",
		displayLabel: "grep",
		visibility: { incompleteTitle: "Cursor grep", fastLocalDiscovery: true },
	},
	{
		normalizedName: "glob",
		nameAliases: ["file_search"],
		promptLabel: "glob",
		displayLabel: "glob",
		visibility: { incompleteTitle: "Cursor find", fastLocalDiscovery: true },
	},
	{
		normalizedName: "ls",
		nameAliases: ["list_dir"],
		promptLabel: "ls",
		displayLabel: "ls",
		visibility: { incompleteTitle: "Cursor ls", fastLocalDiscovery: true },
	},
	{
		normalizedName: "shell",
		nameAliases: ["run_terminal_cmd", "terminal", "bash"],
		promptLabel: "shell",
		displayLabel: "shell",
		visibility: {
			incompleteTitle: "Cursor shell",
			lifecycleTitle: "Cursor shell",
			lifecycleEligible: true,
		},
		lifecycleLabelKind: "shell",
	},
	{
		normalizedName: "edit",
		nameAliases: [
			"strreplace",
			"str_replace",
			"str-replace",
			"edit_file",
			"editfile",
			"edit_notebook",
			"editnotebook",
			"notebook_edit",
			"notebookedit",
		],
		replayLegacyName: "cursor_edit",
		promptLabel: "Cursor edit",
		displayLabel: "Cursor edit",
		visibility: {},
		replayWrapperLabel: "edit",
		replaySideEffectCategory: "file_mutations",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPath),
	},
	{
		normalizedName: "write",
		nameAliases: ["write_file", "writefile"],
		replayLegacyName: "cursor_write",
		promptLabel: "Cursor write",
		displayLabel: "Cursor write",
		visibility: {},
		replayWrapperLabel: "write",
		replaySideEffectCategory: "file_mutations",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPath),
	},
	{
		normalizedName: "delete",
		replayLegacyName: "cursor_delete",
		promptLabel: "Cursor delete",
		displayLabel: "Cursor delete",
		visibility: {},
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPath),
		activityReplay: {
			buildActivityArgs: buildDeleteReplaySummaryArgs,
			buildDetails: buildDeleteReplayDetailFields,
		},
	},
	{
		normalizedName: "readLints",
		replayLegacyName: "cursor_read_lints",
		promptLabel: "Cursor diagnostics",
		displayLabel: "Cursor diagnostics",
		visibility: {},
		replayCallSummary: withActivitySummaryFallback(summarizeReplayReadLints),
		activityReplay: {
			buildActivityArgs: buildReadLintsReplaySummaryArgs,
			buildDetails: buildEmptyReplayDetailFields,
		},
	},
	{
		normalizedName: "updateTodos",
		replayLegacyName: "cursor_update_todos",
		promptLabel: "Cursor todos",
		displayLabel: "Cursor todos",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "updateTodos",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayTodoCount),
		activityReplay: {
			buildActivityArgs: ({ args, result }) => buildTodoReplaySummaryArgs(args, result),
			buildDetails: buildEmptyReplayDetailFields,
		},
	},
	{
		normalizedName: "createPlan",
		replayLegacyName: "cursor_create_plan",
		promptLabel: "Cursor plan",
		displayLabel: "Cursor plan",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "createPlan",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPlan),
		activityReplay: {
			buildActivityArgs: buildCreatePlanReplaySummaryArgs,
			buildDetails: buildEmptyReplayDetailFields,
		},
	},
	{
		normalizedName: "task",
		replayLegacyName: "cursor_task",
		promptLabel: "Cursor task",
		displayLabel: "Cursor task",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "task",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayTask),
		activityReplay: {
			buildActivityArgs: buildTaskReplaySummaryArgs,
			buildDetails: buildEmptyReplayDetailFields,
		},
	},
	{
		normalizedName: "generateImage",
		replayLegacyName: "cursor_generate_image",
		promptLabel: "Cursor image generation",
		displayLabel: "Cursor image generation",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "generateImage",
		replayCallSummary: withActivitySummaryFallback((args: CursorReplayGenerateImageSummaryArgs | undefined) =>
			readCursorReplaySummaryString(args, "path") ?? readCursorReplaySummaryString(args, "prompt"),
		),
		generateImageReplay: {
			buildActivityArgs: buildGenerateImageReplaySummaryArgs,
			buildDetails: buildGenerateImageReplayDetailFields,
		},
	},
	{
		normalizedName: "mcp",
		replayLegacyName: "cursor_mcp",
		replayOperationLabel: "MCP",
		promptLabel: "Cursor MCP",
		displayLabel: "Cursor MCP",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "mcp",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayMcp),
		activityReplay: {
			buildActivityArgs: buildMcpReplaySummaryArgs,
			buildDetails: buildEmptyReplayDetailFields,
		},
	},
	{
		normalizedName: "semSearch",
		replayLegacyName: "cursor_sem_search",
		promptLabel: "Cursor semantic search",
		displayLabel: "Cursor semantic search",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "semSearch",
		replayCallSummary: withActivitySummaryFallback(formatReplaySemSearchQuery),
		activityReplay: {
			buildActivityArgs: buildSemSearchReplaySummaryArgs,
			buildDetails: buildEmptyReplayDetailFields,
		},
	},
	{
		normalizedName: "recordScreen",
		replayLegacyName: "cursor_record_screen",
		promptLabel: "Cursor screen recording",
		displayLabel: "Cursor screen recording",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "recordScreen",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayRecordScreen),
		activityReplay: {
			buildActivityArgs: buildRecordScreenReplaySummaryArgs,
			buildDetails: buildEmptyReplayDetailFields,
		},
	},
	{
		normalizedName: "webSearch",
		nameAliases: ["websearch", "web_search", "web-search"],
		replayLegacyName: "cursor_web_search",
		replayOperationLabel: "web search",
		promptLabel: "Cursor web search",
		displayLabel: "Cursor web search",
		visibility: { lifecycleEligible: true },
		webKind: "webSearch",
		webNamePatterns: [WEB_SEARCH_NAME_PATTERN],
		lifecycleLabelKind: "webSearch",
		replayCallSummary: withActivitySummaryFallback((args: CursorReplayWebSearchSummaryArgs | undefined) =>
			readCursorReplaySummaryString(args, "query"),
		),
		activityReplay: {
			buildActivityArgs: buildWebSearchReplaySummaryArgs,
			buildDetails: buildCollapsedReplayDetailFields,
		},
	},
	{
		normalizedName: "webFetch",
		nameAliases: ["webfetch", "web_fetch", "web-fetch"],
		replayLegacyName: "cursor_web_fetch",
		replayOperationLabel: "web fetch",
		promptLabel: "Cursor web fetch",
		displayLabel: "Cursor web fetch",
		visibility: { lifecycleEligible: true },
		webKind: "webFetch",
		webNamePatterns: [WEB_FETCH_NAME_PATTERN],
		lifecycleLabelKind: "webFetch",
		replayCallSummary: withActivitySummaryFallback((args: CursorReplayWebFetchSummaryArgs | undefined) =>
			readCursorReplaySummaryString(args, "url"),
		),
		activityReplay: {
			buildActivityArgs: buildWebFetchReplaySummaryArgs,
			buildDetails: buildCollapsedReplayDetailFields,
		},
	},
] as const satisfies readonly CursorToolPresentationSpec[];

type CursorToolPresentationSpecEntry = (typeof CURSOR_TOOL_PRESENTATION_SPECS)[number];

export type CursorNormalizedToolName = CursorReplaySourceToolName;

export type CursorReplayLegacyToolName = Extract<
	CursorToolPresentationSpecEntry,
	{ readonly replayLegacyName: string }
>["replayLegacyName"];

export type CursorReplayToolName = typeof CURSOR_REPLAY_ACTIVITY_TOOL_NAME | CursorReplayLegacyToolName;

type CursorToolPresentationSpecWithReplayLegacy = Extract<
	CursorToolPresentationSpecEntry,
	{ readonly replayLegacyName: string }
>;

const CURSOR_REPLAY_ACTIVITY_SIDE_EFFECT_CATEGORY: CursorReplaySideEffectCategory = "file_mutations";

function hasReplayLegacyName(spec: CursorToolPresentationSpecEntry): spec is CursorToolPresentationSpecWithReplayLegacy {
	return "replayLegacyName" in spec;
}

type ReplayActivityLabelKeysFromSpecs<Specs extends readonly CursorToolPresentationSpecEntry[]> = {
	[K in Extract<Specs[number], { readonly replayLegacyName: string }>["normalizedName"]]: Extract<
		Specs[number],
		{ readonly replayLegacyName: string; normalizedName: K }
	>["replayLegacyName"];
};

function buildReplayActivityLabelKeysByToolName<const Specs extends readonly CursorToolPresentationSpecEntry[]>(
	specs: Specs,
): ReplayActivityLabelKeysFromSpecs<Specs> {
	const labelKeys: Record<string, CursorReplayLegacyToolName> = {};
	for (const spec of specs) {
		if (!hasReplayLegacyName(spec)) continue;
		labelKeys[spec.normalizedName] = spec.replayLegacyName;
	}
	return labelKeys as ReplayActivityLabelKeysFromSpecs<Specs>;
}

const CURSOR_REPLAY_SPECS = CURSOR_TOOL_PRESENTATION_SPECS.filter(hasReplayLegacyName);

/** Stable registration order for native replay tool wrappers (registry declaration order). */
export const CURSOR_REPLAY_LEGACY_TOOL_NAMES: readonly CursorReplayLegacyToolName[] = CURSOR_REPLAY_SPECS.map(
	(spec) => spec.replayLegacyName,
);

export const CURSOR_REPLAY_ACTIVITY_LABEL_KEYS_BY_TOOL_NAME = buildReplayActivityLabelKeysByToolName(
	CURSOR_TOOL_PRESENTATION_SPECS,
);

export type CursorReplayActivityToolName = keyof typeof CURSOR_REPLAY_ACTIVITY_LABEL_KEYS_BY_TOOL_NAME;

const SPECS_BY_NORMALIZED_NAME = new Map<string, CursorToolPresentationSpec>(
	CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => [spec.normalizedName, spec]),
);

const SPECS_BY_NORMALIZED_KEY = new Map<string, CursorToolPresentationSpec>(
	CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => [spec.normalizedName.toLowerCase(), spec]),
);

const SPECS_BY_REPLAY_LEGACY_NAME = new Map<CursorReplayLegacyToolName, CursorToolPresentationSpec>(
	CURSOR_REPLAY_SPECS.map((spec) => [spec.replayLegacyName, spec]),
);

const ALIAS_TO_NORMALIZED_NAME = new Map<string, CursorNormalizedToolName>(
	CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) => {
		const aliases = "nameAliases" in spec ? spec.nameAliases : undefined;
		return (aliases ?? []).map((alias) => [alias.toLowerCase(), spec.normalizedName] as const);
	}),
);

const WEB_KIND_BY_PATTERN = CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) => {
	if (!("webKind" in spec) || !("webNamePatterns" in spec)) return [];
	const { webKind, webNamePatterns } = spec;
	if (!webKind || !webNamePatterns) return [];
	return webNamePatterns.map((pattern) => ({ pattern, webKind }));
});

export const CURSOR_KNOWN_NORMALIZED_TOOL_NAMES: readonly CursorNormalizedToolName[] = CURSOR_REPLAY_SOURCE_TOOL_NAMES;

export function getCursorToolPresentationSpec(
	name: string,
): CursorToolPresentationSpec | undefined {
	const trimmed = name.trim();
	if (!trimmed) return undefined;
	return (
		SPECS_BY_NORMALIZED_NAME.get(trimmed) ??
		SPECS_BY_NORMALIZED_KEY.get(trimmed.toLowerCase()) ??
		(isCursorReplayLegacyToolName(trimmed) ? SPECS_BY_REPLAY_LEGACY_NAME.get(trimmed) : undefined)
	);
}

export function normalizeCursorToolName(name: string): string {
	const normalized = name.replace(/\s+/g, " ").trim();
	if (!normalized) return "unknown";
	const aliasTarget = ALIAS_TO_NORMALIZED_NAME.get(normalized.toLowerCase());
	if (aliasTarget) return aliasTarget;
	const spec = getCursorToolPresentationSpec(normalized);
	if (spec) return spec.normalizedName;
	return normalized;
}

export function classifyCursorWebToolKind(name: string | undefined): CursorWebToolKind | undefined {
	if (!name) return undefined;
	const normalized = name.replace(/\s+/g, " ").trim().toLowerCase();
	for (const { pattern, webKind } of WEB_KIND_BY_PATTERN) {
		if (pattern.test(normalized)) return webKind;
	}
	const spec = getCursorToolPresentationSpec(name);
	return spec?.webKind;
}

const CURSOR_REPLAY_LEGACY_TOOL_NAME_SET: ReadonlySet<string> = new Set(CURSOR_REPLAY_LEGACY_TOOL_NAMES);

export function isCursorReplayLegacyToolName(toolName: string): toolName is CursorReplayLegacyToolName {
	return CURSOR_REPLAY_LEGACY_TOOL_NAME_SET.has(toolName);
}

export function isCursorReplayToolName(toolName: string): toolName is CursorReplayToolName {
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME || isCursorReplayLegacyToolName(toolName);
}

export function isExcludedFromCursorBridgeExposure(toolName: string): boolean {
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME || isCursorReplayLegacyToolName(toolName);
}

export function getCursorReplayWrapperLabel(toolName: CursorReplayToolName): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return getCursorReplayDisplayLabel(toolName);
	const spec = SPECS_BY_REPLAY_LEGACY_NAME.get(toolName);
	return spec?.replayWrapperLabel ?? getCursorReplayDisplayLabel(toolName);
}

export function getCursorReplaySideEffectCategory(toolName: CursorReplayToolName): CursorReplaySideEffectCategory {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return CURSOR_REPLAY_ACTIVITY_SIDE_EFFECT_CATEGORY;
	return SPECS_BY_REPLAY_LEGACY_NAME.get(toolName)?.replaySideEffectCategory ?? "real_tool_work";
}

export function getCursorReplaySideEffectDescription(toolName: CursorReplayToolName): string {
	return getCursorReplaySideEffectCategory(toolName) === "file_mutations" ? "file mutations" : "real tool work";
}

export function getCursorReplayOperationLabel(toolName: CursorReplayLegacyToolName): string {
	const spec = SPECS_BY_REPLAY_LEGACY_NAME.get(toolName);
	return spec?.replayOperationLabel ?? spec?.normalizedName ?? toolName;
}

export function getCursorReplayPromptLabel(toolName: string): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return "Cursor activity";
	if (isCursorReplayLegacyToolName(toolName)) {
		const spec = SPECS_BY_REPLAY_LEGACY_NAME.get(toolName);
		return spec?.promptLabel ?? toolName;
	}
	return toolName;
}

export function getCursorReplayDisplayLabel(toolName: CursorReplayToolName): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return "Cursor activity";
	const spec = SPECS_BY_REPLAY_LEGACY_NAME.get(toolName);
	return spec?.displayLabel ?? toolName;
}

export function getCursorReplayActivityLabelKey(toolName: string): CursorReplayLegacyToolName | undefined {
	const spec = getCursorToolPresentationSpec(toolName);
	if (!spec?.replayLegacyName || !isCursorReplayLegacyToolName(spec.replayLegacyName)) return undefined;
	return spec.replayLegacyName;
}

export function getCursorReplayActivityTitle(toolName: string): string | undefined {
	const spec = getCursorToolPresentationSpec(toolName);
	if (!spec?.replayLegacyName) return undefined;
	return spec.displayLabel;
}

function getCursorToolPresentationSpecByNormalizedKey(normalizedKey: string): CursorToolPresentationSpec | undefined {
	return SPECS_BY_NORMALIZED_KEY.get(normalizedKey.toLowerCase());
}

export function getCursorToolVisibilityPolicy(normalizedKey: string): CursorToolVisibilityPolicy | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.visibility;
}

export function getCursorToolLifecycleLabelKind(normalizedKey: string): CursorToolLifecycleLabelKind | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.lifecycleLabelKind;
}

export function getCursorToolActivityReplaySpec(normalizedKey: string): CursorToolActivityReplaySpec | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.activityReplay;
}

export function getCursorToolGenerateImageReplaySpec(normalizedKey: string): CursorToolGenerateImageReplaySpec | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.generateImageReplay;
}

export function getCursorReplayCallSummary(
	toolName: CursorReplayToolName,
	args: CursorReplaySummaryArgs | undefined,
): string | undefined {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) {
		return readCursorReplaySummaryString(args, "activitySummary") ?? summarizeReplayGenericActivity(args);
	}
	return SPECS_BY_REPLAY_LEGACY_NAME.get(toolName)?.replayCallSummary?.(args);
}
