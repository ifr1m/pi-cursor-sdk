export const CURSOR_SETTING_SOURCES_ENV = "PI_CURSOR_SETTING_SOURCES";

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export function scrubSensitiveText(text, apiKey) {
	let scrubbed = text;
	const trimmedKey = apiKey?.trim();
	if (trimmedKey) {
		scrubbed = scrubbed.replace(new RegExp(escapeRegExp(trimmedKey), "g"), "[redacted]");
	}
	return scrubbed
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/((?:^|[\s,{])cookie["']?\s*[:=]\s*["']?)[^\n]+/gi, "$1[redacted]")
		.replace(
			/((?:authorization|api[_-]?key|apiKey|token|session(?:[_-]?id)?)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
			"$1[redacted]",
		);
}
