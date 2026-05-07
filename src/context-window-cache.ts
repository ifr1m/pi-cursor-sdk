import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUNDLED_CONTEXT_WINDOWS } from "./bundled-context-windows.js";

const CONTEXT_WINDOW_CACHE_FILE = "cursor-sdk-context-windows.json";

interface ContextWindowCacheFile {
	contextWindows?: Record<string, number>;
}

function getCachePath(): string {
	return join(getAgentDir(), CONTEXT_WINDOW_CACHE_FILE);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function loadUserContextWindowOverrides(): Map<string, number> {
	const path = getCachePath();
	const overrides = new Map<string, number>();
	if (!existsSync(path)) return overrides;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ContextWindowCacheFile;
		for (const [modelId, contextWindow] of Object.entries(parsed.contextWindows ?? {})) {
			if (isPositiveInteger(contextWindow)) overrides.set(modelId, contextWindow);
		}
	} catch {
		return overrides;
	}
	return overrides;
}

export function loadContextWindowCache(): Map<string, number> {
	const cache = new Map<string, number>(Object.entries(BUNDLED_CONTEXT_WINDOWS));
	for (const [modelId, contextWindow] of loadUserContextWindowOverrides()) {
		cache.set(modelId, contextWindow);
	}
	return cache;
}

export function getCachedContextWindow(modelId: string): number | undefined {
	const cache = loadContextWindowCache();
	return cache.get(modelId) ?? cache.get("default");
}

export function getCheckpointContextWindow(checkpoint: unknown): number | undefined {
	if (checkpoint === null || typeof checkpoint !== "object") return undefined;
	const tokenDetails = (checkpoint as Record<PropertyKey, unknown>).tokenDetails;
	if (tokenDetails === null || typeof tokenDetails !== "object") return undefined;
	const maxTokens = (tokenDetails as Record<PropertyKey, unknown>).maxTokens;
	if (!isPositiveInteger(maxTokens)) return undefined;
	return maxTokens;
}

export function saveCachedContextWindow(modelId: string, contextWindow: number): void {
	if (!isPositiveInteger(contextWindow)) return;
	const overrides = loadUserContextWindowOverrides();
	const bundledContextWindow =
		BUNDLED_CONTEXT_WINDOWS[modelId as keyof typeof BUNDLED_CONTEXT_WINDOWS] ?? BUNDLED_CONTEXT_WINDOWS.default;
	if (bundledContextWindow === contextWindow) {
		if (!overrides.has(modelId)) return;
		overrides.delete(modelId);
	} else {
		if (overrides.get(modelId) === contextWindow) return;
		overrides.set(modelId, contextWindow);
	}
	const path = getCachePath();
	mkdirSync(dirname(path), { recursive: true });
	const data: ContextWindowCacheFile = {
		contextWindows: Object.fromEntries([...overrides.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export const __testUtils = {
	getCachePath,
};
