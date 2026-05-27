import { isCursorReplayActivitySourceName, type CursorReplayActivitySourceName } from "./cursor-replay-source-names.js";

/** Replay detail variants keyed by replay card disposition, not SDK source tool alone. */
export type CursorReplayToolDetailsVariant =
	| "nativeEdit"
	| "nativeWrite"
	| "activity"
	| "generateImage"
	| "genericFallback";

/**
 * Sentinel source tool name for activity cards whose SDK name is not a known registry entry.
 * Display identity lives in `title` and replay args.
 */
export const CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME = "unregisteredActivity" as const;

/** SDK source tool names carried on neutral activity replay cards. */
export type CursorReplayActivitySourceToolName =
	| CursorReplayActivitySourceName
	| typeof CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME;

declare const cursorReplayUnknownSourceToolNameBrand: unique symbol;

/** Opaque unknown/future Cursor tool names on generic-fallback replay cards. */
export type CursorReplayUnknownSourceToolName = string & {
	readonly [cursorReplayUnknownSourceToolNameBrand]: unique symbol;
};

export interface CursorReplayNativeEditDetails {
	variant: "nativeEdit";
	path?: string;
	linesAdded?: number;
	linesRemoved?: number;
	diffString?: string;
	diff?: string;
	firstChangedLine?: number;
	summary?: string;
	expandedText?: string;
}

export interface CursorReplayNativeWriteDetails {
	variant: "nativeWrite";
	path?: string;
	linesCreated?: number;
	fileSize?: number;
	fileContentAfterWrite?: string;
	expandedText?: string;
	summary?: string;
}

export interface CursorReplayGenerateImageDetails {
	variant: "generateImage";
	imagePath?: string;
	imageDisplayPath?: string;
	imageMimeType?: string;
	summary?: string;
	expandedText?: string;
	/** Legacy parsed title retained on older payloads; display always uses `Cursor generateImage`. */
	title?: string;
	collapseDetailsByDefault?: boolean;
}

/** Neutral Cursor activity cards and unknown-tool fallbacks with a display title. */
export interface CursorReplayActivityDetails {
	variant: "activity";
	sourceToolName: CursorReplayActivitySourceToolName;
	title: string;
	summary?: string;
	expandedText?: string;
	collapseDetailsByDefault?: boolean;
	path?: string;
	fileSize?: number;
}

/** Parsed replay details without a display title (legacy or malformed payloads). */
export interface CursorReplayGenericFallbackDetails {
	variant: "genericFallback";
	sourceToolName: CursorReplayUnknownSourceToolName;
	summary?: string;
	expandedText?: string;
}

export type CursorReplayToolDetails =
	| CursorReplayNativeEditDetails
	| CursorReplayNativeWriteDetails
	| CursorReplayGenerateImageDetails
	| CursorReplayActivityDetails
	| CursorReplayGenericFallbackDetails;

/** @deprecated Use {@link CursorReplayNativeEditDetails}. */
export type CursorReplayEditDetails = CursorReplayNativeEditDetails;

/** @deprecated Use {@link CursorReplayNativeWriteDetails}. */
export type CursorReplayWriteDetails = CursorReplayNativeWriteDetails;

/** @deprecated Use {@link CursorReplayActivityDetails}. */
export type CursorReplayTitledActivityDetails = CursorReplayActivityDetails;

/** @deprecated Use {@link CursorReplayActivitySourceToolName}. */
export type CursorReplayActivityCursorToolName = CursorReplayActivitySourceToolName;

/** @deprecated Use {@link CursorReplayUnknownSourceToolName}. */
export type CursorReplayUnknownCursorToolName = CursorReplayUnknownSourceToolName;

export type CursorReplayActivityDetailFields = Pick<
	CursorReplayActivityDetails,
	"summary" | "expandedText" | "collapseDetailsByDefault" | "path" | "fileSize"
>;

export type CursorReplayGenerateImageDetailFields = Pick<
	CursorReplayGenerateImageDetails,
	"summary" | "expandedText" | "imagePath" | "imageDisplayPath" | "imageMimeType"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function readCurrentSourceToolName(record: Record<string, unknown>): string | undefined {
	const sourceToolName = readOptionalString(record, "sourceToolName");
	return sourceToolName?.trim() ? sourceToolName.trim() : undefined;
}

function readLegacySourceToolName(record: Record<string, unknown>): string | undefined {
	const sourceToolName = readCurrentSourceToolName(record);
	if (sourceToolName) return sourceToolName;
	const cursorToolName = readOptionalString(record, "cursorToolName");
	return cursorToolName?.trim() ? cursorToolName.trim() : undefined;
}

function readLegacyVariant(record: Record<string, unknown>): string | undefined {
	const variant = readOptionalString(record, "variant");
	return variant?.trim() ? variant.trim() : undefined;
}

function parseCursorReplayNativeEditDetails(record: Record<string, unknown>): CursorReplayNativeEditDetails {
	return {
		variant: "nativeEdit",
		path: readOptionalString(record, "path"),
		linesAdded: readOptionalNumber(record, "linesAdded"),
		linesRemoved: readOptionalNumber(record, "linesRemoved"),
		diffString: readOptionalString(record, "diffString"),
		diff: readOptionalString(record, "diff"),
		firstChangedLine: readOptionalNumber(record, "firstChangedLine"),
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
	};
}

function parseCursorReplayNativeWriteDetails(record: Record<string, unknown>): CursorReplayNativeWriteDetails {
	return {
		variant: "nativeWrite",
		path: readOptionalString(record, "path"),
		linesCreated: readOptionalNumber(record, "linesCreated"),
		fileSize: readOptionalNumber(record, "fileSize"),
		fileContentAfterWrite: readOptionalString(record, "fileContentAfterWrite"),
		expandedText: readOptionalString(record, "expandedText"),
		summary: readOptionalString(record, "summary"),
	};
}

function parseCursorReplayGenerateImageDetails(record: Record<string, unknown>): CursorReplayGenerateImageDetails {
	const title = readOptionalString(record, "title");
	const collapseDetailsByDefault = readOptionalBoolean(record, "collapseDetailsByDefault");
	return {
		variant: "generateImage",
		imagePath: readOptionalString(record, "imagePath"),
		imageDisplayPath: readOptionalString(record, "imageDisplayPath"),
		imageMimeType: readOptionalString(record, "imageMimeType"),
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
		...(title !== undefined ? { title } : {}),
		...(collapseDetailsByDefault !== undefined ? { collapseDetailsByDefault } : {}),
	};
}

function parseCursorReplayActivityDetails(
	record: Record<string, unknown>,
	sourceToolName: CursorReplayActivitySourceToolName,
	title: string,
): CursorReplayActivityDetails {
	return {
		variant: "activity",
		sourceToolName,
		title,
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
		collapseDetailsByDefault: readOptionalBoolean(record, "collapseDetailsByDefault"),
		path: readOptionalString(record, "path"),
		fileSize: readOptionalNumber(record, "fileSize"),
	};
}

function brandCursorReplayUnknownSourceToolName(sourceToolName: string): CursorReplayUnknownSourceToolName {
	return sourceToolName as CursorReplayUnknownSourceToolName;
}

function parseCursorReplayGenericFallbackDetails(
	record: Record<string, unknown>,
	sourceToolName: string,
): CursorReplayGenericFallbackDetails {
	return {
		variant: "genericFallback",
		sourceToolName: brandCursorReplayUnknownSourceToolName(sourceToolName),
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
	};
}

function isCursorReplayActivitySourceToolName(name: string): name is CursorReplayActivitySourceToolName {
	if (name === CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME) return true;
	if (name === "generateImage") return false;
	return isCursorReplayActivitySourceName(name);
}

function resolveParseActivitySourceToolName(sourceToolName: string): CursorReplayActivitySourceToolName {
	return isCursorReplayActivitySourceToolName(sourceToolName)
		? sourceToolName
		: CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME;
}

/** Maps incomplete or non-activity replay source names onto activity-card source tool names. */
export function resolveIncompleteReplayActivitySourceToolName(
	sourceToolName: string,
): CursorReplayActivitySourceToolName {
	if (sourceToolName === "generateImage") return CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME;
	return resolveParseActivitySourceToolName(sourceToolName);
}

function hasNativeEditChanges(record: Record<string, unknown>): boolean {
	return Boolean(
		readOptionalString(record, "diffString")?.trim()
		|| readOptionalString(record, "diff")?.trim()
		|| readOptionalNumber(record, "linesAdded")
		|| readOptionalNumber(record, "linesRemoved"),
	);
}

function parseLegacyEditDetails(record: Record<string, unknown>): CursorReplayToolDetails {
	const title = readOptionalString(record, "title")?.trim();
	if (title) {
		return parseCursorReplayActivityDetails(record, resolveParseActivitySourceToolName("edit"), title);
	}
	return parseCursorReplayNativeEditDetails(record);
}

function parseLegacyWriteDetails(record: Record<string, unknown>): CursorReplayToolDetails {
	const title = readOptionalString(record, "title")?.trim();
	if (title) {
		return parseCursorReplayActivityDetails(record, resolveParseActivitySourceToolName("write"), title);
	}
	return parseCursorReplayNativeWriteDetails(record);
}

type CursorReplayVariantParser = (record: Record<string, unknown>) => CursorReplayToolDetails | undefined;

function parseActivityVariantDetails(
	record: Record<string, unknown>,
	readSourceToolName: (record: Record<string, unknown>) => string | undefined,
): CursorReplayActivityDetails | undefined {
	const title = readOptionalString(record, "title")?.trim();
	if (!title) return undefined;
	return parseCursorReplayActivityDetails(
		record,
		resolveParseActivitySourceToolName(readSourceToolName(record) ?? CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME),
		title,
	);
}

const CURRENT_REPLAY_VARIANT_PARSERS: Readonly<Record<CursorReplayToolDetailsVariant, CursorReplayVariantParser>> = {
	nativeEdit: parseCursorReplayNativeEditDetails,
	nativeWrite: parseCursorReplayNativeWriteDetails,
	generateImage: parseCursorReplayGenerateImageDetails,
	activity: (record) => {
		if (!readCurrentSourceToolName(record) && readOptionalString(record, "cursorToolName")?.trim()) return undefined;
		return parseActivityVariantDetails(record, readCurrentSourceToolName);
	},
	genericFallback: (record) => parseCursorReplayGenericFallbackDetails(record, readCurrentSourceToolName(record) ?? "tool"),
};

const LEGACY_REPLAY_VARIANT_UPGRADERS: Readonly<Record<string, CursorReplayVariantParser>> = {
	edit: parseLegacyEditDetails,
	write: parseLegacyWriteDetails,
	titledActivity: (record) => parseActivityVariantDetails(record, readLegacySourceToolName),
};

export function parseStrictCurrentCursorReplayToolDetails(value: unknown): CursorReplayToolDetails | undefined {
	if (!isRecord(value)) return undefined;
	const variant = readLegacyVariant(value);
	if (!variant) return undefined;
	return CURRENT_REPLAY_VARIANT_PARSERS[variant as CursorReplayToolDetailsVariant]?.(value);
}

export function upgradeLegacyCursorReplayToolDetails(value: unknown): CursorReplayToolDetails | undefined {
	if (!isRecord(value)) return undefined;
	const explicitVariant = readLegacyVariant(value);
	if (explicitVariant) {
		return LEGACY_REPLAY_VARIANT_UPGRADERS[explicitVariant]?.(value);
	}
	const sourceToolName = readLegacySourceToolName(value);
	if (sourceToolName === "edit") return parseLegacyEditDetails(value);
	if (sourceToolName === "write") return parseLegacyWriteDetails(value);
	if (sourceToolName === "generateImage") return parseCursorReplayGenerateImageDetails(value);
	const title = readOptionalString(value, "title")?.trim();
	if (title) {
		return parseCursorReplayActivityDetails(
			value,
			resolveParseActivitySourceToolName(sourceToolName ?? CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME),
			title,
		);
	}
	if (sourceToolName === undefined && hasNativeEditChanges(value)) {
		return parseCursorReplayNativeEditDetails(value);
	}
	return undefined;
}

export function parseCursorReplayToolDetails(value: unknown): CursorReplayToolDetails | undefined {
	return parseStrictCurrentCursorReplayToolDetails(value) ?? upgradeLegacyCursorReplayToolDetails(value);
}

/** @deprecated Prefer {@link parseCursorReplayToolDetails} for validated narrowing. */
export const asCursorReplayToolDetails = parseCursorReplayToolDetails;

export function buildCursorReplayNativeEditDetails(
	fields: Omit<CursorReplayNativeEditDetails, "variant">,
): CursorReplayNativeEditDetails {
	return { variant: "nativeEdit", ...fields };
}

/** @deprecated Prefer {@link buildCursorReplayNativeEditDetails}. */
export const buildCursorReplayEditDetails = buildCursorReplayNativeEditDetails;

export function buildCursorReplayNativeWriteDetails(
	fields: Omit<CursorReplayNativeWriteDetails, "variant">,
): CursorReplayNativeWriteDetails {
	return { variant: "nativeWrite", ...fields };
}

/** @deprecated Prefer {@link buildCursorReplayNativeWriteDetails}. */
export const buildCursorReplayWriteDetails = buildCursorReplayNativeWriteDetails;

export function assembleCursorReplayActivityDetails(
	sourceToolName: CursorReplayActivitySourceToolName,
	title: string,
	fields: CursorReplayActivityDetailFields,
	contentText: string,
	isError: boolean,
	activitySummary: string | undefined,
): CursorReplayActivityDetails {
	const summary = isError ? fields.summary : (fields.summary ?? activitySummary);
	return {
		variant: "activity",
		sourceToolName,
		title,
		summary,
		expandedText: fields.expandedText ?? contentText,
		...(fields.collapseDetailsByDefault !== undefined ? { collapseDetailsByDefault: fields.collapseDetailsByDefault } : {}),
		...(fields.path !== undefined ? { path: fields.path } : {}),
		...(fields.fileSize !== undefined ? { fileSize: fields.fileSize } : {}),
	};
}

/** @deprecated Prefer {@link assembleCursorReplayActivityDetails}. */
export const assembleCursorReplayTitledActivityDetails = assembleCursorReplayActivityDetails;

export const CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE = "Cursor generateImage" as const;

export function assembleCursorReplayGenerateImageDetails(
	fields: CursorReplayGenerateImageDetailFields,
	contentText: string,
	isError: boolean,
	activitySummary: string | undefined,
): CursorReplayGenerateImageDetails {
	const summary = isError ? fields.summary : (fields.summary ?? activitySummary);
	return {
		variant: "generateImage",
		imagePath: fields.imagePath,
		imageDisplayPath: fields.imageDisplayPath,
		imageMimeType: fields.imageMimeType,
		summary,
		expandedText: fields.expandedText ?? contentText,
	};
}

export function isCursorReplayNativeEditDetails(
	details: CursorReplayToolDetails,
): details is CursorReplayNativeEditDetails {
	return details.variant === "nativeEdit";
}

/** @deprecated Prefer {@link isCursorReplayNativeEditDetails}. */
export const isCursorReplayEditDetails = isCursorReplayNativeEditDetails;

export function isCursorReplayNativeWriteDetails(
	details: CursorReplayToolDetails,
): details is CursorReplayNativeWriteDetails {
	return details.variant === "nativeWrite";
}

/** @deprecated Prefer {@link isCursorReplayNativeWriteDetails}. */
export const isCursorReplayWriteDetails = isCursorReplayNativeWriteDetails;

export function isCursorReplayGenerateImageDetails(
	details: CursorReplayToolDetails,
): details is CursorReplayGenerateImageDetails {
	return details.variant === "generateImage";
}

export function isCursorReplayActivityDetails(
	details: CursorReplayToolDetails,
): details is CursorReplayActivityDetails {
	return details.variant === "activity";
}

/** @deprecated Prefer {@link isCursorReplayActivityDetails}. */
export const isCursorReplayTitledActivityDetails = isCursorReplayActivityDetails;

export function isCursorReplayGenericFallbackDetails(
	details: CursorReplayToolDetails,
): details is CursorReplayGenericFallbackDetails {
	return details.variant === "genericFallback";
}
