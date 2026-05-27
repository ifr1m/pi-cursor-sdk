import { describe, expect, it, vi } from "vitest";
import { resolveCursorSettingSources as resolveProviderSettingSources } from "../src/cursor-setting-sources.js";
import {
	commonProbeFlags,
	apiKeySecretsFromProcess,
	defaultApiKeyFromEnv,
	defaultSettingSourcesFromEnv,
	defaultTimestampedDir,
	parseArgv,
	readArgvApiKey,
	requireApiKey,
} from "../scripts/lib/cursor-cli-args.mjs";
import { parseJsonLines, terminateChild, waitForChildClose } from "../scripts/lib/cursor-child-process.mjs";
import {
	CURSOR_SETTING_SOURCES_ENV as sharedSettingSourcesEnv,
	resolveCursorSettingSources as resolveSharedSettingSources,
	serializeCursorSettingSources as serializeSharedSettingSources,
} from "../shared/cursor-setting-sources.mjs";
import { scrubSensitiveText as scrubSharedSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import {
	CURSOR_SETTING_SOURCES_ENV,
	resolveCursorSettingSources,
	serializeCursorSettingSources,
} from "../shared/cursor-setting-sources.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import { createScriptFail } from "../scripts/lib/cursor-script-fail.mjs";

describe("maintainer scripts shared lib", () => {
	it("keeps shared helpers aligned with script re-exports and provider runtime", () => {
		expect(sharedSettingSourcesEnv).toBe(CURSOR_SETTING_SOURCES_ENV);
		for (const raw of [undefined, "", "all", "none", "project,user", "OFF", "0"]) {
			expect(resolveSharedSettingSources(raw)).toEqual(resolveCursorSettingSources(raw));
			expect(resolveSharedSettingSources(raw)).toEqual(resolveProviderSettingSources(raw));
		}
		const leakedKey = "super-secret-cursor-key-12345";
		const sample = `Bearer ${leakedKey} http://127.0.0.1:4242/cursor-pi-tool-bridge/abc/mcp`;
		expect(scrubSharedSensitiveText(sample, leakedKey)).toBe(scrubSensitiveText(sample, leakedKey));
		expect(serializeSharedSettingSources(["project", "user"])).toBe(serializeCursorSettingSources(["project", "user"]));
	});

	it("keeps setting-source parsing aligned with provider runtime", () => {
		expect(CURSOR_SETTING_SOURCES_ENV).toBe("PI_CURSOR_SETTING_SOURCES");
		for (const raw of [undefined, "", "all", "none", "project,user", "OFF", "0"]) {
			expect(resolveCursorSettingSources(raw)).toEqual(resolveProviderSettingSources(raw));
		}
		expect(defaultSettingSourcesFromEnv({ PI_CURSOR_SETTING_SOURCES: "none" })).toBeUndefined();
	});

	it("scrubs secrets and bridge endpoints", () => {
		const leakedKey = "super-secret-cursor-key-12345";
		const sample = `Bearer ${leakedKey} http://127.0.0.1:4242/cursor-pi-tool-bridge/abc/mcp`;
		const scrubbed = scrubSensitiveText(sample, leakedKey);
		expect(scrubbed).not.toContain(leakedKey);
		expect(scrubbed).toContain("Bearer [redacted]");
		expect(scrubbed).toContain("[redacted-bridge-endpoint]");
	});

	it("serializes setting sources for child env forwarding", () => {
		expect(serializeCursorSettingSources(["all"])).toBe("all");
		expect(serializeCursorSettingSources(["project", "user"])).toBe("project,user");
		expect(serializeCursorSettingSources(undefined)).toBe("none");
		expect(serializeCursorSettingSources([])).toBe("none");
	});

	it("round-trips setting sources through resolve -> serialize -> resolve", () => {
		const cases: Array<{ raw?: string; expected: ReturnType<typeof resolveCursorSettingSources> }> = [
			{ raw: undefined, expected: ["all"] },
			{ raw: "", expected: ["all"] },
			{ raw: "all", expected: ["all"] },
			{ raw: "none", expected: undefined },
			{ raw: "project,user", expected: ["project", "user"] },
			{ raw: ",", expected: undefined },
			{ raw: "  ,  ", expected: undefined },
		];
		for (const { raw, expected } of cases) {
			const resolved = resolveCursorSettingSources(raw);
			expect(resolved).toEqual(expected);
			expect(resolveCursorSettingSources(serializeCursorSettingSources(resolved))).toEqual(expected);
		}
	});

	it("reads api keys from argv and process env for failure scrubbing", () => {
		expect(readArgvApiKey(["--api-key", " argv-key "])).toBe("argv-key");
		expect(readArgvApiKey(["--api-key=inline-key"])).toBe("inline-key");
		expect(readArgvApiKey(["--model", "composer-2.5"])).toBeUndefined();
		expect(apiKeySecretsFromProcess(["--api-key", "argv-key"], { CURSOR_API_KEY: "env-key" })).toEqual([
			"env-key",
			"argv-key",
		]);
	});

	it("parses common probe flags and enforces api key requirements", () => {
		const fail = vi.fn((message: string) => {
			throw new Error(message);
		});
		const args = parseArgv(["--cwd", "/tmp/work", "--model", "composer-2.5", "--prompt", "hi", "--setting-sources", "none"], {
			defaults: {
				cwd: process.cwd(),
				model: "default",
				prompt: undefined,
				settingSources: defaultSettingSourcesFromEnv({ PI_CURSOR_SETTING_SOURCES: "all" }),
				apiKey: defaultApiKeyFromEnv({ CURSOR_API_KEY: "from-env" }),
			},
			flags: {
				cwd: commonProbeFlags.cwd,
				model: commonProbeFlags.model,
				prompt: commonProbeFlags.prompt,
				apiKey: commonProbeFlags.apiKey,
				settingSources: commonProbeFlags.settingSources,
			},
			fail,
		});
		expect(args).toMatchObject({
			cwd: "/tmp/work",
			model: "composer-2.5",
			prompt: "hi",
			settingSources: undefined,
			apiKey: "from-env",
		});
		expect(requireApiKey({ apiKey: "key" }, {}, fail)).toBe("key");
		expect(() => requireApiKey({}, {}, fail)).toThrow(/Cursor API key is required/);
	});

	it("rejects malformed repeated flag values", () => {
		const fail = vi.fn((message: string) => {
			throw new Error(message);
		});
		expect(() =>
			parseArgv(["--model", "--model=bad"], {
				defaults: { model: "default" },
				flags: { model: commonProbeFlags.model },
				fail,
			}),
		).toThrow(/--model requires a value/);
	});

	it("builds timestamped artifact directories under /tmp by default", () => {
		const dir = defaultTimestampedDir("pi-cursor-sdk-test-prefix");
		expect(dir).toMatch(/^\/tmp\/pi-cursor-sdk-test-prefix-/);
	});

	it("parses JSONL stdout and exposes child shutdown helpers", async () => {
		expect(parseJsonLines('{"type":"a"}\n\n{"type":"b"}\n')).toEqual([{ type: "a" }, { type: "b" }]);
		expect(typeof waitForChildClose).toBe("function");
		expect(typeof terminateChild).toBe("function");
	});

	it("createScriptFail scrubs generic secrets before applying explicit secrets", () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const firstSecret = "super-secret-cursor-key-12345";
		const secondSecret = "another-secret-token-67890";
		const fail = createScriptFail("test-script");
		fail(
			`failed with Bearer generic-token apiKey=raw-key http://127.0.0.1:4242/cursor-pi-tool-bridge/abc/mcp ${firstSecret} and ${secondSecret}`,
			[firstSecret, secondSecret],
		);
		const output = stderr.mock.calls.join("");
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[redacted]"));
		expect(output).toContain("Bearer [redacted]");
		expect(output).toContain("apiKey=[redacted]");
		expect(output).toContain("[redacted-bridge-endpoint]");
		expect(output).not.toContain(firstSecret);
		expect(output).not.toContain(secondSecret);
		exit.mockRestore();
		stderr.mockRestore();
	});
});
