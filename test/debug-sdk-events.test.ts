import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseDebugSdkEventsArgs } from "../scripts/debug-sdk-events.mjs";

const scriptPath = "scripts/debug-sdk-events.mjs";

function run(args: string[], env: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

describe("debug-sdk-events maintainer probe", () => {
	it("parses args and setting source overrides", () => {
		expect(
			parseDebugSdkEventsArgs(["--cwd", "/tmp/work", "--model", "composer-2.5", "--prompt", "hello"], {
				CURSOR_API_KEY: "key",
				PI_CURSOR_SETTING_SOURCES: "all",
			}),
		).toMatchObject({
			cwd: "/tmp/work",
			model: "composer-2.5",
			prompt: "hello",
			apiKey: "key",
			settingSources: ["all"],
		});

		expect(
			parseDebugSdkEventsArgs(["--setting-sources", "project,user", "--prompt", "x"], {
				PI_CURSOR_SETTING_SOURCES: "all",
			}),
		).toMatchObject({
			settingSources: ["project", "user"],
		});

		expect(parseDebugSdkEventsArgs(["--setting-sources", "none", "--prompt", "x"], {})).toMatchObject({
			settingSources: undefined,
		});
	});

	it("shows help and validates script syntax without live Cursor auth", () => {
		expect(spawnSync(process.execPath, ["--check", scriptPath], { cwd: process.cwd(), encoding: "utf8" }).status).toBe(0);

		const help = run(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Capture timestamped Cursor SDK event timelines");
		expect(help.stdout).toContain("run.stream()");
		expect(help.stdout).toContain("onDelta");
		expect(help.stdout).toContain("onStep");
		expect(help.stdout).toContain("https://cursor.com/docs/sdk/typescript");
	});

	it("fails fast on missing prompt and missing api key without printing secrets", () => {
		const leakedKey = "super-secret-cursor-key-12345";

		const missingPrompt = run(["--api-key", leakedKey], { CURSOR_API_KEY: undefined });
		expect(missingPrompt.status).toBe(1);
		expect(missingPrompt.stderr).toContain("--prompt is required");
		expect(`${missingPrompt.stdout}${missingPrompt.stderr}`).not.toContain(leakedKey);

		const missingKey = run(["--prompt", "hello"], { CURSOR_API_KEY: undefined });
		expect(missingKey.status).toBe(1);
		expect(missingKey.stderr).toContain("Cursor API key is required");
		expect(`${missingKey.stdout}${missingKey.stderr}`).not.toContain("hello");
	});
});
