const CURSOR_EDIT_DIFF_FIELD_ORDER = ["diffString", "diff", "unifiedDiff", "patch"] as const;

export function resolveCursorEditDiff(source: unknown): string | undefined {
	if (!source || typeof source !== "object") return undefined;
	const record = source as Record<string, unknown>;
	for (const key of CURSOR_EDIT_DIFF_FIELD_ORDER) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}
