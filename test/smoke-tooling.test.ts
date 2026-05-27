import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

function run(command: string, args: string[]) {
	return spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8" });
}

describe("smoke tooling package checks", () => {
	it("keeps smoke helper syntax and help paths working without live Cursor auth", () => {
		expect(run("bash", ["-n", "scripts/lib/cursor-smoke-shell.sh"]).status).toBe(0);
		expect(run("bash", ["-n", "scripts/tmux-live-smoke.sh"]).status).toBe(0);
		expect(run("bash", ["-n", "scripts/isolated-cursor-smoke.sh"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/steering-rpc-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/validate-smoke-jsonl.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/debug-sdk-events.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/debug-provider-events.mjs"]).status).toBe(0);

		const liveHelp = run("scripts/tmux-live-smoke.sh", ["--help"]);
		const isolatedHelp = run("scripts/isolated-cursor-smoke.sh", ["--help"]);
		const steeringHelp = run(process.execPath, ["scripts/steering-rpc-smoke.mjs", "--help"]);
		const jsonlHelp = run(process.execPath, ["scripts/validate-smoke-jsonl.mjs", "--help"]);
		const sdkEventsHelp = run(process.execPath, ["scripts/debug-sdk-events.mjs", "--help"]);
		const providerEventsHelp = run(process.execPath, ["scripts/debug-provider-events.mjs", "--help"]);

		expect(liveHelp.status).toBe(0);
		expect(liveHelp.stdout).toContain("retry-empty-output");
		expect(isolatedHelp.status).toBe(0);
		expect(isolatedHelp.stdout).toContain("plan-strip");
		expect(steeringHelp.status).toBe(0);
		expect(steeringHelp.stdout).toContain("RPC steering smoke");
		expect(jsonlHelp.status).toBe(0);
		expect(jsonlHelp.stdout).toContain("Validate assistant presence");
		expect(jsonlHelp.stdout).toContain("--replay-errors");
		expect(sdkEventsHelp.status).toBe(0);
		expect(sdkEventsHelp.stdout).toContain("Capture timestamped Cursor SDK event timelines");
		expect(providerEventsHelp.status).toBe(0);
		expect(providerEventsHelp.stdout).toContain("Capture raw Cursor SDK onDelta/onStep payloads through pi's provider path");

		const failedCommand = run("bash", [
			"-c",
			"set -e; . scripts/lib/cursor-smoke-shell.sh; smoke_run_with_timeout_or_fail repro 1 bash -c 'exit 42'",
		]);
		expect(failedCommand.status).toBe(1);
		expect(failedCommand.stderr).toContain("repro exited 42");
	});

	it("packages smoke scripts and avoids reusing the latest local release tag version", () => {
		const localReleaseTags = run("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]);
		expect(localReleaseTags.status).toBe(0);
		const latestTag = localReleaseTags.stdout.split(/\r?\n/).find((tag) => tag.length > 0);
		expect(latestTag).toMatch(/^v\d+\.\d+\.\d+$/);
		const latestReleasedVersion = latestTag!.replace(/^v/, "");

		const result = run("npm", ["pack", "--dry-run", "--json"]);
		expect(result.status).toBe(0);
		const [pack] = JSON.parse(result.stdout) as Array<{ name: string; version: string; filename: string; files: Array<{ path: string }> }>;
		const paths = new Set(pack.files.map((file) => file.path));

		expect(pack.name).toBe("pi-cursor-sdk");
		expect(pack.version).toBe(packageJson.version);
		expect(pack.version).not.toBe(latestReleasedVersion);
		expect(pack.filename).not.toBe(`pi-cursor-sdk-${latestReleasedVersion}.tgz`);
		expect(paths.has("scripts/tmux-live-smoke.sh")).toBe(true);
		expect(paths.has("scripts/isolated-cursor-smoke.sh")).toBe(true);
		expect(paths.has("scripts/steering-rpc-smoke.mjs")).toBe(true);
		expect(paths.has("scripts/validate-smoke-jsonl.mjs")).toBe(true);
		expect(paths.has("scripts/debug-sdk-events.mjs")).toBe(true);
		expect(paths.has("scripts/debug-provider-events.mjs")).toBe(true);
		for (const path of paths) {
			if (!path.endsWith(".mjs")) continue;
			const declarationPath = path.replace(/\.mjs$/, ".d.mts");
			if (existsSync(declarationPath)) expect(paths.has(declarationPath)).toBe(true);
		}
		expect(paths.has("shared/cursor-setting-sources.mjs")).toBe(true);
		expect(paths.has("shared/cursor-setting-sources.d.mts")).toBe(true);
		expect(paths.has("shared/cursor-sensitive-text.mjs")).toBe(true);
		expect(paths.has("shared/cursor-sensitive-text.d.mts")).toBe(true);
		expect(paths.has("scripts/lib/cursor-smoke-shell.sh")).toBe(true);
		expect(paths.has("scripts/lib/cursor-setting-sources.mjs")).toBe(false);
		expect(paths.has("scripts/lib/cursor-sensitive-text.mjs")).toBe(false);
		expect(paths.has("scripts/lib/cursor-cli-args.mjs")).toBe(true);
		expect(paths.has("CHANGELOG.md")).toBe(true);
		expect(paths.has("README.md")).toBe(true);
		expect([...paths].some((path) => path.startsWith("dist/") || path.startsWith("coverage/") || path.startsWith(".pi/") || path.includes("smoke-dir"))).toBe(false);
	});
});
