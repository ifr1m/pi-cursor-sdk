const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (trimmed === CURSOR_API_KEY_ENV_VAR) return process.env.CURSOR_API_KEY?.trim();
	return trimmed;
}
