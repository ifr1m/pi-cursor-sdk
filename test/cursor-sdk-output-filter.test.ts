import { describe, expect, it } from "vitest";
import { CURSOR_SDK_STARTUP_NOISE_PATTERNS, isCursorSdkStartupNoise } from "../src/cursor-sdk-output-filter.js";

describe("isCursorSdkStartupNoise", () => {
	it.each(CURSOR_SDK_STARTUP_NOISE_PATTERNS)("filters startup noise containing %j", (pattern) => {
		expect(isCursorSdkStartupNoise(`prefix ${pattern} suffix`)).toBe(true);
	});

	it("filters [hooks] noise like provider integration tests", () => {
		expect(
			isCursorSdkStartupNoise(
				'[hooks] SessionStart trigger matcher "startup" is not supported in Cursor, hooks will fire for all triggers',
			),
		).toBe(true);
	});

	it("filters ignore-mapping initialization errors", () => {
		expect(
			isCursorSdkStartupNoise("Error initializing ignore mapping for /Users/dev/project: permission denied"),
		).toBe(true);
	});

	it("filters ripgrep path configuration warnings", () => {
		expect(
			isCursorSdkStartupNoise("Ripgrep path not configured. Call configureRipgrepPath() at startup."),
		).toBe(true);
	});

	it("does not filter unrelated provider output", () => {
		expect(isCursorSdkStartupNoise("VISIBLE non-startup stdout")).toBe(false);
		expect(isCursorSdkStartupNoise("Agent finished successfully")).toBe(false);
	});
});
