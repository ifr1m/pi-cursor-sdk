import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelListItem } from "@cursor/sdk";
import { parseEnvBoolean } from "./cursor-env-boolean.js";

const MODEL_LIST_CACHE_FILE = "cursor-sdk-model-list.json";
const MODEL_LIST_CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DISABLE_ENV_VAR = "PI_CURSOR_SDK_DISABLE_MODEL_CACHE";
const TTL_ENV_VAR = "PI_CURSOR_SDK_MODEL_CACHE_TTL_MS";

interface ModelListCacheFile {
	version: number;
	fetchedAt: number;
	keyFingerprint: string;
	models: ModelListItem[];
}

export interface CachedModelList {
	fetchedAt: number;
	models: ModelListItem[];
}

function getCachePath(): string {
	return join(getAgentDir(), MODEL_LIST_CACHE_FILE);
}

export function isModelCacheDisabled(): boolean {
	return parseEnvBoolean(process.env[DISABLE_ENV_VAR], false);
}

export function getModelCacheTtlMs(): number {
	const raw = process.env[TTL_ENV_VAR];
	if (raw === undefined) return DEFAULT_TTL_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTL_MS;
	return parsed;
}

// Fingerprint the API key so a key change invalidates the cache, without ever
// persisting the key itself.
export function fingerprintApiKey(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isModelParameterValue(value: unknown): value is NonNullable<ModelListItem["variants"]>[number]["params"][number] {
	return isRecord(value) && typeof value.id === "string" && typeof value.value === "string";
}

function isModelParameterDefinitionValue(value: unknown): value is NonNullable<ModelListItem["parameters"]>[number]["values"][number] {
	return isRecord(value) && typeof value.value === "string" && (value.displayName === undefined || typeof value.displayName === "string");
}

function isModelParameterDefinition(value: unknown): value is NonNullable<ModelListItem["parameters"]>[number] {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		(value.displayName === undefined || typeof value.displayName === "string") &&
		Array.isArray(value.values) &&
		value.values.every(isModelParameterDefinitionValue)
	);
}

function isModelVariant(value: unknown): value is NonNullable<ModelListItem["variants"]>[number] {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.params) &&
		value.params.every(isModelParameterValue) &&
		typeof value.displayName === "string" &&
		(value.description === undefined || typeof value.description === "string") &&
		(value.isDefault === undefined || typeof value.isDefault === "boolean")
	);
}

function isModelListItem(value: unknown): value is ModelListItem {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.displayName === "string" &&
		(value.description === undefined || typeof value.description === "string") &&
		(value.aliases === undefined || isStringArray(value.aliases)) &&
		(value.parameters === undefined || (Array.isArray(value.parameters) && value.parameters.every(isModelParameterDefinition))) &&
		(value.variants === undefined || (Array.isArray(value.variants) && value.variants.every(isModelVariant)))
	);
}

function isValidFetchedAt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Date.now() + MAX_CACHE_CLOCK_SKEW_MS;
}

function parseModelListCacheFile(value: unknown): ModelListCacheFile | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== MODEL_LIST_CACHE_VERSION ||
		!isValidFetchedAt(value.fetchedAt) ||
		typeof value.keyFingerprint !== "string" ||
		!Array.isArray(value.models) ||
		!value.models.every(isModelListItem)
	) {
		return undefined;
	}
	return {
		version: value.version,
		fetchedAt: value.fetchedAt,
		keyFingerprint: value.keyFingerprint,
		models: value.models,
	};
}

function readCacheFile(): ModelListCacheFile | undefined {
	const path = getCachePath();
	if (!existsSync(path)) return undefined;
	try {
		return parseModelListCacheFile(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

// Return cached models only when caching is enabled, the key matches, and the
// entry is within the TTL. Used on the hot startup path to skip the network.
export function loadFreshCachedModels(keyFingerprint: string, now: number = Date.now()): ModelListItem[] | undefined {
	if (isModelCacheDisabled()) return undefined;
	const ttlMs = getModelCacheTtlMs();
	if (ttlMs <= 0) return undefined;
	const cache = readCacheFile();
	if (!cache || cache.keyFingerprint !== keyFingerprint) return undefined;
	if (now - cache.fetchedAt > ttlMs) return undefined;
	return cache.models;
}

// Return cached models regardless of age, as long as the key matches. Used as a
// resilience fallback when a live discovery request fails.
export function loadAnyCachedModelCatalog(keyFingerprint: string): CachedModelList | undefined {
	if (isModelCacheDisabled()) return undefined;
	const cache = readCacheFile();
	if (!cache || cache.keyFingerprint !== keyFingerprint) return undefined;
	return { fetchedAt: cache.fetchedAt, models: cache.models };
}

export function loadAnyCachedModels(keyFingerprint: string): ModelListItem[] | undefined {
	return loadAnyCachedModelCatalog(keyFingerprint)?.models;
}

export function saveModelListCache(keyFingerprint: string, models: ModelListItem[]): boolean {
	if (isModelCacheDisabled()) return false;
	try {
		const path = getCachePath();
		mkdirSync(dirname(path), { recursive: true });
		const data: ModelListCacheFile = {
			version: MODEL_LIST_CACHE_VERSION,
			fetchedAt: Date.now(),
			keyFingerprint,
			models,
		};
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return true;
	} catch {
		return false;
	}
}

export const __testUtils = {
	getCachePath,
	DEFAULT_TTL_MS,
	DISABLE_ENV_VAR,
	TTL_ENV_VAR,
};
