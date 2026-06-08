import { parseEnvBoolean } from "./cursor-env-boolean.js";

export const CURSOR_PI_TOOL_BRIDGE_ENV = "PI_CURSOR_PI_TOOL_BRIDGE";
export const CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";

export function resolveCursorPiToolBridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_ENV], true);
}

export function resolveCursorPiToolBridgeBuiltinsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV], false);
}
