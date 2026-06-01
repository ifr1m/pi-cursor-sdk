/**
 * Target runner — real suite execution, artifact writing, and fail-through.
 *
 * Each target session: warmup → run suites → artifacts → stop.
 * Live suites execute real Cursor-backed PTY/ConPTY runs and fail through with artifacts.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { createSuiteDir, writeManifest, writeSummary, writeCommand, writeExitCode, scanArtifacts, scanForSecrets } from "./artifacts.mjs";
import { runAssertions } from "./assertions.mjs";
import { getScenario } from "./scenarios.mjs";
import { warmupLease, runOnLease, stopLease } from "./crabbox-runner.mjs";
import { renderAll } from "./render-ansi.mjs";
import { assertRequiredCards, detectCards, writeCardArtifacts } from "./card-detect.mjs";
import { collectVisualEvidence } from "./visual-evidence.mjs";
import { extractContentText } from "./jsonl-text.mjs";

export function platformFor(targetName) {
	return targetName === "windows-native" ? "powershell" : "posix";
}

function makeRunId() {
	return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Execute a single suite on a target.
 * Returns { ok, suiteDir, assertions }.
 * On failure, writes fail-through artifacts but does not throw.
 */
export async function runTargetSuite(config, targetName, suiteName, leaseSession) {
	const scenario = getScenario(suiteName);
	const runId = makeRunId();
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
	console.log(`  warmup ${targetName}...`);
	const warmup = await warmupLease(targetName, slug);
	if (!warmup.ok) {
		const suiteName = suiteNames[0] ?? "platform-build";
		const runId = makeRunId();
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
		writeFileSync(resolve(suiteDir, "crabbox.warmup.stdout.txt"), warmup.stdout);
		writeFileSync(resolve(suiteDir, "crabbox.warmup.stderr.txt"), warmup.stderr);
		const failed = failSuite(suiteDir, targetName, suiteName, `Crabbox warmup failed (exit ${warmup.code}): ${warmup.stderr.slice(-500)}`);
		return { ok: false, results: [failed] };
	}

	const results = [];
	let sync = true;
	const livePrepDir = `.platform-smoke-runs/live-prep-${Date.now()}-${targetName}`;
	try {
		for (const suiteName of suiteNames) {
			console.log(`  Suite: ${suiteName}`);
			const result = await runTargetSuite(config, targetName, suiteName, { ...warmup, sync, livePrepDir });
			results.push(result);
			sync = false;
			if (!result.ok) break;
		}
	} finally {
		console.log(`  stopping lease ${warmup.leaseId}...`);
		await stopLease(targetName, warmup.leaseId);
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
		warmup = await warmupLease(targetName, slug);
		if (!warmup.ok) {
			writeExitCode(suiteDir, warmup.code, warmup.signal);
			writeFileSync(resolve(suiteDir, "crabbox.warmup.stdout.txt"), warmup.stdout);
			writeFileSync(resolve(suiteDir, "crabbox.warmup.stderr.txt"), warmup.stderr);
			return failSuite(suiteDir, targetName, "platform-build",
				`Crabbox warmup failed (exit ${warmup.code}): ${warmup.stderr.slice(-500)}`);
		}
	}

	console.log(`  executing build shell on ${targetName}...`);
	const result = await runOnLease(targetName, warmup.leaseId, command, {
		shell: true,
		timeout: 600_000,
		sync: leaseSession?.sync,
	});

	const elapsed = Date.now() - startedAt;

	// Write artifact files
	writeFileSync(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout);
	writeFileSync(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr);
	writeFileSync(resolve(suiteDir, "crabbox.timing.json"), JSON.stringify({
		startedAt: new Date(startedAt).toISOString(),
		elapsedMs: elapsed,
		code: result.code,
		signal: result.signal,
	}, null, 2));
	writeCommand(suiteDir, command);
	writeExitCode(suiteDir, result.code, result.signal);

	if (ownsLease) {
		console.log(`  stopping lease ${warmup.leaseId}...`);
		await stopLease(targetName, warmup.leaseId);
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

	const assertions = runAssertions(suiteDir, checks);

	// Write summary
	writeSummary(suiteDir, {
		target: targetName,
		suite: "platform-build",
		ok: assertions.ok,
		exitCode: result.code,
		signal: result.signal,
		elapsedMs: elapsed,
	});

	// Write manifest
	const expectedFiles = [
		"summary.json", "target.json", "suite.json",
		"command.txt", "exit-code.txt",
		"crabbox.stdout.txt", "crabbox.stderr.txt", "crabbox.timing.json",
		"packed-tarball.txt", "packed-node-install.stdout.txt", "packed-node-install.stderr.txt",
		"pi-install.stdout.txt", "pi-install.stderr.txt",
		"pi-list.stdout.txt", "pi-list.stderr.txt",
		"assertions.json",
	];
	if (!assertions.ok) expectedFiles.push("failures.md");
	writeManifest(suiteDir, expectedFiles);

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
	writeFileSync(resolve(suiteDir, "packed-tarball.txt"), `${markerValue(stdout, "PLATFORM_PACKED_TARBALL")}\n`);
	writeFileSync(resolve(suiteDir, "packed-node-install.stdout.txt"), section(stdout, "PACKED_NODE_INSTALL_STDOUT"));
	writeFileSync(resolve(suiteDir, "packed-node-install.stderr.txt"), section(stdout, "PACKED_NODE_INSTALL_STDERR"));
	writeFileSync(resolve(suiteDir, "pi-install.stdout.txt"), section(stdout, "PI_INSTALL_STDOUT"));
	writeFileSync(resolve(suiteDir, "pi-install.stderr.txt"), section(stdout, "PI_INSTALL_STDERR"));
	writeFileSync(resolve(suiteDir, "pi-list.stdout.txt"), section(stdout, "PI_LIST_STDOUT"));
	writeFileSync(resolve(suiteDir, "pi-list.stderr.txt"), section(stdout, "PI_LIST_STDERR"));
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
		lines.push('NODE_MAJOR=${NODE_VERSION#v}');
		lines.push('NODE_MAJOR=${NODE_MAJOR%%.*}');
		lines.push('echo "PLATFORM_NODE_VERSION=$NODE_VERSION"');
		lines.push(`if [ "$NODE_MAJOR" -ge ${nodeValidationMajor} ]; then NODE_VERSION_EXIT=0; else NODE_VERSION_EXIT=1; fi`);
		lines.push('echo "PLATFORM_NODE_VERSION_EXIT=$NODE_VERSION_EXIT"');
		lines.push('');
		lines.push('echo "=== npm ci ==="');
		lines.push("npm ci 2>&1");
		lines.push("CI_EXIT=$?");
		lines.push('echo "PLATFORM_NPM_CI_EXIT=$CI_EXIT"');
		lines.push("");
		lines.push('echo "=== npm test ==="');
		lines.push("PI_CURSOR_SKIP_RELEASE_VERSION_GUARD=1 npm test 2>&1");
		lines.push("TEST_EXIT=$?");
		lines.push('echo "PLATFORM_NPM_TEST_EXIT=$TEST_EXIT"');
		lines.push("");
		lines.push('echo "=== typecheck ==="');
		lines.push("npm run typecheck 2>&1");
		lines.push("TC_EXIT=$?");
		lines.push('echo "PLATFORM_TYPECHECK_EXIT=$TC_EXIT"');
		lines.push("");
		lines.push('echo "=== npm pack ==="');
		lines.push('PACK_TARBALL=$(npm pack --silent 2>"$PACK_DIR/npm-pack.stderr.txt")');
		lines.push("PACK_EXIT=$?");
		lines.push('cat "$PACK_DIR/npm-pack.stderr.txt"');
		lines.push('echo "PLATFORM_NPM_PACK_EXIT=$PACK_EXIT"');
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
		lines.push('echo "node=$NODE_VERSION_EXIT ci=$CI_EXIT test=$TEST_EXIT typecheck=$TC_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"');
		lines.push('if [ "$NODE_VERSION_EXIT" -ne 0 ] || [ "$CI_EXIT" -ne 0 ] || [ "$TEST_EXIT" -ne 0 ] || [ "$TC_EXIT" -ne 0 ] || [ "$PACK_EXIT" -ne 0 ] || [ "$FIXTURE_EXIT" -ne 0 ] || [ "$PACKED_NODE_INSTALL_EXIT" -ne 0 ] || [ "$PI_INSTALL_EXIT" -ne 0 ] || [ "$PI_LIST_EXIT" -ne 0 ]; then');
		lines.push('  echo "PLATFORM_BUILD_FAILED: node=$NODE_VERSION_EXIT ci=$CI_EXIT test=$TEST_EXIT typecheck=$TC_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"');
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
		warmup = await warmupLease(targetName, slug);
		if (!warmup.ok) {
			writeExitCode(suiteDir, warmup.code, warmup.signal);
			writeFileSync(resolve(suiteDir, "crabbox.warmup.stdout.txt"), warmup.stdout);
			writeFileSync(resolve(suiteDir, "crabbox.warmup.stderr.txt"), warmup.stderr);
			return failSuite(suiteDir, targetName, suiteName, `Crabbox warmup failed (exit ${warmup.code}): ${warmup.stderr.slice(-500)}`);
		}
	}

	console.log(`  executing live suite on ${targetName}...`);
	const result = await runOnLeaseWithTransientRetry(suiteDir, targetName, warmup.leaseId, command, {
		shell: true,
		timeout: 900_000,
		allowEnv: ["CURSOR_API_KEY"],
		sync: leaseSession?.sync,
	});
	const elapsed = Date.now() - startedAt;
	writeFileSync(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout);
	writeFileSync(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr);
	writeFileSync(resolve(suiteDir, "crabbox.timing.json"), JSON.stringify({
		startedAt: new Date(startedAt).toISOString(),
		elapsedMs: elapsed,
		code: result.code,
		signal: result.signal,
	}, null, 2));
	writeExitCode(suiteDir, result.code, result.signal);

	if (ownsLease) {
		console.log(`  stopping lease ${warmup.leaseId}...`);
		await stopLease(targetName, warmup.leaseId);
	}

	const bundleOk = extractLiveBundle(suiteDir, result.stdout);
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
		...scanArtifacts(suiteDir),
	];
	if (violations.length > 0) writeFileSync(resolve(suiteDir, "redaction-violations.json"), JSON.stringify(violations, null, 2));
	const providerDebugFiles = findFiles(resolve(suiteDir, "cursor-sdk-events"));

	const checks = [
		{ id: "live-exit-zero", fn: () => result.code === 0 },
		{ id: "bundle-extracted", fn: () => bundleOk },
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
	const assertions = runAssertions(suiteDir, checks);
	writeSummary(suiteDir, {
		target: targetName,
		suite: suiteName,
		ok: assertions.ok,
		exitCode: result.code,
		signal: result.signal,
		elapsedMs: elapsed,
	});
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
	if (!assertions.ok) expectedFiles.push("failures.md");
	writeManifest(suiteDir, expectedFiles);
	console.log(`  ${assertions.ok ? "PASS" : "FAIL"} ${suiteName} on ${targetName} (${elapsed}ms)`);
	return { ok: assertions.ok, suiteDir, assertions };
}

async function runOnLeaseWithTransientRetry(suiteDir, targetName, leaseId, command, options) {
	const first = await runOnLease(targetName, leaseId, command, options);
	if (!isTransientCrabboxSshFailure(first)) return first;
	writeFileSync(resolve(suiteDir, "crabbox.retry1.stdout.txt"), first.stdout);
	writeFileSync(resolve(suiteDir, "crabbox.retry1.stderr.txt"), first.stderr);
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
	if (start === -1 || end === -1) return false;
	const jsonText = stdout.slice(start + "PLATFORM_LIVE_BUNDLE_JSON_START".length, end).trim();
	let bundle;
	try { bundle = JSON.parse(jsonText); } catch { return false; }
	if (!Array.isArray(bundle.files)) return false;
	for (const file of bundle.files) {
		if (!file?.path || typeof file.contentBase64 !== "string") continue;
		if (!isSafeBundlePath(suiteDir, file.path)) return false;
		const outPath = resolve(suiteDir, file.path);
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, Buffer.from(file.contentBase64, "base64"));
	}
	return true;
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

function hasAbortSuccessClaim(jsonlRaw) {
	for (const line of jsonlRaw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const message = event?.message;
		if (message?.role !== "assistant") continue;
		const text = extractContentText(message.content);
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
	console.log(`  FAIL ${suiteName} on ${targetName}: ${message}`);

	writeCommand(suiteDir, `# ${suiteName} — ${message}`);
	writeExitCode(suiteDir, 1, null);

	writeSummary(suiteDir, {
		target: targetName,
		suite: suiteName,
		ok: false,
		exitCode: 1,
		error: message,
	});

	const checks = [{ id: "execution", fn: () => false, _error: message }];
	const assertions = runAssertions(suiteDir, checks);

	const expectedFiles = [
		"summary.json", "target.json", "suite.json",
		"command.txt", "exit-code.txt",
		"assertions.json", "failures.md",
	];
	writeManifest(suiteDir, expectedFiles);

	return { ok: false, suiteDir, assertions };
}
