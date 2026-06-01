#!/usr/bin/env node

import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { accessSync, constants, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// ── helpers ────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const require = createRequire(import.meta.url);
let config;
try {
	config = require(resolve(repoRoot, "platform-smoke.config.mjs"));
	if (config.default) config = config.default;
} catch (err) {
	config = null;
}

function printHelp() {
	console.log(`Usage: node scripts/platform-smoke.mjs <command> [options]

Commands:
  doctor                     Run all preflight checks (no Cursor tokens)
  run --target <names>       Run one or more comma-separated targets concurrently
  run --suite <name>         Run one suite on all or specified targets
  run --target <n> --suite <n>

Options:
  --target       Comma-separated target names: macos,ubuntu,windows-native
  --suite        Suite name: platform-build,cursor-native-visual-matrix,cursor-bridge-visual-matrix,cursor-abort-cleanup
  --help, -h     Show this help

Examples:
  node scripts/platform-smoke.mjs doctor
  node scripts/platform-smoke.mjs run --target macos
  node scripts/platform-smoke.mjs run --target macos,ubuntu
  node scripts/platform-smoke.mjs run --suite platform-build
  node scripts/platform-smoke.mjs run --target macos --suite cursor-native-visual-matrix

Environment:
  PLATFORM_SMOKE_CRABBOX         Path to Crabbox binary
  CURSOR_API_KEY                 Cursor auth key (required for live suites)
  PLATFORM_SMOKE_MAC_HOST         macOS SSH host (default: localhost)
  PLATFORM_SMOKE_MAC_USER         macOS SSH user (default: \$USER)
  PLATFORM_SMOKE_MAC_WORK_ROOT    macOS work root
  PLATFORM_SMOKE_WINDOWS_VM       Parallels source VM name
  PLATFORM_SMOKE_WINDOWS_SNAPSHOT Snapshot name
  PLATFORM_SMOKE_WINDOWS_USER     Windows SSH user
  PLATFORM_SMOKE_UBUNTU_IMAGE        Ubuntu container image
  PLATFORM_SMOKE_WINDOWS_NATIVE_WORK_ROOT  Windows native work root
`);
}

function parseArgs(argv) {
	const args = { _: [], target: null, suite: null, command: null };
	let i = 2;
	while (i < argv.length) {
		const a = argv[i];
		if (a === "--help" || a === "-h") {
			args.command = "help";
			return args;
		}
		if (a === "doctor") {
			args.command = "doctor";
			i++;
			continue;
		}
		if (a === "run") {
			args.command = "run";
			i++;
			continue;
		}
		if (a === "--target" && i + 1 < argv.length) {
			args.target = argv[i + 1];
			i += 2;
			continue;
		}
		if (a === "--suite" && i + 1 < argv.length) {
			args.suite = argv[i + 1];
			i += 2;
			continue;
		}
		args._.push(a);
		i++;
	}
	return args;
}

function assertHostReleaseVersionGuard() {
	const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
	const result = spawnSync("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(`failed to inspect release tags: ${result.stderr || result.error?.message || "unknown git error"}`);
	const latestTag = result.stdout.split(/\r?\n/).find((tag) => tag.length > 0);
	if (!latestTag) throw new Error("no local release tags found; cannot enforce package version reuse guard");
	const latestVersion = latestTag.replace(/^v/, "");
	if (packageJson.version === latestVersion) throw new Error(`package version ${packageJson.version} reuses latest release tag ${latestTag}`);
}

// ── commands ───────────────────────────────────────────────────────────────
async function runDoctor() {
	try {
		const { runDoctor } = await import("./platform-smoke/doctor.mjs");
		await runDoctor(config);
	} catch (err) {
		if (err.code === "ERR_MODULE_NOT_FOUND") {
			console.error("doctor module not found. Is scripts/platform-smoke/doctor.mjs present?");
		} else {
			console.error("doctor failed:", err.message);
		}
		process.exit(1);
	}
}

async function runSuite(targetName, suiteName) {
	try {
		const { runTargetSuite } = await import("./platform-smoke/targets.mjs");
		const result = await runTargetSuite(config, targetName, suiteName);
		return result;
	} catch (err) {
		console.error(`suite ${suiteName} on ${targetName} exception:`, err.message);
		return { ok: false, error: err.message };
	}
}

async function runTarget(targetName, suites) {
	try {
		const { runTargetSuites } = await import("./platform-smoke/targets.mjs");
		return await runTargetSuites(config, targetName, suites);
	} catch (err) {
		console.error(`target ${targetName} exception:`, err.message);
		return { ok: false, error: err.message };
	}
}

async function main() {
	const args = parseArgs(process.argv);

	if (!args.command || args.command === "help") {
		printHelp();
		process.exit(args.command === "help" ? 0 : 1);
	}

	if (!config) {
		console.error("platform-smoke.config.mjs not found or failed to load");
		process.exit(1);
	}

	if (args.command === "doctor") {
		await runDoctor();
		return;
	}

	if (args.command === "run") {
		assertHostReleaseVersionGuard();
		const targets = args.target
			? args.target.split(",").map((s) => s.trim()).filter(Boolean)
			: config.requiredTargets;

		const suites = args.suite
			? [args.suite]
			: config.requiredSuites;

		const targetRuns = targets.map(async (targetName) => {
			console.log(`\n=== Target: ${targetName} ===`);
			const result = args.suite
				? await runSuite(targetName, suites[0])
				: await runTarget(targetName, suites);
			return { targetName, result };
		});
		const results = await Promise.all(targetRuns);
		const anyFailed = results.some(({ result }) => !result.ok);
		if (anyFailed) {
			console.log("\nOne or more suites failed. Check .artifacts/platform-smoke/ for details.");
			process.exit(1);
		}
		return;
	}

	console.error(`Unknown command: ${args.command}`);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
