export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function getFirstStringByKeys(
	record: Record<string, unknown> | undefined,
	keys: readonly string[],
	options?: { nonEmpty?: boolean },
): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string") continue;
		if (options?.nonEmpty && !value) continue;
		return value;
	}
	return undefined;
}
