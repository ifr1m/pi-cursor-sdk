/**
 * Target runner — real suite execution, artifact writing, and fail-through.
 *
 * Each target session: warmup → run suites → artifacts → stop.
 * Live suites execute real Cursor-backed PTY/ConPTY runs and fail through with artifacts.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { createSuiteDir, writeManifest, writeSummary, writeCommand, writeExitCode, scanArtifacts, scanForSecrets, redactSecrets } from "./artifacts.mjs";
import { runAssertions } from "./assertions.mjs";
import { getScenario } from "./scenarios.mjs";
import { warmupLease, runOnLease, stopLease } from "./crabbox-runner.mjs";
import { renderAll } from "./render-ansi.mjs";
import { assertRequiredCards, detectCards, writeCardArtifacts } from "./card-detect.mjs";
import { collectVisualEvidence } from "./visual-evidence.mjs";
import { extractContentText, extractFinalTextContent } from "./jsonl-text.mjs";

export function platformFor(targetName) {
	return targetName === "windows-native" ? "powershell" : "posix";
}

function makeRunId() {
	return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function finalizeSuiteArtifacts(suiteDir, checks, summaryData, expectedFiles) {
	const assertions = runAssertions(suiteDir, checks);
	writeSummary(suiteDir, { ...summaryData, ok: assertions.ok });
	const expected = assertions.ok ? expectedFiles : [...expectedFiles, "failures.md"];
	const manifest = writeManifest(suiteDir, expected);
	if (manifest.missing.length === 0) return { assertions, manifest };

	const finalAssertions = runAssertions(suiteDir, [
		...checks,
		{
			id: "artifact-manifest-complete",
			fn: () => false,
			error: `missing required artifact(s): ${manifest.missing.join(", ")}`,
		},
	]);
	writeSummary(suiteDir, { ...summaryData, ok: false });
	const finalManifest = writeManifest(suiteDir, [...expectedFiles, "failures.md"]);
	return { assertions: finalAssertions, manifest: finalManifest };
}

function writeRedactedFile(path, content) {
	writeFileSync(path, redactSecrets(content ?? ""));
}

function writeStopLeaseArtifacts(suiteDir, stopResult) {
	writeRedactedFile(resolve(suiteDir, "crabbox.stop.stdout.txt"), stopResult.stdout ?? "");
	writeRedactedFile(resolve(suiteDir, "crabbox.stop.stderr.txt"), stopResult.stderr ?? "");
	writeFileSync(resolve(suiteDir, "crabbox.stop.exit-code.txt"), `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`);
}

function stopLeaseCheck(stopResult) {
	return {
		id: "lease-stop",
		fn: () => stopResult?.code === 0,
		error: `Crabbox stop failed (exit ${stopResult?.code ?? "unknown"}); check crabbox.stop.stderr.txt`,
	};
}

export function createLeaseCleanupResult(config, targetName, leaseId, stopResult, runId = makeRunId()) {
	const suiteName = "lease-cleanup";
	const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
	writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify({
		targetName,
		platform: platformFor(targetName),
		slug: `${config.packageName ?? "pi-cursor-sdk"}-${targetName}`,
		runId,
		writtenAt: new Date().toISOString(),
	}, null, 2));
	writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({
		suiteName,
		leaseId,
		writtenAt: new Date().toISOString(),
	}, null, 2));
	writeCommand(suiteDir, `crabbox stop ${targetName} --id ${leaseId}`);
	writeExitCode(suiteDir, stopResult.code, stopResult.signal);
	writeStopLeaseArtifacts(suiteDir, stopResult);
	const { assertions } = finalizeSuiteArtifacts(
		suiteDir,
		[stopLeaseCheck(stopResult)],
		{ target: targetName, suite: suiteName, exitCode: stopResult.code, signal: stopResult.signal, elapsedMs: 0 },
		[
			"summary.json", "target.json", "suite.json", "command.txt", "exit-code.txt",
			"crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt", "assertions.json",
		],
	);
	return { ok: assertions.ok, suiteDir, assertions };
}

export function createLeaseCleanupFailureResult(config, targetName, leaseId, stopResult) {
	return { ...createLeaseCleanupResult(config, targetName, leaseId, stopResult), ok: false };
}

/**
 * Execute a single suite on a target.
 * Returns { ok, suiteDir, assertions }.
 * On failure, writes fail-through artifacts but does not throw.
 */
export async function runTargetSuite(config, targetName, suiteName, leaseSession) {
	const scenario = getScenario(suiteName);
	const runId = leaseSession?.runId ?? makeRunId();
	const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
	const platform = platformFor(targetName);
	const slug = `${config.packageName ?? "pi-cursor-sdk"}-${targetName}`;

	console.log(`\n── [${targetName}] ${suiteName} ──`);
	console.log(`  runId: ${runId}`);
	console.log(`  suiteDir: ${suiteDir}`);

	// Write metadata
	writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify({
		targetName, platform, slug, runId,
		writtenAt: new Date().toISOString(),
	}, null, 2));

	writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({
		suiteName,
		cursorCalls: scenario?.cursorCalls ?? 0,
		writtenAt: new Date().toISOString(),
	}, null, 2));

	if (!scenario) {
		const result = failSuite(suiteDir, targetName, suiteName, `unknown suite: ${suiteName}`);
		result.ok = false;
		return result;
	}

	// Route to suite-specific executor
	switch (suiteName) {
		case "platform-build":
			return await executePlatformBuild(config, targetName, suiteDir, slug, platform, leaseSession);
		case "cursor-native-visual-matrix":
		case "cursor-bridge-visual-matrix":
		case "cursor-abort-cleanup":
			return await executeLiveSuite(config, targetName, suiteName, suiteDir, slug, leaseSession);
		default:
			return failSuite(suiteDir, targetName, suiteName, `unknown suite: ${suiteName}`);
	}
}

/**
 * Execute a target session: warm once, sync once, run suites fail-fast, stop once.
 * This is the release-gate path; per-suite runs remain available for diagnosis.
 */
export async function runTargetSuites(config, targetName, suiteNames) {
	const slug = `${config.packageName ?? "pi-cursor-sdk"}-${targetName}`;
	const runId = makeRunId();
	console.log(`  targetRunId: ${runId}`);
	console.log(`  warmup ${targetName}...`);
	const warmup = await warmupLease(targetName, slug, config);
	if (!warmup.ok) {
		const suiteName = suiteNames[0] ?? "platform-build";
		const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
		writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify({
			targetName, platform: platformFor(targetName), slug, runId,
			writtenAt: new Date().toISOString(),
		}, null, 2));
		writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({
			suiteName,
			writtenAt: new Date().toISOString(),
		}, null, 2));
		writeExitCode(suiteDir, warmup.code, warmup.signal);
		writeRedactedFile(resolve(suiteDir, "crabbox.warmup.stdout.txt"), warmup.stdout);
		writeRedactedFile(resolve(suiteDir, "crabbox.warmup.stderr.txt"), warmup.stderr);
		const failed = failSuite(suiteDir, targetName, suiteName, `Crabbox warmup failed (exit ${warmup.code}): ${warmup.stderr.slice(-500)}`);
		return { ok: false, results: [failed] };
	}

	const results = [];
	let sync = true;
	const livePrepDir = `.platform-smoke-runs/live-prep-${Date.now()}-${targetName}`;
	let stopResult;
	try {
		for (const suiteName of suiteNames) {
			console.log(`  Suite: ${suiteName}`);
			const result = await runTargetSuite(config, targetName, suiteName, { ...warmup, sync, livePrepDir, runId });
			results.push(result);
			sync = false;
			if (!result.ok) break;
		}
	} finally {
		console.log(`  stopping lease ${warmup.leaseId}...`);
		stopResult = await stopLease(targetName, warmup.leaseId, config);
	}
	if (stopResult) {
		results.push(createLeaseCleanupResult(config, targetName, warmup.leaseId, stopResult, runId));
	}
	return { ok: results.every((result) => result.ok), results };
}

/**
 * Execute the platform-build suite on a target.
 *
 * Steps:
 * 1. Warmup lease (syncs checkout)
 * 2. Run combined build shell: npm ci, test, typecheck, pack
 * 3. Run separate asserts on output
 * 4. Stop lease
 * 5. Write failure artifacts on any failure
 */
async function executePlatformBuild(config, targetName, suiteDir, slug, platform, leaseSession) {
	const startedAt = Date.now();
	const packageName = config.packageName ?? "pi-cursor-sdk";
	const command = buildPlatformBuildCommand(targetName, packageName, config.nodeValidationMajor ?? 24);
	writeCommand(suiteDir, command);
	let warmup = leaseSession;
	const ownsLease = !warmup;

	if (!warmup) {
		console.log(`  warmup ${targetName}...`);
		warmup = await warmupLease(targetName, slug, config);
		if (!warmup.ok) {
			writeExitCode(suiteDir, warmup.code, warmup.signal);
			writeRedactedFile(resolve(suiteDir, "crabbox.warmup.stdout.txt"), warmup.stdout);
			writeRedactedFile(resolve(suiteDir, "crabbox.warmup.stderr.txt"), warmup.stderr);
			return failSuite(suiteDir, targetName, "platform-build",
				`Crabbox warmup failed (exit ${warmup.code}): ${warmup.stderr.slice(-500)}`);
		}
	}

	console.log(`  executing build shell on ${targetName}...`);
	const result = await runOnLease(targetName, warmup.leaseId, command, {
		shell: true,
		timeout: 600_000,
		sync: leaseSession?.sync,
		config,
	});

	const elapsed = Date.now() - startedAt;

	// Write artifact files
	writeRedactedFile(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout);
	writeRedactedFile(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr);
	writeFileSync(resolve(suiteDir, "crabbox.timing.json"), JSON.stringify({
		startedAt: new Date(startedAt).toISOString(),
		elapsedMs: elapsed,
		code: result.code,
		signal: result.signal,
	}, null, 2));
	writeCommand(suiteDir, command);
	writeExitCode(suiteDir, result.code, result.signal);

	let stopResult;
	if (ownsLease) {
		console.log(`  stopping lease ${warmup.leaseId}...`);
		stopResult = await stopLease(targetName, warmup.leaseId, config);
		writeStopLeaseArtifacts(suiteDir, stopResult);
	}

	writePlatformBuildExtracts(suiteDir, result.stdout);

	// Run redaction scan
	const violations = scanForSecrets(result.stdout + result.stderr);
	if (violations.length > 0) {
		writeFileSync(resolve(suiteDir, "redaction-violations.json"), JSON.stringify(violations, null, 2));
	}

	// Build assertions
	const stdout = result.stdout;
	const exitOk = result.code === 0;
	const markerOk = stdout.includes("PLATFORM_BUILD_OK");
	const nodeMajor = Number(stdout.match(/PLATFORM_NODE_VERSION=v?(\d+)\./)?.[1] ?? 0);
	const nodeVersionOk = nodeMajor >= (config.nodeValidationMajor ?? 24);
	const npmCiOk = /PLATFORM_NPM_CI_EXIT=0/.test(stdout);
	const checkPlatformSmokeOk = /PLATFORM_CHECK_PLATFORM_SMOKE_EXIT=0/.test(stdout);
	const npmTestOk = /PLATFORM_NPM_TEST_EXIT=0/.test(stdout);
	const typecheckOk = /PLATFORM_TYPECHECK_EXIT=0/.test(stdout);
	const npmPackOk = /PLATFORM_NPM_PACK_EXIT=0/.test(stdout) && /PLATFORM_PACKED_TARBALL=\S+/.test(stdout);
	const fixtureOk = /PLATFORM_FIXTURE_EXIT=0/.test(stdout);
	const packedNodeInstallOk = /PLATFORM_PACKED_NODE_INSTALL_EXIT=0/.test(stdout);
	const installOk = /PLATFORM_PI_INSTALL_EXIT=0/.test(stdout);
	const listOutput = section(stdout, "PI_LIST_STDOUT");
	const packageInstallSegment = `node_modules${platform === "powershell" ? "\\" : "/"}${packageName}`;
	const listOk = /PLATFORM_PI_LIST_EXIT=0/.test(stdout) && listOutput.includes(packageName) && listOutput.includes(packageInstallSegment);
	const noPiEDot = !/\bpi\s+-e\s+\./.test(stdout) && !/\bpi\s+--extension\s+\./.test(stdout);
	const noSecrets = violations.length === 0;

	const checks = [
		{ id: "build-exit-zero", fn: () => exitOk },
		{ id: "build-marker", fn: () => markerOk },
		{ id: "node-version", fn: () => nodeVersionOk },
		{ id: "npm-ci", fn: () => npmCiOk },
		{ id: "check-platform-smoke", fn: () => checkPlatformSmokeOk },
		{ id: "npm-test", fn: () => npmTestOk },
		{ id: "typecheck", fn: () => typecheckOk },
		{ id: "npm-pack", fn: () => npmPackOk },
		{ id: "fixture-workspace", fn: () => fixtureOk },
		{ id: "packed-node-install", fn: () => packedNodeInstallOk },
		{ id: "packed-install", fn: () => installOk },
		{ id: "pi-list", fn: () => listOk },
		{ id: "no-pi-e-dot", fn: () => noPiEDot },
		{ id: "no-secrets", fn: () => noSecrets },
	];

	if (result.code !== 0 && !markerOk) {
		checks.push({ id: "build-stderr", fn: () => false, error: `exit ${result.code}, check crabbox.stderr.txt` });
	}
	if (stopResult) checks.push(stopLeaseCheck(stopResult));

	const expectedFiles = [
		"summary.json", "target.json", "suite.json",
		"command.txt", "exit-code.txt",
		"crabbox.stdout.txt", "crabbox.stderr.txt", "crabbox.timing.json",
		"node-version.txt", "npm-version.txt",
		"npm-ci.stdout.txt", "npm-ci.stderr.txt",
		"check-platform-smoke.stdout.txt", "check-platform-smoke.stderr.txt",
		"npm-test.stdout.txt", "npm-test.stderr.txt",
		"typecheck.stdout.txt", "typecheck.stderr.txt",
		"npm-pack.stdout.txt", "npm-pack.stderr.txt",
		"packed-tarball.txt", "packed-node-install.stdout.txt", "packed-node-install.stderr.txt",
		"pi-install.stdout.txt", "pi-install.stderr.txt",
		"pi-list.stdout.txt", "pi-list.stderr.txt",
		"assertions.json",
	];
	if (stopResult) expectedFiles.push("crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt");
	const { assertions } = finalizeSuiteArtifacts(suiteDir, checks, {
		target: targetName,
		suite: "platform-build",
		exitCode: result.code,
		signal: result.signal,
		elapsedMs: elapsed,
	}, expectedFiles);

	console.log(`  ${assertions.ok ? "PASS" : "FAIL"} platform-build on ${targetName} (${elapsed}ms)`);

	return { ok: assertions.ok, suiteDir, assertions };
}

/**
 * Build a POSIX shell command that runs the full platform-build pipeline
 * and prints a success/failure marker.
 */
function section(text, name) {
	const start = `--- ${name} START ---`;
	const end = `--- ${name} END ---`;
	const startIndex = text.indexOf(start);
	if (startIndex === -1) return "";
	const contentStart = startIndex + start.length;
	const endIndex = text.indexOf(end, contentStart);
	const raw = endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex);
	return raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function markerValue(text, name) {
	const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
	return match?.[1]?.trim() ?? "";
}

function writePlatformBuildExtracts(suiteDir, stdout) {
	writeRedactedFile(resolve(suiteDir, "node-version.txt"), `${markerValue(stdout, "PLATFORM_NODE_VERSION")}\n`);
	writeRedactedFile(resolve(suiteDir, "npm-version.txt"), `${markerValue(stdout, "PLATFORM_NPM_VERSION")}\n`);
	writeRedactedFile(resolve(suiteDir, "npm-ci.stdout.txt"), section(stdout, "NPM_CI_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "npm-ci.stderr.txt"), section(stdout, "NPM_CI_STDERR"));
	writeRedactedFile(resolve(suiteDir, "check-platform-smoke.stdout.txt"), section(stdout, "CHECK_PLATFORM_SMOKE_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "check-platform-smoke.stderr.txt"), section(stdout, "CHECK_PLATFORM_SMOKE_STDERR"));
	writeRedactedFile(resolve(suiteDir, "npm-test.stdout.txt"), section(stdout, "NPM_TEST_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "npm-test.stderr.txt"), section(stdout, "NPM_TEST_STDERR"));
	writeRedactedFile(resolve(suiteDir, "typecheck.stdout.txt"), section(stdout, "TYPECHECK_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "typecheck.stderr.txt"), section(stdout, "TYPECHECK_STDERR"));
	writeRedactedFile(resolve(suiteDir, "npm-pack.stdout.txt"), section(stdout, "NPM_PACK_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "npm-pack.stderr.txt"), section(stdout, "NPM_PACK_STDERR"));
	writeRedactedFile(resolve(suiteDir, "packed-tarball.txt"), `${markerValue(stdout, "PLATFORM_PACKED_TARBALL")}\n`);
	writeRedactedFile(resolve(suiteDir, "packed-node-install.stdout.txt"), section(stdout, "PACKED_NODE_INSTALL_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "packed-node-install.stderr.txt"), section(stdout, "PACKED_NODE_INSTALL_STDERR"));
	writeRedactedFile(resolve(suiteDir, "pi-install.stdout.txt"), section(stdout, "PI_INSTALL_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "pi-install.stderr.txt"), section(stdout, "PI_INSTALL_STDERR"));
	writeRedactedFile(resolve(suiteDir, "pi-list.stdout.txt"), section(stdout, "PI_LIST_STDOUT"));
	writeRedactedFile(resolve(suiteDir, "pi-list.stderr.txt"), section(stdout, "PI_LIST_STDERR"));
}

function posixSection(name, command) {
	return [
		`echo "--- ${name} START ---"`,
		command,
		`echo "--- ${name} END ---"`,
	];
}

/**
 * Build a shell command that runs the full platform-build pipeline and packed-install contract.
 */
export function buildPlatformBuildCommand(targetName, packageName = "pi-cursor-sdk", nodeValidationMajor = 24) {
	const platform = platformFor(targetName);
	const lines = [];
	if (platform === "posix") {
		lines.push("set -o pipefail");
		lines.push('echo "Starting platform-build in $(pwd) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"');
		lines.push('RUN_ROOT=".platform-smoke-runs/platform-build-$(date -u +%Y%m%dT%H%M%SZ)-$$"');
		lines.push('SOURCE_ROOT="$(pwd)"');
		lines.push('PACK_DIR="$SOURCE_ROOT/$RUN_ROOT/pack"');
		lines.push('TEST_WORKSPACE="$SOURCE_ROOT/$RUN_ROOT/test-workspace"');
		lines.push('PI_PROJECT="$SOURCE_ROOT/$RUN_ROOT/pi-project"');
		lines.push('mkdir -p "$PACK_DIR" "$TEST_WORKSPACE" "$PI_PROJECT"');
		lines.push('echo "PLATFORM_RUN_ROOT=$RUN_ROOT"');
		lines.push('echo "PLATFORM_TEST_WORKSPACE=$TEST_WORKSPACE"');
		lines.push('echo "PLATFORM_PI_PROJECT=$PI_PROJECT"');
		lines.push("");
		lines.push('NODE_VERSION=$(node --version)');
		lines.push('NPM_VERSION=$(npm --version)');
		lines.push('NODE_MAJOR=${NODE_VERSION#v}');
		lines.push('NODE_MAJOR=${NODE_MAJOR%%.*}');
		lines.push('printf "%s\\n" "$NODE_VERSION" > "$PACK_DIR/node-version.txt"');
		lines.push('printf "%s\\n" "$NPM_VERSION" > "$PACK_DIR/npm-version.txt"');
		lines.push('echo "PLATFORM_NODE_VERSION=$NODE_VERSION"');
		lines.push('echo "PLATFORM_NPM_VERSION=$NPM_VERSION"');
		lines.push(`if [ "$NODE_MAJOR" -ge ${nodeValidationMajor} ]; then NODE_VERSION_EXIT=0; else NODE_VERSION_EXIT=1; fi`);
		lines.push('echo "PLATFORM_NODE_VERSION_EXIT=$NODE_VERSION_EXIT"');
		lines.push(...posixSection("NODE_VERSION_STDOUT", 'cat "$PACK_DIR/node-version.txt"'));
		lines.push(...posixSection("NPM_VERSION_STDOUT", 'cat "$PACK_DIR/npm-version.txt"'));
		lines.push('');
		lines.push('echo "=== npm ci ==="');
		lines.push('npm ci >"$PACK_DIR/npm-ci.stdout.txt" 2>"$PACK_DIR/npm-ci.stderr.txt"');
		lines.push("CI_EXIT=$?");
		lines.push('echo "PLATFORM_NPM_CI_EXIT=$CI_EXIT"');
		lines.push(...posixSection("NPM_CI_STDOUT", 'cat "$PACK_DIR/npm-ci.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("NPM_CI_STDERR", 'cat "$PACK_DIR/npm-ci.stderr.txt" 2>/dev/null || true'));
		lines.push("");
		lines.push('echo "=== check:platform-smoke ==="');
		lines.push('PI_CURSOR_SKIP_RELEASE_VERSION_GUARD=1 npm run check:platform-smoke >"$PACK_DIR/check-platform-smoke.stdout.txt" 2>"$PACK_DIR/check-platform-smoke.stderr.txt"');
		lines.push("CHECK_PLATFORM_SMOKE_EXIT=$?");
		lines.push('echo "PLATFORM_CHECK_PLATFORM_SMOKE_EXIT=$CHECK_PLATFORM_SMOKE_EXIT"');
		lines.push(...posixSection("CHECK_PLATFORM_SMOKE_STDOUT", 'cat "$PACK_DIR/check-platform-smoke.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("CHECK_PLATFORM_SMOKE_STDERR", 'cat "$PACK_DIR/check-platform-smoke.stderr.txt" 2>/dev/null || true'));
		lines.push("");
		lines.push('echo "=== npm test ==="');
		lines.push('PI_CURSOR_SKIP_RELEASE_VERSION_GUARD=1 npm test >"$PACK_DIR/npm-test.stdout.txt" 2>"$PACK_DIR/npm-test.stderr.txt"');
		lines.push("TEST_EXIT=$?");
		lines.push('echo "PLATFORM_NPM_TEST_EXIT=$TEST_EXIT"');
		lines.push(...posixSection("NPM_TEST_STDOUT", 'cat "$PACK_DIR/npm-test.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("NPM_TEST_STDERR", 'cat "$PACK_DIR/npm-test.stderr.txt" 2>/dev/null || true'));
		lines.push("");
		lines.push('echo "=== typecheck ==="');
		lines.push('npm run typecheck >"$PACK_DIR/typecheck.stdout.txt" 2>"$PACK_DIR/typecheck.stderr.txt"');
		lines.push("TC_EXIT=$?");
		lines.push('echo "PLATFORM_TYPECHECK_EXIT=$TC_EXIT"');
		lines.push(...posixSection("TYPECHECK_STDOUT", 'cat "$PACK_DIR/typecheck.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("TYPECHECK_STDERR", 'cat "$PACK_DIR/typecheck.stderr.txt" 2>/dev/null || true'));
		lines.push("");
		lines.push('echo "=== npm pack ==="');
		lines.push('PACK_TARBALL=$(npm pack --silent >"$PACK_DIR/npm-pack.stdout.txt" 2>"$PACK_DIR/npm-pack.stderr.txt" && cat "$PACK_DIR/npm-pack.stdout.txt")');
		lines.push("PACK_EXIT=$?");
		lines.push('echo "PLATFORM_NPM_PACK_EXIT=$PACK_EXIT"');
		lines.push(...posixSection("NPM_PACK_STDOUT", 'cat "$PACK_DIR/npm-pack.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("NPM_PACK_STDERR", 'cat "$PACK_DIR/npm-pack.stderr.txt" 2>/dev/null || true'));
		lines.push('if [ -n "$PACK_TARBALL" ] && [ -f "$PACK_TARBALL" ]; then mv "$PACK_TARBALL" "$PACK_DIR/$PACK_TARBALL"; fi');
		lines.push('echo "PLATFORM_PACKED_TARBALL=$PACK_TARBALL"');
		lines.push('printf "%s\\n" "$PACK_TARBALL" > "$PACK_DIR/packed-tarball.txt"');
		lines.push("");
		lines.push('echo "=== fixture workspace ==="');
		lines.push('cp package.json README.md "$TEST_WORKSPACE"/ 2>"$PACK_DIR/fixture.stderr.txt"');
		lines.push('FIXTURE_COPY_EXIT=$?');
		lines.push('cp -R src "$TEST_WORKSPACE"/ 2>>"$PACK_DIR/fixture.stderr.txt"');
		lines.push('SRC_COPY_EXIT=$?');
		lines.push('if [ "$FIXTURE_COPY_EXIT" -eq 0 ] && [ "$SRC_COPY_EXIT" -eq 0 ]; then FIXTURE_EXIT=0; else FIXTURE_EXIT=1; fi');
		lines.push('cat "$PACK_DIR/fixture.stderr.txt"');
		lines.push('echo "PLATFORM_FIXTURE_EXIT=$FIXTURE_EXIT"');
		lines.push("");
		lines.push('echo "=== pi install packed tarball ==="');
		lines.push('PI_CLI="$(pwd)/node_modules/.bin/pi"');
		lines.push('if [ ! -x "$PI_CLI" ]; then PI_CLI="$(command -v pi || true)"; fi');
		lines.push('echo "PLATFORM_PI_CLI=$PI_CLI"');
		lines.push('if [ -n "$PACK_TARBALL" ] && [ -n "$PI_CLI" ] && [ -f "$PACK_DIR/$PACK_TARBALL" ]; then (cd "$PI_PROJECT" && npm init -y >"$PACK_DIR/packed-node-install.stdout.txt" 2>"$PACK_DIR/packed-node-install.stderr.txt" && npm install --no-save "$PACK_DIR/$PACK_TARBALL" >>"$PACK_DIR/packed-node-install.stdout.txt" 2>>"$PACK_DIR/packed-node-install.stderr.txt"); PACKED_NODE_INSTALL_EXIT=$?; else echo "missing pi cli or tarball" >"$PACK_DIR/packed-node-install.stderr.txt"; PACKED_NODE_INSTALL_EXIT=1; fi');
		lines.push('echo "PLATFORM_PACKED_NODE_INSTALL_EXIT=$PACKED_NODE_INSTALL_EXIT"');
		lines.push(...posixSection("PACKED_NODE_INSTALL_STDOUT", 'cat "$PACK_DIR/packed-node-install.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("PACKED_NODE_INSTALL_STDERR", 'cat "$PACK_DIR/packed-node-install.stderr.txt" 2>/dev/null || true'));
		lines.push(`if [ "$PACKED_NODE_INSTALL_EXIT" -eq 0 ] && [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" install -l ./node_modules/${packageName} >"$PACK_DIR/pi-install.stdout.txt" 2>"$PACK_DIR/pi-install.stderr.txt"); PI_INSTALL_EXIT=$?; else echo "packed npm install failed or missing pi cli" >"$PACK_DIR/pi-install.stderr.txt"; PI_INSTALL_EXIT=1; fi`);
		lines.push('echo "PLATFORM_PI_INSTALL_EXIT=$PI_INSTALL_EXIT"');
		lines.push(...posixSection("PI_INSTALL_STDOUT", 'cat "$PACK_DIR/pi-install.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("PI_INSTALL_STDERR", 'cat "$PACK_DIR/pi-install.stderr.txt" 2>/dev/null || true'));
		lines.push("");
		lines.push('echo "=== pi list ==="');
		lines.push('if [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" list >"$PACK_DIR/pi-list.stdout.txt" 2>"$PACK_DIR/pi-list.stderr.txt"); PI_LIST_EXIT=$?; else echo "missing pi cli" >"$PACK_DIR/pi-list.stderr.txt"; PI_LIST_EXIT=1; fi');
		lines.push('echo "PLATFORM_PI_LIST_EXIT=$PI_LIST_EXIT"');
		lines.push(...posixSection("PI_LIST_STDOUT", 'cat "$PACK_DIR/pi-list.stdout.txt" 2>/dev/null || true'));
		lines.push(...posixSection("PI_LIST_STDERR", 'cat "$PACK_DIR/pi-list.stderr.txt" 2>/dev/null || true'));
		lines.push("");
		lines.push('echo "node=$NODE_VERSION_EXIT ci=$CI_EXIT checkPlatformSmoke=$CHECK_PLATFORM_SMOKE_EXIT test=$TEST_EXIT typecheck=$TC_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"');
		lines.push('if [ "$NODE_VERSION_EXIT" -ne 0 ] || [ "$CI_EXIT" -ne 0 ] || [ "$CHECK_PLATFORM_SMOKE_EXIT" -ne 0 ] || [ "$TEST_EXIT" -ne 0 ] || [ "$TC_EXIT" -ne 0 ] || [ "$PACK_EXIT" -ne 0 ] || [ "$FIXTURE_EXIT" -ne 0 ] || [ "$PACKED_NODE_INSTALL_EXIT" -ne 0 ] || [ "$PI_INSTALL_EXIT" -ne 0 ] || [ "$PI_LIST_EXIT" -ne 0 ]; then');
		lines.push('  echo "PLATFORM_BUILD_FAILED: node=$NODE_VERSION_EXIT ci=$CI_EXIT checkPlatformSmoke=$CHECK_PLATFORM_SMOKE_EXIT test=$TEST_EXIT typecheck=$TC_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"');
		lines.push("  exit 1");
		lines.push("fi");
		lines.push('echo "PLATFORM_BUILD_OK"');
	} else {
		lines.push(`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\platform-smoke\\platform-build-windows.ps1 -PackageName ${packageName} -NodeValidationMajor ${nodeValidationMajor}`);
	}
	return lines.join("\n");
}

async function executeLiveSuite(config, targetName, suiteName, suiteDir, slug, leaseSession) {
	const scenario = getScenario(suiteName);
	const startedAt = Date.now();
	const command = buildLiveSuiteCommand(config, targetName, suiteName, leaseSession?.livePrepDir);
	writeCommand(suiteDir, command);
	let warmup = leaseSession;
	const ownsLease = !warmup;

	if (!warmup) {
		console.log(`  warmup ${targetName}...`);
		warmup = await warmupLease(targetName, slug, config);
		if (!warmup.ok) {
			writeExitCode(suiteDir, warmup.code, warmup.signal);
			writeRedactedFile(resolve(suiteDir, "crabbox.warmup.stdout.txt"), warmup.stdout);
			writeRedactedFile(resolve(suiteDir, "crabbox.warmup.stderr.txt"), warmup.stderr);
			return failSuite(suiteDir, targetName, suiteName, `Crabbox warmup failed (exit ${warmup.code}): ${warmup.stderr.slice(-500)}`);
		}
	}

	console.log(`  executing live suite on ${targetName}...`);
	const result = await runOnLeaseWithTransientRetry(suiteDir, targetName, warmup.leaseId, command, {
		shell: true,
		timeout: 900_000,
		allowEnv: ["CURSOR_API_KEY"],
		sync: leaseSession?.sync,
		config,
	});
	const elapsed = Date.now() - startedAt;
	writeRedactedFile(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout);
	writeRedactedFile(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr);
	writeFileSync(resolve(suiteDir, "crabbox.timing.json"), JSON.stringify({
		startedAt: new Date(startedAt).toISOString(),
		elapsedMs: elapsed,
		code: result.code,
		signal: result.signal,
	}, null, 2));
	writeExitCode(suiteDir, result.code, result.signal);

	let stopResult;
	if (ownsLease) {
		console.log(`  stopping lease ${warmup.leaseId}...`);
		stopResult = await stopLease(targetName, warmup.leaseId, config);
		writeStopLeaseArtifacts(suiteDir, stopResult);
	}

	const bundle = extractLiveBundle(suiteDir, result.stdout);
	const liveArtifactDir = resolve(suiteDir, "artifacts");
	mkdirSync(liveArtifactDir, { recursive: true });
	const terminalAnsi = resolve(liveArtifactDir, "terminal.ansi");
	const terminalTxt = resolve(liveArtifactDir, "terminal.txt");
	let renderResult = { pngOk: false };
	let cards = [];
	if (existsSync(terminalAnsi)) {
		renderResult = await renderAll(terminalAnsi, liveArtifactDir, {
			label: `${targetName}-${suiteName}`,
			model: config.cursorModel,
			mode: "agent",
			sessionId: `${targetName}-${suiteName}`,
		});
	}
	if (existsSync(terminalTxt)) {
		cards = detectCards(readFileSync(terminalTxt, "utf8"));
		writeCardArtifacts(liveArtifactDir, cards);
	}

	const statusPath = resolve(liveArtifactDir, "live-status.json");
	const status = readJson(statusPath);
	const terminalText = existsSync(terminalTxt) ? readFileSync(terminalTxt, "utf8") : "";
	const jsonlPath = resolve(liveArtifactDir, "session.jsonl");
	const jsonlRaw = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : "";
	const cardChecks = assertRequiredCards(liveArtifactDir, cards, scenario?.requiredCards ?? []);
	const jsonlToolNames = collectJsonlToolNames(jsonlRaw);
	const jsonlResults = collectJsonlToolResults(jsonlRaw);
	const usageChecks = collectUsageChecks(jsonlRaw);
	writeFileSync(resolve(liveArtifactDir, "jsonl-tool-names.json"), JSON.stringify([...jsonlToolNames].sort(), null, 2));
	writeFileSync(resolve(liveArtifactDir, "jsonl-tool-results.json"), JSON.stringify(jsonlResults, null, 2));
	const jsonlToolChecks = (scenario?.requiredJSONLTools ?? []).map(({ name }) => ({
		id: `jsonl-tool-${name}`,
		fn: () => jsonlToolNames.has(name),
	}));
	const jsonlResultChecks = (scenario?.requiredJSONLResults ?? []).map((requirement) => ({
		id: `jsonl-result-${requirement.id}`,
		fn: () => jsonlResults.some((result) => matchesJsonlResult(result, requirement)),
	}));
	const bridgeDiagnostics = [
		...collectBridgeDiagnostics(terminalText),
		...collectBridgeDiagnosticFile(resolve(liveArtifactDir, "bridge-diagnostics.jsonl")),
	];
	writeFileSync(resolve(liveArtifactDir, "bridge-diagnostics.json"), JSON.stringify(bridgeDiagnostics, null, 2));
	const bridgeDiagnosticChecks = scenario?.requiredBridgeDiagnostics === "abort" ? [
		{ id: "bridge-diagnostic-run-created", fn: () => bridgeDiagnostics.some((event) => event.event === "run_created") },
		{ id: "bridge-diagnostic-tools-exposed", fn: () => bridgeDiagnostics.some((event) => event.event === "tools_exposed") },
		{ id: "bridge-diagnostic-request-queued", fn: () => bridgeDiagnostics.some((event) => event.event === "request_queued" && event.piToolName === "bash") },
		{ id: "bridge-diagnostic-run-cancelled", fn: () => bridgeDiagnostics.some((event) => event.event === "run_cancelled") },
		{ id: "bridge-diagnostic-request-rejected", fn: () => bridgeDiagnostics.some((event) => event.event === "request_rejected" && event.piToolName === "bash" && event.rejectionKind === "cancelled") },
	] : scenario?.requiredBridgeDiagnostics ? [
		{ id: "bridge-diagnostic-run-created", fn: () => bridgeDiagnostics.some((event) => event.event === "run_created") },
		{ id: "bridge-diagnostic-tools-exposed", fn: () => bridgeDiagnostics.some((event) => event.event === "tools_exposed") },
		{ id: "bridge-diagnostic-request-resolved", fn: () => bridgeDiagnostics.some((event) => event.event === "request_resolved") },
	] : [];
	const visualEvidenceSpecs = scenario?.visualEvidence ?? [];
	const visualEvidence = existsSync(resolve(liveArtifactDir, "terminal.html"))
		? await collectVisualEvidence({
			htmlPath: resolve(liveArtifactDir, "terminal.html"),
			pngPath: resolve(liveArtifactDir, "terminal.full.png"),
			outDir: liveArtifactDir,
			specs: visualEvidenceSpecs,
		})
		: { ok: false, checks: [{ id: "visual-html-present", ok: false, error: "terminal.html missing" }] };
	const visualEvidenceResultChecks = visualEvidenceSpecs
		.filter((spec) => spec.jsonlResultId)
		.map((spec) => ({
			id: `visual-jsonl-state-${spec.id}`,
			fn: () => {
				const visualItem = visualEvidence.items?.find((item) => item.id === spec.id);
				const resultRequirement = scenario?.requiredJSONLResults?.find((requirement) => requirement.id === spec.jsonlResultId);
				return visualItem?.ok === true && Boolean(resultRequirement && jsonlResults.some((result) => matchesJsonlResult(result, resultRequirement)));
			},
		}));
	const violations = [
		...scanForSecrets(result.stdout + result.stderr + terminalText + jsonlRaw).map((violation) => ({ file: "process-output", violation })),
		...bundle.violations,
		...scanArtifacts(suiteDir),
	];
	if (violations.length > 0) writeFileSync(resolve(suiteDir, "redaction-violations.json"), JSON.stringify(violations, null, 2));
	const providerDebugFiles = findFiles(resolve(suiteDir, "cursor-sdk-events"));

	const checks = [
		{ id: "live-exit-zero", fn: () => result.code === 0 },
		{ id: "bundle-extracted", fn: () => bundle.ok },
		{ id: "live-status-ok", fn: () => status?.ok === true },
		{ id: "cursor-no-fast", fn: () => readJson(resolve(liveArtifactDir, "pi-command.json"))?.args?.includes("--cursor-no-fast") === true },
		{ id: "cursor-model", fn: () => readJson(resolve(liveArtifactDir, "pi-command.json"))?.args?.includes(config.cursorModel) === true },
		{ id: "terminal-ansi", fn: () => existsSync(terminalAnsi) && readFileSync(terminalAnsi).length > 0 },
		{ id: "terminal-text", fn: () => terminalText.length > 0 },
		{ id: "terminal-html", fn: () => existsSync(resolve(liveArtifactDir, "terminal.html")) },
		{ id: "terminal-png", fn: () => renderResult.pngOk && existsSync(resolve(liveArtifactDir, "terminal.final-viewport.png")) },
		{ id: "session-jsonl", fn: () => jsonlRaw.length > 0 },
		{ id: "provider-debug-artifacts", fn: () => providerDebugFiles.some((file) => file.endsWith("session.json")) && providerDebugFiles.length > 1 },
		...(suiteName !== "cursor-abort-cleanup" ? [
			{ id: "jsonl-usage-non-negative", fn: () => usageChecks.seen && usageChecks.nonNegative },
			{ id: "jsonl-cache-zero", fn: () => usageChecks.seen && usageChecks.cacheZero },
		] : []),
		{ id: "final-marker", fn: () => scenario?.finalMarker ? status?.finalMarkerObserved === true : status?.ok === true },
		...(suiteName === "cursor-abort-cleanup" ? [{ id: "abort-no-successful-answer", fn: () => !hasAbortSuccessClaim(jsonlRaw) }] : []),
		{ id: "no-secrets", fn: () => violations.length === 0 },
		...cardChecks.map((check) => ({ id: check.id, fn: () => check.ok })),
		...jsonlToolChecks,
		...jsonlResultChecks,
		...bridgeDiagnosticChecks,
		...(visualEvidence.checks ?? []).map((check) => ({ id: check.id, fn: () => check.ok === true, error: check.error })),
		...visualEvidenceResultChecks,
	];
	if (stopResult) checks.push(stopLeaseCheck(stopResult));
	const expectedFiles = [
		"summary.json", "target.json", "suite.json", "command.txt", "exit-code.txt",
		"crabbox.stdout.txt", "crabbox.stderr.txt", "crabbox.timing.json", "assertions.json",
		"artifacts/terminal.ansi", "artifacts/terminal.txt", "artifacts/terminal.html",
		"artifacts/terminal.full.png", "artifacts/terminal.final-viewport.png", "artifacts/session.jsonl",
		"artifacts/live-status.json", "artifacts/cards/cards.json", "artifacts/cards/index.html",
		"artifacts/visual-evidence.json", "artifacts/jsonl-tool-results.json", "artifacts/bridge-diagnostics.json", "artifacts/bridge-diagnostics.jsonl",
	];
	if (suiteName === "cursor-abort-cleanup") {
		expectedFiles.push("artifacts/abort-started.txt", "logs/process-before.stdout.txt", "logs/process-after.stdout.txt", "logs/leftover-process-check.stdout.txt");
	}
	if (stopResult) expectedFiles.push("crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt");
	const { assertions } = finalizeSuiteArtifacts(suiteDir, checks, {
		target: targetName,
		suite: suiteName,
		exitCode: result.code,
		signal: result.signal,
		elapsedMs: elapsed,
	}, expectedFiles);
	console.log(`  ${assertions.ok ? "PASS" : "FAIL"} ${suiteName} on ${targetName} (${elapsed}ms)`);
	return { ok: assertions.ok, suiteDir, assertions };
}

async function runOnLeaseWithTransientRetry(suiteDir, targetName, leaseId, command, options) {
	const first = await runOnLease(targetName, leaseId, command, options);
	if (!isTransientCrabboxSshFailure(first)) return first;
	writeRedactedFile(resolve(suiteDir, "crabbox.retry1.stdout.txt"), first.stdout);
	writeRedactedFile(resolve(suiteDir, "crabbox.retry1.stderr.txt"), first.stderr);
	await new Promise((resolveRetry) => setTimeout(resolveRetry, 10_000));
	return await runOnLease(targetName, leaseId, command, { ...options, sync: false });
}

function isTransientCrabboxSshFailure(result) {
	const text = `${result.stdout}\n${result.stderr}`;
	return result.code === 255 && /ssh: connect to host .*\b(Operation timed out|Connection timed out)\b/i.test(text);
}

function buildLiveSuiteCommand(config, targetName, suiteName, prepDir) {
	const model = config.cursorModel ?? "cursor/composer-2-5";
	const packageName = config.packageName ?? "pi-cursor-sdk";
	const prepArgs = prepDir ? ` --prep-dir ${platformFor(targetName) === "powershell" ? prepDir : shellQuote(prepDir)}` : "";
	if (platformFor(targetName) === "powershell") {
		return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "node scripts/platform-smoke/live-suite-runner.mjs --suite ${suiteName} --target ${targetName} --model ${model} --package-name ${packageName}${prepArgs}"`;
	}
	return `node scripts/platform-smoke/live-suite-runner.mjs --suite ${shellQuote(suiteName)} --target ${shellQuote(targetName)} --model ${shellQuote(model)} --package-name ${shellQuote(packageName)}${prepArgs}`;
}

function extractLiveBundle(suiteDir, stdout) {
	const start = stdout.indexOf("PLATFORM_LIVE_BUNDLE_JSON_START");
	const end = stdout.indexOf("PLATFORM_LIVE_BUNDLE_JSON_END", start);
	if (start === -1 || end === -1) return { ok: false, violations: [] };
	const jsonText = stdout.slice(start + "PLATFORM_LIVE_BUNDLE_JSON_START".length, end).trim();
	let bundle;
	try { bundle = JSON.parse(jsonText); } catch { return { ok: false, violations: [] }; }
	if (!Array.isArray(bundle.files)) return { ok: false, violations: [] };
	const violations = [];
	for (const file of bundle.files) {
		if (!file?.path || typeof file.contentBase64 !== "string") continue;
		if (!isSafeBundlePath(suiteDir, file.path)) return { ok: false, violations };
		const outPath = resolve(suiteDir, file.path);
		mkdirSync(dirname(outPath), { recursive: true });
		const content = Buffer.from(file.contentBase64, "base64");
		if (isTextArtifactPath(file.path)) {
			const text = content.toString("utf8");
			violations.push(...scanForSecrets(text).map((violation) => ({ file: file.path, violation })));
			if (file.path.endsWith("redaction-violations.json")) {
				violations.push(...readRedactionViolationList(text, file.path));
			}
			writeFileSync(outPath, redactSecrets(text));
		} else {
			writeFileSync(outPath, content);
		}
	}
	return { ok: true, violations };
}

function readRedactionViolationList(text, fallbackFile) {
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item) => typeof item?.violation === "string")
			.map((item) => ({ file: typeof item.file === "string" ? item.file : fallbackFile, violation: item.violation }));
	} catch {
		return [];
	}
}

function isTextArtifactPath(path) {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return ["txt", "json", "jsonl", "md", "log", "ansi", "html", "yml", "yaml", "js", "mjs", "ts"].includes(ext);
}

export function isSafeBundlePath(suiteDir, bundlePath) {
	if (typeof bundlePath !== "string" || bundlePath.length === 0) return false;
	if (isAbsolute(bundlePath) || /^[A-Za-z]:[\\/]/.test(bundlePath)) return false;
	const outPath = resolve(suiteDir, bundlePath);
	const rel = relative(suiteDir, outPath);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function readJson(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function findFiles(root) {
	const files = [];
	function visit(dir) {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(path);
		}
	}
	visit(root);
	return files;
}

function collectBridgeDiagnosticFile(path) {
	let raw;
	try { raw = readFileSync(path, "utf8"); } catch { return []; }
	const events = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try { events.push(JSON.parse(line)); } catch {}
	}
	return events;
}

function collectBridgeDiagnostics(terminalText) {
	const prefix = "[pi-cursor-sdk:bridge] ";
	const events = [];
	for (const line of terminalText.split(/\r?\n/)) {
		const index = line.indexOf(prefix);
		if (index === -1) continue;
		const jsonText = line.slice(index + prefix.length).trim();
		try { events.push(JSON.parse(jsonText)); } catch {}
	}
	return events;
}

function collectUsageChecks(jsonlRaw) {
	let seen = false;
	let nonNegative = true;
	let cacheZero = true;
	for (const line of jsonlRaw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const usage = event?.message?.usage;
		if (!usage || typeof usage !== "object") continue;
		seen = true;
		for (const value of Object.values(usage)) {
			if (typeof value === "number" && value < 0) nonNegative = false;
		}
		if (typeof usage.cacheRead === "number" && usage.cacheRead !== 0) cacheZero = false;
		if (typeof usage.cacheWrite === "number" && usage.cacheWrite !== 0) cacheZero = false;
	}
	return { seen, nonNegative, cacheZero };
}

export function hasAbortSuccessClaim(jsonlRaw) {
	for (const line of jsonlRaw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const message = event?.message;
		if (message?.role !== "assistant") continue;
		const text = extractFinalTextContent(message.content);
		if (/\b(?:done|complete|completed|success|succeeded|finished)\b/i.test(text)) return true;
	}
	return false;
}

function collectJsonlToolNames(jsonlRaw) {
	const names = new Set();
	for (const line of jsonlRaw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const message = event?.message;
		if (typeof message?.toolName === "string") names.add(message.toolName);
		for (const block of message?.content ?? []) {
			if (typeof block?.name === "string") names.add(block.name);
			if (typeof block?.details?.sourceToolName === "string") names.add(block.details.sourceToolName);
		}
		if (typeof message?.details?.sourceToolName === "string") names.add(message.details.sourceToolName);
	}
	return names;
}

function collectJsonlToolResults(jsonlRaw) {
	const results = [];
	for (const line of jsonlRaw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const message = event?.message;
		if (message?.role !== "toolResult" || typeof message.toolName !== "string") continue;
		const contentText = extractContentText(message.content);
		results.push({
			toolName: message.toolName,
			isError: message.isError === true,
			sourceToolName: message.details?.sourceToolName,
			path: message.details?.path,
			contentText,
		});
	}
	return results;
}

function matchesJsonlResult(result, requirement) {
	if (requirement.toolName && result.toolName !== requirement.toolName) return false;
	if (requirement.sourceToolName && result.sourceToolName !== requirement.sourceToolName) return false;
	if (typeof requirement.isError === "boolean" && result.isError !== requirement.isError) return false;
	const haystack = `${result.contentText}\n${result.path ?? ""}`;
	if (requirement.contains && !haystack.includes(requirement.contains)) return false;
	if (requirement.pattern && !(new RegExp(requirement.pattern, requirement.flags ?? "i")).test(haystack)) return false;
	return true;
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Write a failure suite result. Used for live suite hard failures during
 * warmup/execution and for unknown suites.
 */
function failSuite(suiteDir, targetName, suiteName, message) {
	const safeMessage = redactSecrets(message);
	console.log(`  FAIL ${suiteName} on ${targetName}: ${safeMessage}`);

	writeCommand(suiteDir, `# ${suiteName} — ${safeMessage}`);
	writeExitCode(suiteDir, 1, null);

	const checks = [{ id: "execution", fn: () => false, error: safeMessage }];
	const { assertions } = finalizeSuiteArtifacts(
		suiteDir,
		checks,
		{ target: targetName, suite: suiteName, exitCode: 1, error: safeMessage },
		[
			"summary.json", "target.json", "suite.json",
			"command.txt", "exit-code.txt",
			"assertions.json",
		],
	);

	return { ok: false, suiteDir, assertions };
}
