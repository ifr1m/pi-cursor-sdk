const CURSOR_EDIT_DIFF_FIELD_ORDER = ["diffString", "diff", "unifiedDiff", "patch"] as const;

export type CursorEditDiffSource = Record<string, unknown> | {
	diffString?: string;
	diff?: string;
	unifiedDiff?: string;
	patch?: string;
};

export function resolveCursorEditDiff(source: CursorEditDiffSource | undefined): string | undefined {
	if (!source) return undefined;
	const record = source as Record<string, unknown>;
	for (const key of CURSOR_EDIT_DIFF_FIELD_ORDER) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}
