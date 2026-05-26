import { describe, expect, it } from "vitest";
import {
	buildCursorPiToolDisplayFromSpec,
	type ToolDisplayContext,
} from "../src/cursor-transcript-tool-specs.js";
import {
	CURSOR_KNOWN_NORMALIZED_TOOL_NAMES,
	CURSOR_REPLAY_ACTIVITY_LABEL_KEYS_BY_TOOL_NAME,
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	CURSOR_REPLAY_LEGACY_TOOL_NAMES,
	CURSOR_TOOL_PRESENTATION_SPECS,
	classifyCursorWebToolKind,
	getCursorReplayActivityTitle,
	getCursorReplaySummaryKind,
	getCursorToolLifecycleLabelKind,
	getCursorToolPresentationSpec,
	getCursorToolVisibilityPolicy,
	isExcludedFromCursorBridgeExposure,
	normalizeCursorToolName,
	type CursorNormalizedToolName,
	type CursorReplayLegacyToolName,
} from "../src/cursor-tool-presentation-registry.js";
import { classifyCursorToolVisibility } from "../src/cursor-tool-visibility.js";
import { normalizeToolName } from "../src/cursor-transcript-utils.js";

const TRANSCRIPT_SPEC_KEYS = [
	"read",
	"shell",
	"grep",
	"glob",
	"ls",
	"edit",
	"write",
	"delete",
	"readLints",
	"updateTodos",
	"createPlan",
	"task",
	"generateImage",
	"mcp",
	"semSearch",
	"recordScreen",
	"webSearch",
	"webFetch",
] as const satisfies readonly CursorNormalizedToolName[];

describe("cursor tool presentation registry", () => {
	it("lists every known normalized tool exactly once", () => {
		expect(CURSOR_KNOWN_NORMALIZED_TOOL_NAMES).toHaveLength(CURSOR_TOOL_PRESENTATION_SPECS.length);
		expect(new Set(CURSOR_KNOWN_NORMALIZED_TOOL_NAMES).size).toBe(CURSOR_TOOL_PRESENTATION_SPECS.length);
	});

	it("covers transcript display spec keys", () => {
		for (const key of TRANSCRIPT_SPEC_KEYS) {
			expect(getCursorToolPresentationSpec(key)?.normalizedName).toBe(key);
		}
	});

	it("maps legacy replay tool names and bridge exclusion from the registry", () => {
		const legacyNamesFromSpecs = CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) =>
			spec.replayLegacyName ? [spec.replayLegacyName] : [],
		);
		expect(new Set(CURSOR_REPLAY_LEGACY_TOOL_NAMES)).toEqual(new Set(legacyNamesFromSpecs));
		expect(CURSOR_REPLAY_LEGACY_TOOL_NAMES).toHaveLength(legacyNamesFromSpecs.length);
		for (const legacyName of CURSOR_REPLAY_LEGACY_TOOL_NAMES) {
			const spec = getCursorToolPresentationSpec(legacyName);
			expect(spec?.replayLegacyName).toBe(legacyName);
			expect(isExcludedFromCursorBridgeExposure(legacyName)).toBe(true);
		}
		expect(isExcludedFromCursorBridgeExposure(CURSOR_REPLAY_ACTIVITY_TOOL_NAME)).toBe(true);
		expect(isExcludedFromCursorBridgeExposure("read")).toBe(false);
	});

	it("derives replay activity label keys from normalized names", () => {
		for (const [normalizedName, legacyName] of Object.entries(CURSOR_REPLAY_ACTIVITY_LABEL_KEYS_BY_TOOL_NAME)) {
			expect(getCursorToolPresentationSpec(normalizedName)?.replayLegacyName).toBe(legacyName);
		}
	});

	it("normalizes aliases from the registry", () => {
		expect(normalizeCursorToolName("read_file")).toBe("read");
		expect(normalizeCursorToolName("run_terminal_cmd")).toBe("shell");
		expect(normalizeCursorToolName("web_search")).toBe("webSearch");
		expect(normalizeToolName("str_replace")).toBe("edit");
	});

	it("classifies web tools from registry patterns", () => {
		expect(classifyCursorWebToolKind("web-search")).toBe("webSearch");
		expect(classifyCursorWebToolKind("cursor_web_fetch")).toBe("webFetch");
		expect(classifyCursorWebToolKind("grep")).toBeUndefined();
	});

	it("exposes visibility and lifecycle policy for every registry entry", () => {
		for (const spec of CURSOR_TOOL_PRESENTATION_SPECS) {
			const key = spec.normalizedName.toLowerCase();
			expect(getCursorToolVisibilityPolicy(key)).toEqual(spec.visibility);
			if (spec.lifecycleLabelKind) {
				expect(getCursorToolLifecycleLabelKind(key)).toBe(spec.lifecycleLabelKind);
			}
		}
	});

	it("aligns replay activity titles with visibility classification", () => {
		for (const spec of CURSOR_TOOL_PRESENTATION_SPECS) {
			if (!spec.replayLegacyName) continue;
			const title = getCursorReplayActivityTitle(spec.normalizedName);
			expect(title).toBe(spec.displayLabel);
			expect(classifyCursorToolVisibility({ name: spec.normalizedName }).activityTitle).toBe(title);
		}
	});

	it("assigns replay summary kinds for every legacy replay tool", () => {
		for (const legacyName of CURSOR_REPLAY_LEGACY_TOOL_NAMES) {
			expect(getCursorReplaySummaryKind(legacyName as CursorReplayLegacyToolName)).toBeDefined();
		}
		expect(getCursorReplaySummaryKind(CURSOR_REPLAY_ACTIVITY_TOOL_NAME)).toBe("activity_generic");
	});

	it("builds transcript displays for every registry-backed spec key", () => {
		const context: ToolDisplayContext = {
			rawName: "read",
			name: "read",
			args: { path: "src/index.ts" },
			result: { status: "success", value: { content: "ok" }, error: undefined },
			options: {},
		};
		for (const key of TRANSCRIPT_SPEC_KEYS) {
			expect(() =>
				buildCursorPiToolDisplayFromSpec({
					...context,
					rawName: key,
					name: key,
				}),
			).not.toThrow();
		}
	});
});
