import { Cursor } from "@cursor/sdk";
import type {
	ModelListItem,
	ModelParameterDefinition,
	ModelParameterValue,
	ModelSelection,
} from "@cursor/sdk";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getCachedContextWindow } from "./context-window-cache.js";

const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 16384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TEXT_AND_IMAGE_INPUT: ProviderModelConfig["input"] = ["text", "image"];

const FALLBACK_MODEL_ITEMS: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Cursor Composer 2",
		parameters: [
			{
				id: "fast",
				displayName: "Fast",
				values: [{ value: "false" }, { value: "true" }],
			},
		],
		variants: [
			{
				params: [{ id: "fast", value: "true" }],
				displayName: "Cursor Composer 2",
				isDefault: true,
			},
		],
	},
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		parameters: [
			{
				id: "context",
				displayName: "Context",
				values: [{ value: "1m" }, { value: "272k" }],
			},
			{
				id: "reasoning",
				displayName: "Reasoning",
				values: [
					{ value: "none" },
					{ value: "low" },
					{ value: "medium" },
					{ value: "high" },
					{ value: "extra-high" },
				],
			},
			{
				id: "fast",
				displayName: "Fast",
				values: [{ value: "false" }, { value: "true" }],
			},
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "reasoning", value: "medium" },
					{ id: "fast", value: "false" },
				],
				displayName: "GPT-5.5",
				isDefault: true,
			},
		],
	},
	{
		id: "claude-sonnet-4-6",
		displayName: "Sonnet 4.6",
		parameters: [
			{
				id: "thinking",
				displayName: "Thinking",
				values: [{ value: "false" }, { value: "true" }],
			},
			{
				id: "context",
				displayName: "Context",
				values: [{ value: "1m" }, { value: "300k" }],
			},
			{
				id: "effort",
				displayName: "Effort",
				values: [
					{ value: "low" },
					{ value: "medium" },
					{ value: "high" },
					{ value: "xhigh" },
					{ value: "max" },
				],
			},
			{
				id: "fast",
				displayName: "Fast",
				values: [{ value: "false" }, { value: "true" }],
			},
		],
		variants: [
			{
				params: [
					{ id: "thinking", value: "true" },
					{ id: "context", value: "1m" },
					{ id: "effort", value: "medium" },
					{ id: "fast", value: "false" },
				],
				displayName: "Sonnet 4.6",
				isDefault: true,
			},
		],
	},
	{
		id: "claude-opus-4-7",
		displayName: "Opus 4.7",
		parameters: [
			{
				id: "thinking",
				displayName: "Thinking",
				values: [{ value: "false" }, { value: "true" }],
			},
			{
				id: "context",
				displayName: "Context",
				values: [{ value: "1m" }, { value: "300k" }],
			},
			{
				id: "effort",
				displayName: "Effort",
				values: [
					{ value: "low" },
					{ value: "medium" },
					{ value: "high" },
					{ value: "xhigh" },
					{ value: "max" },
				],
			},
		],
		variants: [
			{
				params: [
					{ id: "thinking", value: "true" },
					{ id: "context", value: "1m" },
					{ id: "effort", value: "xhigh" },
				],
				displayName: "Opus 4.7",
				isDefault: true,
			},
		],
	},
];

export type CursorModelFallbackReason = "missing-api-key" | "discovery-failed" | "empty-model-list";

export interface CursorModelFallbackIssue {
	reason: CursorModelFallbackReason;
	message: string;
}

export interface DiscoverModelsOptions {
	onFallback?: (issue: CursorModelFallbackIssue) => void;
}

function getCliApiKeyFromArgv(argv: string[] = process.argv): string | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--api-key") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) return undefined;
			const trimmed = value.trim();
			return trimmed || undefined;
		}
		const prefix = "--api-key=";
		if (arg.startsWith(prefix)) {
			const trimmed = arg.slice(prefix.length).trim();
			return trimmed || undefined;
		}
	}
	return undefined;
}

function getDiscoveryApiKey(): string | undefined {
	return process.env.CURSOR_API_KEY?.trim() || getCliApiKeyFromArgv();
}

export interface CursorModelMetadata {
	piModelId: string;
	baseModelId: string;
	displayName: string;
	defaultParams: ModelParameterValue[];
	context?: string;
	contextWindow: number;
	supportsFast: boolean;
	defaultFast: boolean;
	supportsReasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	parameterIds: {
		context: boolean;
		reasoning: boolean;
		effort: boolean;
		thinking: boolean;
		fast: boolean;
	};
}

const metadataByPiModelId = new Map<string, CursorModelMetadata>();

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
	return params.map((param) => ({ ...param }));
}

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
	return item.parameters?.find((parameter) => parameter.id === id);
}

function hasBooleanValues(parameter: ModelParameterDefinition | undefined): boolean {
	const values = new Set((parameter?.values ?? []).map((value) => value.value.toLowerCase()));
	return values.has("false") && values.has("true");
}

function getParameterValue(parameter: ModelParameterDefinition | undefined, lowerValue: string): string | null {
	const value = parameter?.values.find((candidate) => candidate.value.toLowerCase() === lowerValue);
	return value?.value ?? null;
}

function getPreferredParameterValue(
	parameter: ModelParameterDefinition | undefined,
	lowerValues: string[],
): string | null {
	for (const value of lowerValues) {
		const candidate = getParameterValue(parameter, value);
		if (candidate) return candidate;
	}
	return null;
}

function mapComparableLevel(
	parameter: ModelParameterDefinition | undefined,
	level: Exclude<ModelThinkingLevel, "off">,
): string | null {
	if (level === "xhigh") {
		return getPreferredParameterValue(parameter, ["xhigh", "max", "extra-high"]);
	}
	return getParameterValue(parameter, level);
}

function getThinkingLevelMap(item: ModelListItem): ThinkingLevelMap | undefined {
	const reasoningParameter = getParameter(item, "reasoning");
	const effortParameter = getParameter(item, "effort");
	const thinkingParameter = getParameter(item, "thinking");
	const valueParameter = effortParameter ?? reasoningParameter ?? thinkingParameter;
	if (!valueParameter) return undefined;

	if (valueParameter.id === "thinking" && hasBooleanValues(valueParameter)) {
		return {
			off: getParameterValue(valueParameter, "false"),
			minimal: null,
			low: null,
			medium: null,
			high: getParameterValue(valueParameter, "true"),
			xhigh: null,
		};
	}

	return {
		off:
			getParameterValue(reasoningParameter, "none") ??
			getParameterValue(reasoningParameter, "off") ??
			getParameterValue(thinkingParameter, "false"),
		minimal: mapComparableLevel(valueParameter, "minimal"),
		low: mapComparableLevel(valueParameter, "low"),
		medium: mapComparableLevel(valueParameter, "medium"),
		high: mapComparableLevel(valueParameter, "high"),
		xhigh: mapComparableLevel(valueParameter, "xhigh"),
	};
}

function parseContextWindow(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (!Number.isFinite(amount)) return undefined;
	return Math.round(amount * (unit === "m" ? 1000000 : 1000));
}

function getDefaultParams(item: ModelListItem): ModelParameterValue[] {
	if (!item.variants?.length) return [];
	const defaultVariant = item.variants.find((variant) => variant.isDefault) ?? item.variants[0];
	return cloneParams(defaultVariant?.params ?? []);
}

function replaceParam(
	params: ModelParameterValue[],
	id: string,
	value: string,
): ModelParameterValue[] {
	let replaced = false;
	const next = params.map((param) => {
		if (param.id !== id) return { ...param };
		replaced = true;
		return { id, value };
	});
	if (!replaced) next.push({ id, value });
	return next;
}

function getParamValue(params: ModelParameterValue[], id: string): string | undefined {
	return params.find((param) => param.id === id)?.value;
}

function encodePiModelId(baseModelId: string, context?: string): string {
	return context ? `${baseModelId}@${context}` : baseModelId;
}

function getModelName(item: ModelListItem, context?: string): string {
	const displayName = item.displayName || item.id;
	return context ? `${displayName} @ ${context}` : displayName;
}

function getContextWindow(piModelId: string, context?: string): number {
	if (context) return parseContextWindow(context) ?? FALLBACK_CONTEXT_WINDOW;
	return getCachedContextWindow(piModelId) ?? FALLBACK_CONTEXT_WINDOW;
}

function toMetadata(
	item: ModelListItem,
	piModelId: string,
	defaultParams: ModelParameterValue[],
	context: string | undefined,
): CursorModelMetadata {
	const thinkingLevelMap = getThinkingLevelMap(item);
	const fastValue = getParamValue(defaultParams, "fast")?.toLowerCase();
	return {
		piModelId,
		baseModelId: item.id,
		displayName: item.displayName || item.id,
		defaultParams: cloneParams(defaultParams),
		...(context ? { context } : {}),
		contextWindow: getContextWindow(piModelId, context),
		supportsFast: getParameter(item, "fast") !== undefined,
		defaultFast: fastValue === "true",
		supportsReasoning: thinkingLevelMap !== undefined,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		parameterIds: {
			context: getParameter(item, "context") !== undefined,
			reasoning: getParameter(item, "reasoning") !== undefined,
			effort: getParameter(item, "effort") !== undefined,
			thinking: getParameter(item, "thinking") !== undefined,
			fast: getParameter(item, "fast") !== undefined,
		},
	};
}

function toModelConfig(metadata: CursorModelMetadata, name: string): ProviderModelConfig {
	return {
		id: metadata.piModelId,
		name,
		reasoning: metadata.supportsReasoning,
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}),
		input: [...TEXT_AND_IMAGE_INPUT],
		cost: { ...ZERO_COST },
		contextWindow: metadata.contextWindow,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

function getContextValues(item: ModelListItem): string[] {
	return getParameter(item, "context")?.values.map((value) => value.value) ?? [];
}

function toModelConfigs(item: ModelListItem): ProviderModelConfig[] {
	const defaultParams = getDefaultParams(item);
	const contextValues = getContextValues(item);
	const contexts = contextValues.length > 0 ? contextValues : [undefined];

	return contexts.map((context) => {
		const params = context ? replaceParam(defaultParams, "context", context) : defaultParams;
		const piModelId = encodePiModelId(item.id, context);
		const metadata = toMetadata(item, piModelId, params, context);
		metadataByPiModelId.set(piModelId, metadata);
		return toModelConfig(metadata, getModelName(item, context));
	});
}

function sortModelsByBaseId(items: ModelListItem[]): ModelListItem[] {
	return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function registerModelItems(items: ModelListItem[]): ProviderModelConfig[] {
	metadataByPiModelId.clear();
	return sortModelsByBaseId(items).flatMap(toModelConfigs);
}

export function getCursorModelMetadata(modelId: string): CursorModelMetadata | undefined {
	return metadataByPiModelId.get(modelId);
}

export function getCursorModelMetadataEntries(): CursorModelMetadata[] {
	return [...metadataByPiModelId.values()].map((metadata) => ({
		...metadata,
		defaultParams: cloneParams(metadata.defaultParams),
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
		parameterIds: { ...metadata.parameterIds },
	}));
}

function setParam(params: ModelParameterValue[], id: string, value: string): void {
	const existing = params.find((param) => param.id === id);
	if (existing) {
		existing.value = value;
	} else {
		params.push({ id, value });
	}
}

function deleteParam(params: ModelParameterValue[], id: string): void {
	const index = params.findIndex((param) => param.id === id);
	if (index >= 0) params.splice(index, 1);
}

function applyThinkingLevel(
	metadata: CursorModelMetadata,
	params: ModelParameterValue[],
	level: ModelThinkingLevel,
): void {
	const mapped = metadata.thinkingLevelMap?.[level];
	if (mapped === undefined || mapped === null) return;

	if (level === "off") {
		if (metadata.parameterIds.thinking && mapped === "false") {
			setParam(params, "thinking", mapped);
			deleteParam(params, "effort");
			return;
		}
		if (metadata.parameterIds.reasoning) {
			setParam(params, "reasoning", mapped);
		}
		return;
	}

	if (metadata.parameterIds.effort) {
		if (metadata.parameterIds.thinking) setParam(params, "thinking", "true");
		setParam(params, "effort", mapped);
		return;
	}

	if (metadata.parameterIds.reasoning) {
		setParam(params, "reasoning", mapped);
		return;
	}

	if (metadata.parameterIds.thinking) {
		setParam(params, "thinking", mapped);
	}
}

export function buildCursorModelSelection(
	modelId: string,
	thinkingLevel: ModelThinkingLevel,
	fastEnabled?: boolean,
): ModelSelection {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata) return { id: modelId };

	const params = cloneParams(metadata.defaultParams);
	applyThinkingLevel(metadata, params, thinkingLevel);

	if (metadata.supportsFast && fastEnabled !== undefined) {
		setParam(params, "fast", fastEnabled ? "true" : "false");
	}

	return params.length > 0 ? { id: metadata.baseModelId, params } : { id: metadata.baseModelId };
}

function useFallbackModels(options: DiscoverModelsOptions, issue: CursorModelFallbackIssue): ProviderModelConfig[] {
	options.onFallback?.(issue);
	return registerModelItems(FALLBACK_MODEL_ITEMS);
}

export async function discoverModels(options: DiscoverModelsOptions = {}): Promise<ProviderModelConfig[]> {
	const apiKey = getDiscoveryApiKey();
	if (!apiKey) {
		return useFallbackModels(options, {
			reason: "missing-api-key",
			message:
				"CURSOR_API_KEY or --api-key is required for Cursor model discovery. Using fallback Cursor models for selection only; Cursor runs in this session will fail until pi is restarted with a key.",
		});
	}

	try {
		const models = await Cursor.models.list({ apiKey });
		if (models.length > 0) {
			return registerModelItems(models);
		}
		return useFallbackModels(options, {
			reason: "empty-model-list",
			message:
				"Cursor model discovery returned no models. Using fallback Cursor models for selection only; verify CURSOR_API_KEY or restart pi with --api-key before running Cursor models.",
		});
	} catch {
		return useFallbackModels(options, {
			reason: "discovery-failed",
			message:
				"Cursor model discovery failed. Using fallback Cursor models for selection only; verify CURSOR_API_KEY or restart pi with --api-key before running Cursor models.",
		});
	}
}

export const __testUtils = {
	parseContextWindow,
	registerModelItems,
	getCliApiKeyFromArgv,
};
