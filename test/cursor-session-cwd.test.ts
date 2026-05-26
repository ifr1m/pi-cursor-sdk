import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__testUtils as cursorSessionCwdTestUtils,
	getCursorSessionCwd,
	registerCursorSessionCwd,
} from "../src/cursor-session-cwd.js";
import { createEventHarness } from "./helpers/pi-harness.js";

describe("cursor-session-cwd", () => {
	afterEach(() => {
		cursorSessionCwdTestUtils.reset();
	});

	it("falls back to process.cwd() before session_start", () => {
		expect(getCursorSessionCwd()).toBe(process.cwd());
	});

	it("syncs cwd from session_start", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionCwd(pi);
			await pi.runSessionStart({ cwd: sessionDir });

			expect(getCursorSessionCwd()).toBe(sessionDir);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("updates cwd on subsequent session_start events", async () => {
		const firstDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-a-"));
		const secondDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-b-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionCwd(pi);

			await pi.runSessionStart({ cwd: firstDir });
			expect(getCursorSessionCwd()).toBe(firstDir);

			await pi.runSessionStart({ cwd: secondDir });
			expect(getCursorSessionCwd()).toBe(secondDir);
		} finally {
			rmSync(firstDir, { recursive: true, force: true });
			rmSync(secondDir, { recursive: true, force: true });
		}
	});
});
