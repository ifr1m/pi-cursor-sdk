import type { SettingSource } from "@cursor/sdk";
/** Provider-facing wrapper; canonical parsing lives in scripts/lib/cursor-setting-sources.mjs. */
import {
	CURSOR_SETTING_SOURCES_ENV as CURSOR_SETTING_SOURCES_ENV_JS,
	resolveCursorSettingSources as resolveCursorSettingSourcesJs,
} from "../scripts/lib/cursor-setting-sources.mjs";

export const CURSOR_SETTING_SOURCES_ENV = CURSOR_SETTING_SOURCES_ENV_JS;

export function resolveCursorSettingSources(raw?: string): SettingSource[] | undefined {
	return resolveCursorSettingSourcesJs(raw) as SettingSource[] | undefined;
}

export function getEffectiveCursorSettingSources(raw: string | undefined = process.env[CURSOR_SETTING_SOURCES_ENV]): SettingSource[] | undefined {
	return resolveCursorSettingSources(raw);
}

export function cursorSettingSourcesLoadUserAgentsRules(settingSources: SettingSource[] | undefined): boolean {
	if (!settingSources?.length) return false;
	return settingSources.includes("all") || settingSources.includes("user");
}

export function cursorSettingSourcesLoadProjectAgentsRules(settingSources: SettingSource[] | undefined): boolean {
	if (!settingSources?.length) return false;
	return settingSources.includes("all") || settingSources.includes("project");
}
