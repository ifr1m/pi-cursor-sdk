const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "none", "no", "disabled"]);
const ENABLED_ENV_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);

export function parseEnvBoolean(
	raw: string | undefined,
	defaultValue: boolean,
): boolean {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return defaultValue;
	if (DISABLED_ENV_VALUES.has(normalized)) return false;
	if (ENABLED_ENV_VALUES.has(normalized)) return true;
	return defaultValue;
}
