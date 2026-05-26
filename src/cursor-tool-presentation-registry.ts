/**
 * Canonical Cursor tool presentation metadata.
 * Names, labels, visibility, replay, lifecycle, web remapping, and alias normalization
 * derive from this registry — do not duplicate tool lists in sibling modules.
 */

export const CURSOR_REPLAY_ACTIVITY_TOOL_NAME = "cursor" as const;

export type CursorWebToolKind = "webSearch" | "webFetch";

export type CursorNormalizedToolName =
	| "read"
	| "grep"
	| "glob"
	| "ls"
	| "shell"
	| "edit"
	| "write"
	| "delete"
	| "readLints"
	| "updateTodos"
	| "createPlan"
	| "task"
	| "generateImage"
	| "mcp"
	| "semSearch"
	| "recordScreen"
	| "webSearch"
	| "webFetch";

export type CursorReplayLegacyToolName =
	| "cursor_edit"
	| "cursor_write"
	| "cursor_read_lints"
	| "cursor_delete"
	| "cursor_update_todos"
	| "cursor_task"
	| "cursor_create_plan"
	| "cursor_generate_image"
	| "cursor_mcp"
	| "cursor_sem_search"
	| "cursor_record_screen"
	| "cursor_web_search"
	| "cursor_web_fetch";

export type CursorReplayToolName = typeof CURSOR_REPLAY_ACTIVITY_TOOL_NAME | CursorReplayLegacyToolName;

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

export type CursorReplaySummaryKind =
	| "path"
	| "read_lints"
	| "todo_count"
	| "description"
	| "generate_image"
	| "mcp_tool_name"
	| "sem_search"
	| "record_screen"
	| "web_query"
	| "web_url"
	| "activity_generic";

export interface CursorToolVisibilityPolicy {
	incompleteTitle?: string;
	lifecycleTitle?: string;
	lifecycleEligible?: boolean;
	fastLocalDiscovery?: boolean;
}

export interface CursorToolPresentationSpec {
	normalizedName: CursorNormalizedToolName;
	/** Raw SDK/host names that resolve to this tool via {@link normalizeCursorToolName}. */
	nameAliases?: readonly string[];
	replayLegacyName?: CursorReplayLegacyToolName;
	replaySourceName?: string;
	promptLabel: string;
	displayLabel: string;
	visibility: CursorToolVisibilityPolicy;
	bridgeExcluded: boolean;
	webKind?: CursorWebToolKind;
	/** Regexes matched against lowercased trimmed tool names for {@link classifyCursorWebToolKind}. */
	webNamePatterns?: readonly RegExp[];
	lifecycleLabelKind?: CursorToolLifecycleLabelKind;
	replaySummaryKind?: CursorReplaySummaryKind;
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
		bridgeExcluded: false,
	},
	{
		normalizedName: "grep",
		nameAliases: ["grep_search", "search"],
		promptLabel: "grep",
		displayLabel: "grep",
		visibility: { incompleteTitle: "Cursor grep", fastLocalDiscovery: true },
		bridgeExcluded: false,
	},
	{
		normalizedName: "glob",
		nameAliases: ["file_search"],
		promptLabel: "glob",
		displayLabel: "glob",
		visibility: { incompleteTitle: "Cursor find", fastLocalDiscovery: true },
		bridgeExcluded: false,
	},
	{
		normalizedName: "ls",
		nameAliases: ["list_dir"],
		promptLabel: "ls",
		displayLabel: "ls",
		visibility: { incompleteTitle: "Cursor ls", fastLocalDiscovery: true },
		bridgeExcluded: false,
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
		bridgeExcluded: false,
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
		replaySourceName: "edit",
		promptLabel: "Cursor edit",
		displayLabel: "Cursor edit",
		visibility: {},
		bridgeExcluded: true,
		replaySummaryKind: "path",
	},
	{
		normalizedName: "write",
		nameAliases: ["write_file", "writefile"],
		replayLegacyName: "cursor_write",
		replaySourceName: "write",
		promptLabel: "Cursor write",
		displayLabel: "Cursor write",
		visibility: {},
		bridgeExcluded: true,
		replaySummaryKind: "path",
	},
	{
		normalizedName: "delete",
		replayLegacyName: "cursor_delete",
		replaySourceName: "delete",
		promptLabel: "Cursor delete",
		displayLabel: "Cursor delete",
		visibility: {},
		bridgeExcluded: true,
		replaySummaryKind: "path",
	},
	{
		normalizedName: "readLints",
		replayLegacyName: "cursor_read_lints",
		replaySourceName: "readLints",
		promptLabel: "Cursor diagnostics",
		displayLabel: "Cursor diagnostics",
		visibility: {},
		bridgeExcluded: true,
		replaySummaryKind: "read_lints",
	},
	{
		normalizedName: "updateTodos",
		replayLegacyName: "cursor_update_todos",
		replaySourceName: "updateTodos",
		promptLabel: "Cursor todos",
		displayLabel: "Cursor todos",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		lifecycleLabelKind: "updateTodos",
		replaySummaryKind: "todo_count",
	},
	{
		normalizedName: "createPlan",
		replayLegacyName: "cursor_create_plan",
		replaySourceName: "createPlan",
		promptLabel: "Cursor plan",
		displayLabel: "Cursor plan",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		lifecycleLabelKind: "createPlan",
		replaySummaryKind: "todo_count",
	},
	{
		normalizedName: "task",
		replayLegacyName: "cursor_task",
		replaySourceName: "task",
		promptLabel: "Cursor task",
		displayLabel: "Cursor task",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		lifecycleLabelKind: "task",
		replaySummaryKind: "description",
	},
	{
		normalizedName: "generateImage",
		replayLegacyName: "cursor_generate_image",
		replaySourceName: "generateImage",
		promptLabel: "Cursor image generation",
		displayLabel: "Cursor image generation",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		lifecycleLabelKind: "generateImage",
		replaySummaryKind: "generate_image",
	},
	{
		normalizedName: "mcp",
		replayLegacyName: "cursor_mcp",
		replaySourceName: "MCP",
		promptLabel: "Cursor MCP",
		displayLabel: "Cursor MCP",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		lifecycleLabelKind: "mcp",
		replaySummaryKind: "mcp_tool_name",
	},
	{
		normalizedName: "semSearch",
		replayLegacyName: "cursor_sem_search",
		replaySourceName: "semSearch",
		promptLabel: "Cursor semantic search",
		displayLabel: "Cursor semantic search",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		lifecycleLabelKind: "semSearch",
		replaySummaryKind: "sem_search",
	},
	{
		normalizedName: "recordScreen",
		replayLegacyName: "cursor_record_screen",
		replaySourceName: "recordScreen",
		promptLabel: "Cursor screen recording",
		displayLabel: "Cursor screen recording",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		lifecycleLabelKind: "recordScreen",
		replaySummaryKind: "record_screen",
	},
	{
		normalizedName: "webSearch",
		nameAliases: ["websearch", "web_search", "web-search"],
		replayLegacyName: "cursor_web_search",
		replaySourceName: "web search",
		promptLabel: "Cursor web search",
		displayLabel: "Cursor web search",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		webKind: "webSearch",
		webNamePatterns: [WEB_SEARCH_NAME_PATTERN],
		lifecycleLabelKind: "webSearch",
		replaySummaryKind: "web_query",
	},
	{
		normalizedName: "webFetch",
		nameAliases: ["webfetch", "web_fetch", "web-fetch"],
		replayLegacyName: "cursor_web_fetch",
		replaySourceName: "web fetch",
		promptLabel: "Cursor web fetch",
		displayLabel: "Cursor web fetch",
		visibility: { lifecycleEligible: true },
		bridgeExcluded: true,
		webKind: "webFetch",
		webNamePatterns: [WEB_FETCH_NAME_PATTERN],
		lifecycleLabelKind: "webFetch",
		replaySummaryKind: "web_url",
	},
] satisfies readonly CursorToolPresentationSpec[];

function hasReplayLegacyName(
	spec: CursorToolPresentationSpec,
): spec is CursorToolPresentationSpec & { replayLegacyName: CursorReplayLegacyToolName } {
	return spec.replayLegacyName !== undefined;
}

/** Stable registration order for native replay tool wrappers. */
const CURSOR_REPLAY_LEGACY_TOOL_NAME_ORDER = [
	"cursor_edit",
	"cursor_write",
	"cursor_read_lints",
	"cursor_delete",
	"cursor_update_todos",
	"cursor_task",
	"cursor_create_plan",
	"cursor_generate_image",
	"cursor_mcp",
	"cursor_sem_search",
	"cursor_record_screen",
	"cursor_web_search",
	"cursor_web_fetch",
] as const satisfies readonly CursorReplayLegacyToolName[];

export const CURSOR_REPLAY_LEGACY_TOOL_NAMES: readonly CursorReplayLegacyToolName[] =
	CURSOR_REPLAY_LEGACY_TOOL_NAME_ORDER;

export const CURSOR_REPLAY_ACTIVITY_LABEL_KEYS_BY_TOOL_NAME = Object.fromEntries(
	CURSOR_TOOL_PRESENTATION_SPECS.filter(hasReplayLegacyName).map((spec) => [spec.normalizedName, spec.replayLegacyName]),
) as Record<CursorNormalizedToolName & string, CursorReplayLegacyToolName>;

export type CursorReplayActivityToolName = keyof typeof CURSOR_REPLAY_ACTIVITY_LABEL_KEYS_BY_TOOL_NAME;

const SPECS_BY_NORMALIZED_NAME = new Map<string, CursorToolPresentationSpec>(
	CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => [spec.normalizedName, spec]),
);

const SPECS_BY_NORMALIZED_KEY = new Map<string, CursorToolPresentationSpec>(
	CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => [spec.normalizedName.toLowerCase(), spec]),
);

const SPECS_BY_REPLAY_LEGACY_NAME = new Map<string, CursorToolPresentationSpec>(
	CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) =>
		spec.replayLegacyName ? [[spec.replayLegacyName, spec] as const] : [],
	),
);

const ALIAS_TO_NORMALIZED_NAME = new Map<string, CursorNormalizedToolName>(
	CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) =>
		(spec.nameAliases ?? []).map((alias) => [alias.toLowerCase(), spec.normalizedName]),
	),
);

const WEB_KIND_BY_PATTERN = CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) =>
	spec.webKind && spec.webNamePatterns
		? spec.webNamePatterns.map((pattern) => ({ pattern, webKind: spec.webKind! }))
		: [],
);

export const CURSOR_KNOWN_NORMALIZED_TOOL_NAMES = CURSOR_TOOL_PRESENTATION_SPECS.map(
	(spec) => spec.normalizedName,
) as readonly CursorNormalizedToolName[];

export function getCursorToolPresentationSpec(
	name: string,
): CursorToolPresentationSpec | undefined {
	const trimmed = name.trim();
	if (!trimmed) return undefined;
	return (
		SPECS_BY_NORMALIZED_NAME.get(trimmed) ??
		SPECS_BY_NORMALIZED_KEY.get(trimmed.toLowerCase()) ??
		SPECS_BY_REPLAY_LEGACY_NAME.get(trimmed)
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

export function isCursorReplayLegacyToolName(toolName: string): toolName is CursorReplayLegacyToolName {
	return SPECS_BY_REPLAY_LEGACY_NAME.has(toolName);
}

export function isCursorReplayToolName(toolName: string): toolName is CursorReplayToolName {
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME || isCursorReplayLegacyToolName(toolName);
}

export function isExcludedFromCursorBridgeExposure(toolName: string): boolean {
	const spec = getCursorToolPresentationSpec(toolName);
	if (spec?.bridgeExcluded) return true;
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME;
}

export function getCursorReplaySourceToolName(toolName: CursorReplayLegacyToolName): string {
	const spec = SPECS_BY_REPLAY_LEGACY_NAME.get(toolName);
	return spec?.replaySourceName ?? toolName;
}

export function getCursorReplayPromptLabel(toolName: string): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return "Cursor activity";
	const spec = getCursorToolPresentationSpec(toolName);
	if (spec) return spec.promptLabel;
	return toolName;
}

export function getCursorReplayDisplayLabel(toolName: CursorReplayToolName): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return "Cursor activity";
	const spec = SPECS_BY_REPLAY_LEGACY_NAME.get(toolName);
	return spec?.displayLabel ?? toolName;
}

export function getCursorReplayActivityLabelKey(toolName: string): CursorReplayLegacyToolName | undefined {
	const spec = getCursorToolPresentationSpec(toolName);
	return spec?.replayLegacyName;
}

export function getCursorReplayActivityTitle(toolName: string): string | undefined {
	const spec = getCursorToolPresentationSpec(toolName);
	if (!spec?.replayLegacyName) return undefined;
	return spec.displayLabel;
}

export function getCursorToolVisibilityPolicy(normalizedKey: string): CursorToolVisibilityPolicy | undefined {
	return SPECS_BY_NORMALIZED_KEY.get(normalizedKey)?.visibility;
}

export function getCursorToolLifecycleLabelKind(normalizedKey: string): CursorToolLifecycleLabelKind | undefined {
	return SPECS_BY_NORMALIZED_KEY.get(normalizedKey)?.lifecycleLabelKind;
}

export function getCursorReplaySummaryKind(
	toolName: CursorReplayToolName,
): CursorReplaySummaryKind | undefined {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) return "activity_generic";
	return SPECS_BY_REPLAY_LEGACY_NAME.get(toolName)?.replaySummaryKind;
}
