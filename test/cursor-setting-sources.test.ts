import { describe, expect, it } from "vitest";
import { resolveCursorSettingSources, CURSOR_SETTING_SOURCES_ENV } from "../src/cursor-setting-sources.js";

describe("resolveCursorSettingSources", () => {
	it("defaults to all when unset", () => {
		expect(resolveCursorSettingSources(undefined)).toEqual(["all"]);
		expect(resolveCursorSettingSources("")).toEqual(["all"]);
	});

	it("maps disable aliases to undefined", () => {
		for (const raw of ["none", "0", "false", "off", "omit", "disabled"]) {
			expect(resolveCursorSettingSources(raw)).toBeUndefined();
		}
	});

	it("maps enable aliases to all", () => {
		for (const raw of ["all", "1", "true", "on"]) {
			expect(resolveCursorSettingSources(raw)).toEqual(["all"]);
		}
	});

	it("parses comma-separated lists", () => {
		expect(resolveCursorSettingSources("project,user")).toEqual(["project", "user"]);
	});

	it("exports the provider env var name", () => {
		expect(CURSOR_SETTING_SOURCES_ENV).toBe("PI_CURSOR_SETTING_SOURCES");
	});
});
