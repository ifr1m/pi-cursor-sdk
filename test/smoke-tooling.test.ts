import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CURSOR_TOOL_PRESENTATION_SPECS } from "../src/cursor-tool-presentation-registry.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

function run(command: string, args: string[]) {
	return spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", shell: process.platform === "win32" && command === "npm" });
}

describe("smoke tooling package checks", () => {
	it("keeps smoke helper syntax and help paths working without live Cursor auth", () => {
		expect(run("bash", ["-n", "scripts/lib/cursor-smoke-shell.sh"]).status).toBe(0);
		expect(run("bash", ["-n", "scripts/tmux-live-smoke.sh"]).status).toBe(0);
		expect(run("bash", ["-n", "scripts/isolated-cursor-smoke.sh"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/steering-rpc-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/visual-tui-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/validate-smoke-jsonl.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/debug-sdk-events.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/debug-provider-events.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/doctor.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/live-suite-runner.mjs"]).status).toBe(0);
		expect(run(process.execPath, ["--check", "scripts/platform-smoke/targets.mjs"]).status).toBe(0);

		const liveHelp = process.platform === "win32" ? undefined : run("scripts/tmux-live-smoke.sh", ["--help"]);
		const isolatedHelp = process.platform === "win32" ? undefined : run("scripts/isolated-cursor-smoke.sh", ["--help"]);
		const steeringHelp = run(process.execPath, ["scripts/steering-rpc-smoke.mjs", "--help"]);
		const visualHelp = run(process.execPath, ["scripts/visual-tui-smoke.mjs", "--help"]);
		const jsonlHelp = run(process.execPath, ["scripts/validate-smoke-jsonl.mjs", "--help"]);
		const sdkEventsHelp = run(process.execPath, ["scripts/debug-sdk-events.mjs", "--help"]);
		const providerEventsHelp = run(process.execPath, ["scripts/debug-provider-events.mjs", "--help"]);
		const platformLiveHelp = run(process.execPath, ["scripts/platform-smoke/live-suite-runner.mjs", "--help"]);

		if (process.platform !== "win32") {
			expect(liveHelp!.status).toBe(0);
			expect(liveHelp!.stdout).toContain("retry-empty-output");
			expect(liveHelp!.stdout).toContain("--self-test");
			expect(isolatedHelp!.status).toBe(0);
			expect(isolatedHelp!.stdout).toContain("plan-strip");
			expect(isolatedHelp!.stdout).toContain("--self-test");
		}
		expect(steeringHelp.status).toBe(0);
		expect(steeringHelp.stdout).toContain("RPC steering smoke");
		expect(visualHelp.status).toBe(0);
		expect(visualHelp.stdout).toContain("Canonical offscreen TUI visual smoke runner");
		expect(visualHelp.stdout).toContain("PI_CURSOR_REGISTER_NATIVE_TOOLS=1");
		expect(visualHelp.stdout).toContain("--expose-builtin-tools");
		expect(jsonlHelp.status).toBe(0);
		expect(jsonlHelp.stdout).toContain("Validate assistant presence");
		expect(jsonlHelp.stdout).toContain("--replay-errors");
		expect(sdkEventsHelp.status).toBe(0);
		expect(sdkEventsHelp.stdout).toContain("Capture timestamped Cursor SDK event timelines");
		expect(providerEventsHelp.status).toBe(0);
		expect(providerEventsHelp.stdout).toContain("Capture raw Cursor SDK onDelta/onStep payloads through pi's provider path");
		expect(platformLiveHelp.status).toBe(0);
		expect(platformLiveHelp.stdout).toContain("--prep-dir");

		if (process.platform !== "win32") {
			const failedCommand = run("bash", [
				"-c",
				"set -e; . scripts/lib/cursor-smoke-shell.sh; smoke_run_with_timeout_or_fail repro 1 bash -c 'exit 42'",
			]);
			expect(failedCommand.status).toBe(1);
			expect(failedCommand.stderr).toContain("repro exited 42");
		}

		if (process.platform !== "win32") {
			const visualSelfTest = run(process.execPath, ["scripts/visual-tui-smoke.mjs", "--self-test"]);
			expect(visualSelfTest.status).toBe(0);
			expect(visualSelfTest.stdout).toContain("self-test PASS");
		}
		if (process.platform !== "win32") {
			const steeringSelfTest = run(process.execPath, ["scripts/steering-rpc-smoke.mjs", "--self-test"]);
			expect(steeringSelfTest.status).toBe(0);
			expect(steeringSelfTest.stdout).toContain("self-test PASS");
		}
		if (process.platform !== "win32") {
			const liveSelfTest = run("scripts/tmux-live-smoke.sh", ["--self-test"]);
			expect(liveSelfTest.status).toBe(0);
			expect(liveSelfTest.stdout).toContain("self-test PASS");
			const isolatedSelfTest = run("scripts/isolated-cursor-smoke.sh", ["--self-test"]);
			expect(isolatedSelfTest.status).toBe(0);
			expect(isolatedSelfTest.stdout).toContain("self-test PASS");
		}
		const invalidVisualArgs = run(process.execPath, ["scripts/visual-tui-smoke.mjs", "--label", "bad", "--prompt", "bad", "--expose-builtin-tools"]);
		expect(invalidVisualArgs.status).toBe(2);
		expect(invalidVisualArgs.stderr).toContain("--expose-builtin-tools requires --bridge");
	}, 90_000);

	it("keeps card and bundle evidence checks strict against prompt/path false positives", () => {
		const code = String.raw`
import { detectCards, assertRequiredCards } from "./scripts/platform-smoke/card-detect.mjs";
import { isSafeBundlePath } from "./scripts/platform-smoke/targets.mjs";
const promptOnly = detectCards("1. call pi__read on ./package.json\n2. grep ./README.md\n");
const rendered = detectCards("read ./package.json\nbridge visual smoke\nENOENT: no such file or directory\ncomposer-2-5\n");
const checks = assertRequiredCards(".", rendered, ["read", "bridge-shell-success", "bridge-read-failure", "footer-status"]);
const result = {
  promptCardCount: promptOnly.length,
  renderedOk: checks.every((check) => check.ok),
  traversalRejected: !isSafeBundlePath("/tmp/platform-smoke-suite", "../outside.txt"),
  absoluteRejected: !isSafeBundlePath("/tmp/platform-smoke-suite", "/tmp/outside.txt"),
  normalAccepted: isSafeBundlePath("/tmp/platform-smoke-suite", "artifacts/terminal.txt"),
};
console.log(JSON.stringify(result));
if (result.promptCardCount !== 0 || !result.renderedOk || !result.traversalRejected || !result.absoluteRejected || !result.normalAccepted) process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"promptCardCount":0');
		expect(result.stdout).toContain('"renderedOk":true');
		expect(result.stdout).toContain('"traversalRejected":true');
	});

	it("redacts platform smoke artifacts before writing and scopes Cursor auth to allowed Crabbox runs", () => {
		const code = String.raw`
process.env.CURSOR_API_KEY = "cursor-secret-token-12345";
process.env.PLATFORM_SMOKE_CRABBOX = process.execPath;
const { redactSecrets, scanForSecrets } = await import("./scripts/platform-smoke/artifacts.mjs");
const { execCrabbox, buildTargetBaseArgs } = await import("./scripts/platform-smoke/crabbox-runner.mjs");
const raw = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz cursor-secret-token-12345";
const redacted = redactSecrets(raw);
const stripped = await execCrabbox(["-e", "process.stdout.write(process.env.CURSOR_API_KEY || 'missing')"]);
const allowed = await execCrabbox(["-e", "process.stdout.write(process.env.CURSOR_API_KEY || 'missing')"], { allowEnv: ["CURSOR_API_KEY"] });
delete process.env.PLATFORM_SMOKE_UBUNTU_IMAGE;
const ubuntuArgs = buildTargetBaseArgs("ubuntu", { ubuntuContainerImage: "example/node:24" });
const result = {
  rawViolations: scanForSecrets(raw),
  redactedViolations: scanForSecrets(redacted),
  redacted,
  stripped: stripped.stdout,
  allowed: allowed.stdout,
  ubuntuImage: ubuntuArgs[ubuntuArgs.indexOf("--local-container-image") + 1],
};
console.log(JSON.stringify(result));
if (!result.rawViolations.includes("CURSOR_API_KEY literal found")) process.exit(1);
if (result.redacted.includes("cursor-secret-token-12345") || result.redactedViolations.length !== 0) process.exit(1);
if (result.stripped !== "missing" || result.allowed !== "cursor-secret-token-12345") process.exit(1);
if (result.ubuntuImage !== "example/node:24") process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"stripped":"missing"');
		expect(result.stdout).toContain('"ubuntuImage":"example/node:24"');
	});

	it("fails suite artifacts when required manifests or lease cleanup are missing", () => {
		const code = String.raw`
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeSuiteArtifacts, createLeaseCleanupFailureResult } from "./scripts/platform-smoke/targets.mjs";
const root = mkdtempSync(join(tmpdir(), "platform-smoke-manifest-test-"));
try {
  const suiteDir = join(root, "suite");
  await import("node:fs").then(({ mkdirSync }) => mkdirSync(suiteDir, { recursive: true }));
  writeFileSync(join(suiteDir, "present.txt"), "ok");
  const finalized = finalizeSuiteArtifacts(
    suiteDir,
    [{ id: "base-ok", fn: () => true }],
    { target: "unit", suite: "manifest", exitCode: 0, elapsedMs: 1 },
    ["summary.json", "assertions.json", "present.txt", "missing.txt"],
  );
  const manifest = JSON.parse(readFileSync(join(suiteDir, "artifact-manifest.json"), "utf8"));
  const cleanup = createLeaseCleanupFailureResult({ artifactRoot: root, packageName: "pi-cursor-sdk" }, "ubuntu", "cbx_failed", {
    stdout: "",
    stderr: "stop failed",
    code: 1,
    signal: null,
  });
  const cleanupAssertions = JSON.parse(readFileSync(join(cleanup.suiteDir, "assertions.json"), "utf8"));
  const result = {
    manifestOk: finalized.assertions.ok,
    missing: manifest.missing,
    cleanupOk: cleanup.ok,
    cleanupAssertionOk: cleanupAssertions.ok,
    cleanupHasStopFailure: cleanupAssertions.checks.some((check) => check.id === "lease-stop" && check.ok === false),
  };
  console.log(JSON.stringify(result));
  if (result.manifestOk || !result.missing.includes("missing.txt") || result.cleanupOk || result.cleanupAssertionOk || !result.cleanupHasStopFailure) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"manifestOk":false');
		expect(result.stdout).toContain('"missing.txt"');
		expect(result.stdout).toContain('"cleanupHasStopFailure":true');
	});

	it("requires platform final markers in the last non-empty assistant text part", () => {
		const code = String.raw`
import { extractContentText, extractFinalTextContent, jsonlHasAssistantFinalTextMarker } from "./scripts/platform-smoke/jsonl-text.mjs";
import { hasAbortSuccessClaim } from "./scripts/platform-smoke/targets.mjs";
const content = [
  { type: "text", text: "LIVE TEST PASS only appeared in progress\n" },
  { type: "thinking", thinking: "tool metadata" },
  { type: "text", text: "   \n" },
  { type: "text", text: "actual final report" },
];
const raw = JSON.stringify({ message: { role: "assistant", content } }) + "\n";
const abortRaw = JSON.stringify({ message: { role: "assistant", content: [
  { type: "thinking", thinking: "wait for the tool to complete" },
  { type: "text", text: "aborting now" },
] } }) + "\n";
const result = {
  allTextIncludesMarker: extractContentText(content).includes("LIVE TEST PASS"),
  finalText: extractFinalTextContent(content),
  markerAccepted: jsonlHasAssistantFinalTextMarker(raw, "LIVE TEST PASS"),
  abortSuccessClaim: hasAbortSuccessClaim(abortRaw),
};
console.log(JSON.stringify(result));
if (!result.allTextIncludesMarker || result.finalText !== "actual final report" || result.markerAccepted || result.abortSuccessClaim) process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"allTextIncludesMarker":true');
		expect(result.stdout).toContain('"finalText":"actual final report"');
		expect(result.stdout).toContain('"markerAccepted":false');
		expect(result.stdout).toContain('"abortSuccessClaim":false');
	});

	it("asserts rendered visual evidence patterns from output lines rather than prompt text", () => {
		const code = String.raw`
import { findVisualEvidenceItems } from "./scripts/platform-smoke/visual-evidence.mjs";
const positive = findVisualEvidenceItems([
  "read ./package.json",
  "native shell failure",
], [
  { id: "read", pattern: "^\\s*read \\./package\\.json" },
  { id: "failure", pattern: "^\\s*native shell failure\\s*$" },
]);
const promptOnly = findVisualEvidenceItems([
  "1. call pi__read on ./package.json",
], [
  { id: "read", pattern: "^\\s*read \\./package\\.json" },
]);
const positiveItemsOk = positive.every((item) => item.ok === true);
console.log(JSON.stringify({ positiveItemsOk, promptOnlyItemOk: promptOnly[0]?.ok ?? null }));
if (!positiveItemsOk || promptOnly[0]?.ok !== false) process.exit(1);
`;
		const result = run(process.execPath, ["--input-type=module", "-e", code]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"positiveItemsOk":true');
		expect(result.stdout).toContain('"promptOnlyItemOk":false');
	});

	it("classifies every Cursor tool presentation surface for platform visual coverage", () => {
		const classified = {
			coveredByNativeVisualMatrix: ["read", "grep", "glob", "shell", "edit", "write"],
			coveredByBridgeVisualMatrix: ["shell", "read"],
			excludedFromPlatformVisualMatrix: ["ls", "delete", "readLints", "updateTodos", "createPlan", "task", "generateImage", "mcp", "semSearch", "recordScreen", "webSearch", "webFetch"],
		};
		const allClassified = new Set([
			...classified.coveredByNativeVisualMatrix,
			...classified.coveredByBridgeVisualMatrix,
			...classified.excludedFromPlatformVisualMatrix,
		]);
		const registryNames = CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => spec.normalizedName);
		expect(new Set(registryNames)).toEqual(allClassified);
	});

	it("packages smoke scripts and enforces the release version guard unless explicitly bypassed", () => {
		const skipReleaseVersionGuard = process.env.PI_CURSOR_SKIP_RELEASE_VERSION_GUARD === "1";
		const localReleaseTags = run("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]);
		if (!skipReleaseVersionGuard) expect(localReleaseTags.status).toBe(0);
		const latestTag = localReleaseTags.status === 0 ? localReleaseTags.stdout.split(/\r?\n/).find((tag) => tag.length > 0) : undefined;
		if (!skipReleaseVersionGuard) expect(latestTag).toMatch(/^v\d+\.\d+\.\d+$/);
		const latestReleasedVersion = latestTag?.replace(/^v/, "");

		const result = run("npm", ["pack", "--dry-run", "--json"]);
		expect(result.status).toBe(0);
		const [pack] = JSON.parse(result.stdout) as Array<{ name: string; version: string; filename: string; files: Array<{ path: string }> }>;
		const paths = new Set(pack.files.map((file) => file.path));

		expect(pack.name).toBe("pi-cursor-sdk");
		expect(pack.version).toBe(packageJson.version);
		if (!skipReleaseVersionGuard) {
			expect(pack.version).not.toBe(latestReleasedVersion);
			expect(pack.filename).not.toBe(`pi-cursor-sdk-${latestReleasedVersion}.tgz`);
		}
		expect(paths.has("scripts/tmux-live-smoke.sh")).toBe(true);
		expect(paths.has("scripts/isolated-cursor-smoke.sh")).toBe(true);
		expect(paths.has("scripts/fixtures/plan-strip-shim/index.ts")).toBe(true);
		expect(paths.has("scripts/steering-rpc-smoke.mjs")).toBe(true);
		expect(paths.has("scripts/visual-tui-smoke.mjs")).toBe(true);
		expect(paths.has("scripts/validate-smoke-jsonl.mjs")).toBe(true);
		expect(paths.has("scripts/debug-sdk-events.mjs")).toBe(true);
		expect(paths.has("scripts/debug-provider-events.mjs")).toBe(true);
		expect(paths.has("platform-smoke.config.mjs")).toBe(true);
		expect(paths.has("scripts/platform-smoke/live-suite-runner.mjs")).toBe(true);
		expect(paths.has("scripts/platform-smoke/visual-evidence.mjs")).toBe(true);
		for (const path of paths) {
			if (!path.endsWith(".mjs")) continue;
			const declarationPath = path.replace(/\.mjs$/, ".d.mts");
			if (existsSync(declarationPath)) expect(paths.has(declarationPath)).toBe(true);
		}
		expect(paths.has("shared/cursor-setting-sources.mjs")).toBe(true);
		expect(paths.has("shared/cursor-setting-sources.d.mts")).toBe(true);
		expect(paths.has("shared/cursor-sensitive-text.mjs")).toBe(true);
		expect(paths.has("shared/cursor-sensitive-text.d.mts")).toBe(true);
		expect(paths.has("scripts/lib/cursor-smoke-env.mjs")).toBe(true);
		expect(paths.has("scripts/lib/cursor-smoke-env.d.mts")).toBe(true);
		expect(paths.has("scripts/lib/cursor-smoke-shell.sh")).toBe(true);
		expect(paths.has("scripts/lib/cursor-visual-render.mjs")).toBe(true);
		expect(paths.has("scripts/lib/cursor-visual-render.d.mts")).toBe(true);
		expect(paths.has("shared/cursor-sdk-event-debug-env.mjs")).toBe(true);
		expect(paths.has("shared/cursor-sdk-event-debug-env.d.mts")).toBe(true);
		expect(paths.has("scripts/lib/cursor-setting-sources.mjs")).toBe(false);
		expect(paths.has("scripts/lib/cursor-sensitive-text.mjs")).toBe(false);
		expect(paths.has("scripts/lib/cursor-cli-args.mjs")).toBe(true);
		expect(paths.has("CHANGELOG.md")).toBe(true);
		expect(paths.has("README.md")).toBe(true);
		expect(paths.has("docs/platform-smoke.md")).toBe(true);
		expect(paths.has("docs/crabbox-platform-testing-lessons.md")).toBe(true);
		expect([...paths].some((path) => path.startsWith("dist/") || path.startsWith("coverage/") || path.startsWith(".pi/") || path.includes("smoke-dir"))).toBe(false);
	}, 90_000);
});
