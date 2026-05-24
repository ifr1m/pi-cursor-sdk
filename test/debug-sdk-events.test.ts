import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSummary, parseDebugSdkEventsArgs } from "../scripts/debug-sdk-events.mjs";

const scriptPath = "scripts/debug-sdk-events.mjs";

function run(args: string[], env: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

function collectStrings(value: unknown, strings: string[] = []): string[] {
	if (typeof value === "string") {
		strings.push(value);
		return strings;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectStrings(entry, strings);
		return strings;
	}
	if (value && typeof value === "object") {
		for (const entry of Object.values(value)) collectStrings(entry, strings);
	}
	return strings;
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

	it("builds stdout-safe summaries without raw SDK payloads", () => {
		const artifactDir = "/tmp/pi-cursor-sdk-sdk-events-test";
		const summary = buildSummary({
			artifactDir,
			streamEvents: [
				{
					ts: "2026-05-24T00:00:00.000Z",
					elapsedMs: 0,
					event: { type: "assistant", message: { content: [{ type: "text", text: "secret payload" }] } },
				},
			],
			deltaEvents: [{ ts: "2026-05-24T00:00:00.100Z", elapsedMs: 100, update: { type: "text-delta", text: "delta" } }],
			stepEvents: [{ ts: "2026-05-24T00:00:00.200Z", elapsedMs: 200, step: { type: "toolCall", message: { name: "read" } } }],
			waitResult: { status: "finished", durationMs: 250, result: "done" },
			conversation: [{ role: "user", content: "hello" }],
			includeConversation: true,
		});

		expect(summary.counts).toEqual({
			stream: { assistant: 1 },
			onDelta: { "text-delta": 1 },
			onStep: { toolCall: 1 },
		});
		expect(summary.wait).toEqual({ status: "finished", durationMs: 250, hasResultText: true });
		expect(summary.conversation).toEqual({ turnCount: 1 });
		expect(summary.files.streamEvents).toBe(`${artifactDir}/stream-events.jsonl`);

		const stdoutPayload = JSON.stringify(summary);
		expect(stdoutPayload).not.toContain("secret payload");
		expect(stdoutPayload).not.toContain('"text": "delta"');
		expect(collectStrings(summary)).not.toContain("hello");
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
