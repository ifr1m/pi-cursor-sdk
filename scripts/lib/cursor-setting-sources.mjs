/** Canonical Cursor settingSources parsing for maintainer scripts (parity-tested against src). */
export const CURSOR_SETTING_SOURCES_ENV = "PI_CURSOR_SETTING_SOURCES";

export function resolveCursorSettingSources(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return ["all"];
	const normalized = trimmed.toLowerCase();
	if (["0", "false", "off", "none", "omit", "disabled"].includes(normalized)) return undefined;
	if (["1", "true", "on", "all"].includes(normalized)) return ["all"];
	return trimmed
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}
