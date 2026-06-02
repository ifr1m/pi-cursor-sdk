import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUNDLED_CONTEXT_WINDOWS } from "./bundled-context-windows.js";

const CONTEXT_WINDOW_CACHE_FILE = "cursor-sdk-context-windows.json";
let userContextWindowOverrideLoadCount = 0;

interface ContextWindowCacheFile {
	contextWindows?: Record<string, number>;
}

function getCachePath(): string {
	return join(getAgentDir(), CONTEXT_WINDOW_CACHE_FILE);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseContextWindowCacheFile(value: unknown): ContextWindowCacheFile | undefined {
	if (!isRecord(value)) return undefined;
	const { contextWindows } = value;
	if (contextWindows === undefined) return {};
	if (!isRecord(contextWindows)) return undefined;
	return {
		contextWindows: Object.fromEntries(
			Object.entries(contextWindows).filter((entry): entry is [string, number] => isPositiveInteger(entry[1])),
		),
	};
}

function loadUserContextWindowOverrides(): Map<string, number> {
	userContextWindowOverrideLoadCount += 1;
	const path = getCachePath();
	const overrides = new Map<string, number>();
	if (!existsSync(path)) return overrides;
	try {
		const parsed = parseContextWindowCacheFile(JSON.parse(readFileSync(path, "utf-8")));
		for (const [modelId, contextWindow] of Object.entries(parsed?.contextWindows ?? {})) {
			overrides.set(modelId, contextWindow);
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

export function getCachedContextWindowExact(modelId: string): number | undefined {
	return loadContextWindowCache().get(modelId);
}

export function getCachedContextWindow(modelId: string): number | undefined {
	const cache = loadContextWindowCache();
	return cache.get(modelId) ?? cache.get("default");
}

export function getCheckpointContextWindow(checkpoint: unknown): number | undefined {
	if (!isRecord(checkpoint)) return undefined;
	const { tokenDetails } = checkpoint;
	if (!isRecord(tokenDetails)) return undefined;
	const { maxTokens } = tokenDetails;
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
	getUserContextWindowOverrideLoadCount: () => userContextWindowOverrideLoadCount,
	resetUserContextWindowOverrideLoadCount: () => {
		userContextWindowOverrideLoadCount = 0;
	},
};
