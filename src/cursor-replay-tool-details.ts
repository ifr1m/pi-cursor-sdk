import {
	CURSOR_KNOWN_NORMALIZED_TOOL_NAMES,
	type CursorNormalizedToolName,
} from "./cursor-tool-presentation-registry.js";

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
	| Exclude<CursorNormalizedToolName, "generateImage">
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
> &
	Pick<CursorReplayGenerateImageDetails, "imagePath" | "imageDisplayPath" | "imageMimeType">;

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

function readLegacySourceToolName(record: Record<string, unknown>): string | undefined {
	const sourceToolName = readOptionalString(record, "sourceToolName");
	if (sourceToolName?.trim()) return sourceToolName.trim();
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

function isCursorReplayUnknownSourceToolName(sourceToolName: string): boolean {
	if (sourceToolName === CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME) return false;
	return !(CURSOR_KNOWN_NORMALIZED_TOOL_NAMES as readonly string[]).includes(sourceToolName);
}

function brandCursorReplayUnknownSourceToolName(sourceToolName: string): CursorReplayUnknownSourceToolName {
	return sourceToolName as CursorReplayUnknownSourceToolName;
}

function parseKnownMalformedGenericFallbackDetails(
	record: Record<string, unknown>,
	sourceToolName: string,
): CursorReplayToolDetails {
	if (sourceToolName === "edit") return parseLegacyEditDetails(record);
	if (sourceToolName === "write") return parseLegacyWriteDetails(record);
	if (sourceToolName === "generateImage") return parseCursorReplayGenerateImageDetails(record);
	const title = readOptionalString(record, "title")?.trim() ?? `Cursor ${sourceToolName}`;
	return parseCursorReplayActivityDetails(
		record,
		resolveParseActivitySourceToolName(sourceToolName),
		title,
	);
}

function parseCursorReplayGenericFallbackDetails(
	record: Record<string, unknown>,
	sourceToolName: string,
): CursorReplayToolDetails {
	if (!isCursorReplayUnknownSourceToolName(sourceToolName)) {
		return parseKnownMalformedGenericFallbackDetails(record, sourceToolName);
	}
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
	return (CURSOR_KNOWN_NORMALIZED_TOOL_NAMES as readonly string[]).includes(name);
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

function parseByVariant(record: Record<string, unknown>, variant: string): CursorReplayToolDetails | undefined {
	switch (variant) {
		case "nativeEdit":
			return parseCursorReplayNativeEditDetails(record);
		case "edit":
			return parseLegacyEditDetails(record);
		case "nativeWrite":
			return parseCursorReplayNativeWriteDetails(record);
		case "write":
			return parseLegacyWriteDetails(record);
		case "generateImage":
			return parseCursorReplayGenerateImageDetails(record);
		case "activity":
		case "titledActivity": {
			const title = readOptionalString(record, "title")?.trim();
			if (!title) return parseCursorReplayGenericFallbackDetails(record, readLegacySourceToolName(record) ?? "tool");
			return parseCursorReplayActivityDetails(
				record,
				resolveParseActivitySourceToolName(readLegacySourceToolName(record) ?? CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME),
				title,
			);
		}
		case "genericFallback":
			return parseCursorReplayGenericFallbackDetails(record, readLegacySourceToolName(record) ?? "tool");
		default:
			return undefined;
	}
}

export function parseCursorReplayToolDetails(value: unknown): CursorReplayToolDetails | undefined {
	if (!isRecord(value)) return undefined;
	const explicitVariant = readLegacyVariant(value);
	if (explicitVariant) {
		const parsed = parseByVariant(value, explicitVariant);
		if (parsed) return parsed;
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
	if (sourceToolName === "edit" || (sourceToolName === undefined && hasNativeEditChanges(value))) {
		return parseCursorReplayNativeEditDetails(value);
	}
	return parseCursorReplayGenericFallbackDetails(value, sourceToolName ?? "tool");
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

export type CursorReplayActivityResultSourceToolName =
	| Exclude<CursorReplayActivitySourceToolName, "edit" | "write">
	| "generateImage";

/** @deprecated Prefer {@link CursorReplayActivityResultSourceToolName}. */
export type CursorReplayActivityResultCursorToolName = CursorReplayActivityResultSourceToolName;

export function assembleCursorReplayActivityResultDetails(
	sourceToolName: CursorReplayActivityResultSourceToolName,
	title: string,
	fields: CursorReplayActivityDetailFields,
	contentText: string,
	isError: boolean,
	activitySummary: string | undefined,
): CursorReplayActivityDetails | CursorReplayGenerateImageDetails {
	if (sourceToolName === "generateImage") {
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
	return assembleCursorReplayActivityDetails(
		sourceToolName,
		title,
		fields,
		contentText,
		isError,
		activitySummary,
	);
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
