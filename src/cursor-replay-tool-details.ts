import type { CursorNormalizedToolName } from "./cursor-tool-presentation-registry.js";

export interface CursorReplayEditDetails {
	cursorToolName: "edit";
	path?: string;
	linesAdded?: number;
	linesRemoved?: number;
	diffString?: string;
	diff?: string;
	firstChangedLine?: number;
	title?: string;
	summary?: string;
	expandedText?: string;
}

export interface CursorReplayWriteDetails {
	cursorToolName: "write";
	path?: string;
	linesCreated?: number;
	fileSize?: number;
	fileContentAfterWrite?: string;
	expandedText?: string;
	title?: string;
	summary?: string;
}

export interface CursorReplayGenerateImageDetails {
	cursorToolName: "generateImage";
	imagePath?: string;
	imageDisplayPath?: string;
	imageMimeType?: string;
	summary?: string;
	expandedText?: string;
	title?: string;
	collapseDetailsByDefault?: boolean;
}

/** Neutral Cursor activity cards and unknown-tool fallbacks with a display title. */
export interface CursorReplayTitledActivityDetails {
	cursorToolName: string;
	title: string;
	summary?: string;
	expandedText?: string;
	collapseDetailsByDefault?: boolean;
	path?: string;
	fileSize?: number;
}

/** Parsed replay details without a display title (legacy or malformed payloads). */
export interface CursorReplayGenericFallbackDetails {
	cursorToolName: string;
	summary?: string;
	expandedText?: string;
}

export type CursorReplayToolDetails =
	| CursorReplayEditDetails
	| CursorReplayWriteDetails
	| CursorReplayGenerateImageDetails
	| CursorReplayTitledActivityDetails
	| CursorReplayGenericFallbackDetails;

export type CursorReplayActivityDetailFields = Pick<
	CursorReplayTitledActivityDetails,
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

function readCursorToolName(record: Record<string, unknown>): string | undefined {
	const value = record.cursorToolName;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function parseCursorReplayEditDetails(record: Record<string, unknown>): CursorReplayEditDetails {
	return {
		cursorToolName: "edit",
		path: readOptionalString(record, "path"),
		linesAdded: readOptionalNumber(record, "linesAdded"),
		linesRemoved: readOptionalNumber(record, "linesRemoved"),
		diffString: readOptionalString(record, "diffString"),
		diff: readOptionalString(record, "diff"),
		firstChangedLine: readOptionalNumber(record, "firstChangedLine"),
		title: readOptionalString(record, "title"),
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
	};
}

function parseCursorReplayWriteDetails(record: Record<string, unknown>): CursorReplayWriteDetails {
	return {
		cursorToolName: "write",
		path: readOptionalString(record, "path"),
		linesCreated: readOptionalNumber(record, "linesCreated"),
		fileSize: readOptionalNumber(record, "fileSize"),
		fileContentAfterWrite: readOptionalString(record, "fileContentAfterWrite"),
		expandedText: readOptionalString(record, "expandedText"),
		title: readOptionalString(record, "title"),
		summary: readOptionalString(record, "summary"),
	};
}

function parseCursorReplayGenerateImageDetails(record: Record<string, unknown>): CursorReplayGenerateImageDetails {
	return {
		cursorToolName: "generateImage",
		imagePath: readOptionalString(record, "imagePath"),
		imageDisplayPath: readOptionalString(record, "imageDisplayPath"),
		imageMimeType: readOptionalString(record, "imageMimeType"),
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
		title: readOptionalString(record, "title"),
		collapseDetailsByDefault: readOptionalBoolean(record, "collapseDetailsByDefault"),
	};
}

function parseCursorReplayTitledActivityDetails(
	record: Record<string, unknown>,
	cursorToolName: string,
	title: string,
): CursorReplayTitledActivityDetails {
	return {
		cursorToolName,
		title,
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
		collapseDetailsByDefault: readOptionalBoolean(record, "collapseDetailsByDefault"),
		path: readOptionalString(record, "path"),
		fileSize: readOptionalNumber(record, "fileSize"),
	};
}

function parseCursorReplayGenericFallbackDetails(
	record: Record<string, unknown>,
	cursorToolName: string,
): CursorReplayGenericFallbackDetails {
	return {
		cursorToolName,
		summary: readOptionalString(record, "summary"),
		expandedText: readOptionalString(record, "expandedText"),
	};
}

export function parseCursorReplayToolDetails(value: unknown): CursorReplayToolDetails | undefined {
	if (!isRecord(value)) return undefined;
	const cursorToolName = readCursorToolName(value);
	if (cursorToolName === "edit") return parseCursorReplayEditDetails(value);
	if (cursorToolName === "write") return parseCursorReplayWriteDetails(value);
	if (cursorToolName === "generateImage") return parseCursorReplayGenerateImageDetails(value);
	const title = readOptionalString(value, "title")?.trim();
	if (title) {
		return parseCursorReplayTitledActivityDetails(value, cursorToolName ?? "activity", title);
	}
	return parseCursorReplayGenericFallbackDetails(value, cursorToolName ?? "tool");
}

/** @deprecated Prefer {@link parseCursorReplayToolDetails} for validated narrowing. */
export const asCursorReplayToolDetails = parseCursorReplayToolDetails;

export function buildCursorReplayEditDetails(
	fields: Omit<CursorReplayEditDetails, "cursorToolName">,
): CursorReplayEditDetails {
	return { cursorToolName: "edit", ...fields };
}

export function buildCursorReplayWriteDetails(
	fields: Omit<CursorReplayWriteDetails, "cursorToolName">,
): CursorReplayWriteDetails {
	return { cursorToolName: "write", ...fields };
}

export function assembleCursorReplayTitledActivityDetails(
	cursorToolName: CursorNormalizedToolName | string,
	title: string,
	fields: CursorReplayActivityDetailFields,
	contentText: string,
	isError: boolean,
	activitySummary: string | undefined,
): CursorReplayTitledActivityDetails {
	const summary = isError ? fields.summary : (fields.summary ?? activitySummary);
	return {
		cursorToolName,
		title,
		summary,
		expandedText: fields.expandedText ?? contentText,
		...(fields.collapseDetailsByDefault !== undefined ? { collapseDetailsByDefault: fields.collapseDetailsByDefault } : {}),
		...(fields.path !== undefined ? { path: fields.path } : {}),
		...(fields.fileSize !== undefined ? { fileSize: fields.fileSize } : {}),
	};
}

export function assembleCursorReplayActivityResultDetails(
	cursorToolName: CursorNormalizedToolName | string,
	title: string,
	fields: CursorReplayActivityDetailFields,
	contentText: string,
	isError: boolean,
	activitySummary: string | undefined,
): CursorReplayTitledActivityDetails | CursorReplayGenerateImageDetails {
	if (cursorToolName === "generateImage") {
		const summary = isError ? fields.summary : (fields.summary ?? activitySummary);
		return {
			cursorToolName: "generateImage",
			imagePath: fields.imagePath,
			imageDisplayPath: fields.imageDisplayPath,
			imageMimeType: fields.imageMimeType,
			title,
			summary,
			expandedText: fields.expandedText ?? contentText,
		};
	}
	return assembleCursorReplayTitledActivityDetails(cursorToolName, title, fields, contentText, isError, activitySummary);
}

export function isCursorReplayEditDetails(details: CursorReplayToolDetails): details is CursorReplayEditDetails {
	return details.cursorToolName === "edit";
}

export function isCursorReplayWriteDetails(details: CursorReplayToolDetails): details is CursorReplayWriteDetails {
	return details.cursorToolName === "write";
}

export function isCursorReplayGenerateImageDetails(
	details: CursorReplayToolDetails,
): details is CursorReplayGenerateImageDetails {
	return details.cursorToolName === "generateImage";
}

export function isCursorReplayTitledActivityDetails(
	details: CursorReplayToolDetails,
): details is CursorReplayTitledActivityDetails {
	return "title" in details && typeof details.title === "string" && details.title.length > 0;
}
