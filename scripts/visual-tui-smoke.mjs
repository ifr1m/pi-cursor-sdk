#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commonBooleanFlag, commonRepeatStringFlag, parseArgv } from "./lib/cursor-cli-args.mjs";
import { buildCursorSmokeEnvPlan, CURSOR_SDK_EVENT_DEBUG_ENV_NAMES, sealedNodePath } from "./lib/cursor-smoke-env.mjs";
import { buildTerminalHtml, writeTerminalScreenshot } from "./lib/cursor-visual-render.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WIDTH = 150;
const DEFAULT_HEIGHT = 45;
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_STARTUP_MS = 5_000;
const DEFAULT_HISTORY_LINES = 3_000;
const DEFAULT_MODEL = "cursor/composer-2.5";
const DEFAULT_MODE = "plan";
const DEFAULT_SETTING_SOURCES = "none";
const DEBUG_ENV_NAMES = CURSOR_SDK_EVENT_DEBUG_ENV_NAMES;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

function printHelp() {
	console.log(`Canonical offscreen TUI visual smoke runner for pi-cursor-sdk.

Usage:
  node scripts/visual-tui-smoke.mjs --label LABEL --prompt PROMPT [options]
  npm run smoke:visual -- --label LABEL --prompt PROMPT [options]

Required:
  --label LABEL                 Artifact filename prefix. Sanitized for paths.
  --prompt PROMPT               Prompt to paste into the interactive pi TUI.
                                Use --prompt-file PATH for multi-line prompts.

Common options:
  --ext PATH                    Extension repo to load with pi -e. Default: repo root.
  --cwd PATH                    Working directory for the pi session. Default: current directory.
  --out-dir PATH                Artifact directory. Default: /tmp/pi-cursor-sdk-visual-smoke-<timestamp>.
  --wait-ms N                   Milliseconds to wait after sending the prompt. Default: ${DEFAULT_WAIT_MS}.
  --startup-ms N                Milliseconds to wait before pasting the prompt. Default: ${DEFAULT_STARTUP_MS}.
  --model MODEL                 Cursor model. Default: ${DEFAULT_MODEL}.
  --mode agent|plan             Cursor SDK mode. Default: ${DEFAULT_MODE}.
  --session-dir PATH            pi session directory. Default: <out-dir>/<label>.session.
  --session-id ID               pi session id. Default: visual-<label>-<timestamp>.
  --width N                     PTY columns. Default: ${DEFAULT_WIDTH}.
  --height N                    PTY rows. Default: ${DEFAULT_HEIGHT}.
  --history-lines N             tmux capture history lines. Default: ${DEFAULT_HISTORY_LINES}.
  --setting-sources VALUE       Cursor setting sources. Default: ${DEFAULT_SETTING_SOURCES}.
  --bridge                      Opt in to the pi tool bridge for bridge-specific visual audits.
  --expose-builtin-tools        Opt in to exposing overlapping built-in pi tools to Cursor. Requires --bridge.
  --event-debug                 Set PI_CURSOR_SDK_EVENT_DEBUG=1 and write debug artifacts under <out-dir>.
  --leftover-pattern REGEX      After capture, fail if a process command still matches REGEX. Repeatable.
  --no-screenshot               Write .ansi/.txt/.html/.jsonl.path only; use agent_browser manually.
  --self-test                   Run the fake-PATH/env isolation probe without launching pi.
  -h, --help                    Show this help.

Native replay isolation defaults:
  PI_CURSOR_NATIVE_TOOL_DISPLAY=1
  PI_CURSOR_REGISTER_NATIVE_TOOLS=1
  PI_CURSOR_SETTING_SOURCES=none
  PI_CURSOR_PI_TOOL_BRIDGE=0
  PI_CURSOR_EXPOSE_BUILTIN_TOOLS=0
  TERM=xterm-256color
  Debug artifact env is cleared before each run; --event-debug sets a deterministic debug dir.

Artifacts written:
  <label>.ansi                  Raw tmux ANSI capture.
  <label>.txt                   Plain tmux text capture.
  <label>.html                  Self-contained browser/xterm render.
  <label>.png                   Browser-rendered screenshot, unless --no-screenshot.
  <label>.jsonl.path            Latest persisted pi session JSONL path.

Prerequisites:
  - pi, node, tmux, and npm-installed dev dependencies on PATH / in node_modules.
  - The runner resolves pi/tmux from the parent PATH, uses process.execPath for node, and seals pi-shim PATH for prereq checks and tmux.
  - For automatic PNG capture, install a Playwright browser once when needed:
      npx playwright install chromium
  - In the pi agent harness, --no-screenshot plus agent_browser on the generated HTML is also acceptable.

Examples:
  npm run smoke:visual -- \\
    --label read-package \\
    --prompt 'Read ./package.json using the read/file tool, then answer with the package name.' \\
    --out-dir /tmp/pi-cursor-sdk-visual-review

  npm run smoke:visual -- \\
    --label after-shell-success \\
    --ext /path/to/pi-cursor-sdk \\
    --cwd /path/to/test-workspace \\
    --prompt 'Run a safe shell command that prints "cursor visual smoke" and report the output.' \\
    --wait-ms 60000 \\
    --out-dir /tmp/pi-cursor-sdk-visual-review

Exit codes:
  0  capture and required artifacts were written
  1  TUI run, JSONL discovery, HTML render, or screenshot failed
  2  invalid usage or missing prerequisite command
`);
}

function fail(message, code = EXIT_FAILURE) {
	console.error(`[visual-smoke] ${message}`);
	process.exit(code);
}

function timestamp() {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseInteger(value, name) {
	if (!/^\d+$/.test(value)) fail(`${name} must be a positive integer: ${value}`, EXIT_USAGE);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer: ${value}`, EXIT_USAGE);
	return parsed;
}

function readPromptFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		fail(`failed to read --prompt-file ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT_USAGE);
	}
}

function parseMode(value) {
	if (value !== "agent" && value !== "plan") fail(`--mode must be agent or plan: ${value}`, EXIT_USAGE);
	return value;
}

function parseSettingSources(value) {
	if (!value.trim()) fail("--setting-sources requires a non-empty value", EXIT_USAGE);
	return value;
}

function parseArgs(argv) {
	const options = parseArgv(argv, {
		defaults: {
			ext: ROOT,
			cwd: process.cwd(),
			waitMs: DEFAULT_WAIT_MS,
			startupMs: DEFAULT_STARTUP_MS,
			model: DEFAULT_MODEL,
			mode: DEFAULT_MODE,
			settingSources: DEFAULT_SETTING_SOURCES,
			bridge: false,
			exposeBuiltinTools: false,
			leftoverPatterns: [],
			width: DEFAULT_WIDTH,
			height: DEFAULT_HEIGHT,
			historyLines: DEFAULT_HISTORY_LINES,
			eventDebug: false,
			screenshot: true,
			selfTest: false,
		},
		flags: {
			label: { names: ["--label"] },
			prompt: { names: ["--prompt", "--prompt-file"], allowDashValue: true, assign: (value, flagName) => (flagName === "--prompt-file" ? readPromptFile(value) : value) },
			ext: { names: ["--ext"], assign: (value) => resolve(value) },
			cwd: { names: ["--cwd"], assign: (value) => resolve(value) },
			outDir: { names: ["--out-dir"], assign: (value) => resolve(value) },
			waitMs: { names: ["--wait-ms"], assign: (value) => parseInteger(value, "--wait-ms") },
			startupMs: { names: ["--startup-ms"], assign: (value) => parseInteger(value, "--startup-ms") },
			model: { names: ["--model"] },
			mode: { names: ["--mode"], assign: parseMode },
			sessionDir: { names: ["--session-dir"], assign: (value) => resolve(value) },
			sessionId: { names: ["--session-id"] },
			width: { names: ["--width"], assign: (value) => parseInteger(value, "--width") },
			height: { names: ["--height"], assign: (value) => parseInteger(value, "--height") },
			historyLines: { names: ["--history-lines"], assign: (value) => parseInteger(value, "--history-lines") },
			settingSources: { names: ["--setting-sources"], assign: parseSettingSources },
			bridge: commonBooleanFlag("--bridge"),
			exposeBuiltinTools: commonBooleanFlag("--expose-builtin-tools"),
			eventDebug: commonBooleanFlag("--event-debug"),
			leftoverPatterns: { ...commonRepeatStringFlag("--leftover-pattern"), allowDashValue: true },
			screenshot: { ...commonBooleanFlag("--no-screenshot"), assign: () => false },
			selfTest: commonBooleanFlag("--self-test"),
		},
		fail: (message) => fail(message, EXIT_USAGE),
	});

	if (options.help) {
		printHelp();
		process.exit(0);
	}
	if (options.selfTest) return options;
	if (!options.label?.trim()) fail("--label is required", EXIT_USAGE);
	if (!options.prompt?.trim()) fail("--prompt or --prompt-file is required", EXIT_USAGE);
	if (options.exposeBuiltinTools && !options.bridge) fail("--expose-builtin-tools requires --bridge", EXIT_USAGE);

	options.safeLabel = sanitizeLabel(options.label);
	options.outDir ??= resolve(`/tmp/pi-cursor-sdk-visual-smoke-${timestamp()}`);
	options.sessionDir ??= resolve(options.outDir, `${options.safeLabel}.session`);
	options.sessionId ??= `visual-${options.safeLabel}-${Date.now()}`;
	return options;
}

function sanitizeLabel(label) {
	const safe = label.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe || "visual-smoke";
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: options.input === undefined ? "utf8" : undefined,
		env: options.env,
		input: options.input,
		stdio: options.stdio ?? (options.input === undefined ? "pipe" : ["pipe", "pipe", "pipe"]),
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommand(command, envPath = process.env.PATH ?? "") {
	if (!command.trim()) fail("empty command name", EXIT_USAGE);
	if (command.includes("/")) {
		const path = resolve(command);
		if (!isExecutable(path)) fail(`${command} is not executable`, EXIT_USAGE);
		return path;
	}
	for (const entry of envPath.split(delimiter)) {
		if (!entry) continue;
		const candidate = resolve(entry, command);
		if (isExecutable(candidate)) return candidate;
	}
	fail(`${command} is required on PATH`, EXIT_USAGE);
}

function requireCommand(command, options = {}) {
	const path = resolveCommand(command, options.envPath ?? process.env.PATH ?? "");
	const args = command === "tmux" ? ["-V"] : ["--version"];
	const result = run(path, args, { env: options.env });
	if (result.status !== 0) fail(`${command} failed prerequisite check at ${path}`, EXIT_USAGE);
	return path;
}

function requireNode() {
	const path = process.execPath;
	if (!path || !isExecutable(path)) fail(`current Node executable is not executable: ${path || "<empty>"}`, EXIT_USAGE);
	return path;
}

function resolveShell(shell) {
	if (shell.startsWith("/")) {
		if (!isExecutable(shell)) fail(`shell is not executable: ${shell}`, EXIT_USAGE);
		return shell;
	}
	return resolveCommand(shell);
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeUtf8(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

function capturePane(tmuxBin, sessionName, args) {
	const result = run(tmuxBin, ["capture-pane", ...args, "-t", sessionName]);
	if (result.status !== 0) {
		throw new Error(result.stderr?.toString().trim() || `tmux capture-pane exited ${result.status}`);
	}
	return result.stdout.toString();
}

function collectJsonlMtimes(root) {
	const files = [];
	function visit(dir) {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push({ path, mtimeMs: statSync(path).mtimeMs });
			}
		}
	}
	visit(root);
	return files;
}

function snapshotJsonlMtimes(root) {
	return new Map(collectJsonlMtimes(root).map(({ path, mtimeMs }) => [path, mtimeMs]));
}

function findLatestJsonl(root, { sinceMs = 0, previousMtimes = new Map() } = {}) {
	const matches = [];
	for (const file of collectJsonlMtimes(root)) {
		const previousMtimeMs = previousMtimes.get(file.path);
		if (previousMtimeMs === undefined ? file.mtimeMs >= sinceMs : file.mtimeMs > previousMtimeMs) matches.push(file);
	}
	matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return matches[0]?.path;
}

function checkLeftovers(patterns) {
	if (patterns.length === 0) return;
	const result = run("ps", ["-axo", "pid,etime,command"]);
	if (result.status !== 0) {
		throw new Error(`failed to inspect leftover processes: ${result.stderr?.toString().trim() || result.status}`);
	}
	const lines = result.stdout
		.toString()
		.split("\n")
		.filter((line) => line.trim() && !line.includes("scripts/visual-tui-smoke.mjs") && !line.includes("--leftover-pattern"));
	const matches = [];
	for (const pattern of patterns) {
		let regex;
		try {
			regex = new RegExp(pattern);
		} catch (error) {
			throw new Error(`invalid --leftover-pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
		}
		for (const line of lines) {
			if (regex.test(line)) matches.push(line.trim());
		}
	}
	if (matches.length > 0) {
		throw new Error(`leftover process pattern matched after visual smoke:\n${matches.join("\n")}`);
	}
}

function buildLaunchPlan(options, commands, shell) {
	const smokeEnvPlan = buildCursorSmokeEnvPlan({
		baseEnv: process.env,
		nodePath: commands.node,
		settingSources: options.settingSources,
		nativeToolDisplay: true,
		registerNativeTools: true,
		bridge: options.bridge,
		exposeBuiltinTools: options.exposeBuiltinTools,
		term: "xterm-256color",
		eventDebugDir: options.eventDebug ? resolve(options.outDir, `${options.safeLabel ?? "visual-smoke"}.cursor-sdk-events`) : undefined,
	});
	const sealedPath = commands.sealedPath ?? smokeEnvPlan.sealedPath;
	const envAssignments = smokeEnvPlan.envEntries;
	const clearEnvNames = smokeEnvPlan.clearEnvNames;
	const command = [
		...envAssignments.map(([name, value]) => `${name}=${shellQuote(value)}`),
		"exec",
		shellQuote(commands.pi),
		"-e", shellQuote(options.ext),
		"--cursor-no-fast",
		"--cursor-mode", shellQuote(options.mode),
		"--session-dir", shellQuote(options.sessionDir),
		"--session-id", shellQuote(options.sessionId),
		"--model", shellQuote(options.model),
	].join(" ");
	const clearLines = clearEnvNames.map((name) => `unset ${name}`).join("\n");
	const script = [
		`export PATH=${shellQuote(sealedPath)}`,
		clearLines,
		`cd ${shellQuote(options.cwd)} || exit 97`,
		command,
	]
		.filter(Boolean)
		.join("\n");
	return { command, clearEnvNames, envAssignments, script, shell };
}

function runVisualSmoke(options) {
	const node = requireNode();
	const sealedPath = sealedNodePath(node);
	const commands = {
		pi: requireCommand("pi", { env: { ...process.env, PATH: sealedPath } }),
		node,
		sealedPath,
		tmux: requireCommand("tmux"),
	};

	mkdirSync(options.outDir, { recursive: true });
	mkdirSync(options.sessionDir, { recursive: true });

	const sessionName = `pi-visual-${options.safeLabel}-${process.pid}`;
	const bufferName = `pi-visual-prompt-${process.pid}`;
	const shell = resolveShell(process.env.SHELL || "/bin/bash");
	const { script } = buildLaunchPlan(options, commands, shell);

	console.log(`[visual-smoke] out-dir=${options.outDir}`);
	console.log(`[visual-smoke] session-dir=${options.sessionDir}`);
	console.log(`[visual-smoke] tmux-session=${sessionName}`);
	console.log(`[visual-smoke] pi=${commands.pi}`);
	console.log(`[visual-smoke] node=${commands.node}`);
	console.log(`[visual-smoke] tmux=${commands.tmux}`);
	console.log(
		`[visual-smoke] native-replay-only=${!options.bridge && !options.exposeBuiltinTools && options.settingSources === DEFAULT_SETTING_SOURCES ? "true" : "false"}`,
	);

	let sessionStarted = false;
	let bufferLoaded = false;
	const jsonlMtimesBeforeRun = snapshotJsonlMtimes(options.sessionDir);
	const runStartedAtMs = Date.now();
	try {
		const start = run(commands.tmux, ["new-session", "-d", "-s", sessionName, "-x", String(options.width), "-y", String(options.height), "--", shell, "-lc", script]);
		if (start.status !== 0) throw new Error(`tmux new-session failed: ${start.stderr?.toString().trim() || start.status}`);
		sessionStarted = true;

		sleep(options.startupMs);
		const load = run(commands.tmux, ["load-buffer", "-b", bufferName, "-"], { input: Buffer.from(options.prompt, "utf8") });
		if (load.status !== 0) throw new Error(`tmux load-buffer failed: ${load.stderr?.toString().trim() || load.status}`);
		bufferLoaded = true;
		try {
			const paste = run(commands.tmux, ["paste-buffer", "-b", bufferName, "-t", sessionName]);
			if (paste.status !== 0) throw new Error(`tmux paste-buffer failed: ${paste.stderr?.toString().trim() || paste.status}`);
			// Give bracketed paste handling a moment to finish before submitting.
			sleep(250);
			const enter = run(commands.tmux, ["send-keys", "-t", sessionName, "Enter"]);
			if (enter.status !== 0) throw new Error(`tmux send-keys failed: ${enter.stderr?.toString().trim() || enter.status}`);
		} finally {
			run(commands.tmux, ["delete-buffer", "-b", bufferName]);
			bufferLoaded = false;
		}

		sleep(options.waitMs);

		const historyStart = `-${options.historyLines}`;
		const ansi = capturePane(commands.tmux, sessionName, ["-e", "-p", "-S", historyStart]);
		const plain = capturePane(commands.tmux, sessionName, ["-p", "-S", historyStart]);

		const base = resolve(options.outDir, options.safeLabel);
		const ansiPath = `${base}.ansi`;
		const textPath = `${base}.txt`;
		const htmlPath = `${base}.html`;
		const pngPath = `${base}.png`;
		const jsonlPathFile = `${base}.jsonl.path`;

		writeUtf8(ansiPath, ansi);
		writeUtf8(textPath, plain);
		writeUtf8(htmlPath, buildTerminalHtml({ ansi, plain, options }));

		const jsonlPath = findLatestJsonl(options.sessionDir, { sinceMs: runStartedAtMs, previousMtimes: jsonlMtimesBeforeRun });
		if (!jsonlPath) throw new Error(`no current-run persisted .jsonl found under ${options.sessionDir}`);
		writeUtf8(jsonlPathFile, `${jsonlPath}\n`);

		return { ansiPath, textPath, htmlPath, pngPath, jsonlPathFile, jsonlPath };
	} finally {
		if (bufferLoaded) run(commands.tmux, ["delete-buffer", "-b", bufferName]);
		if (sessionStarted) run(commands.tmux, ["kill-session", "-t", sessionName]);
	}
}

function assertSelfTest(condition, message) {
	if (!condition) throw new Error(`self-test failed: ${message}`);
}

function envMap(assignments) {
	return new Map(assignments.map(([name, value]) => [name, value]));
}

function parseEnvCapture(path) {
	return new Map(
		readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const index = line.indexOf("=");
				return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
			}),
	);
}

function runSelfTest() {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-visual-self-test-"));
	try {
		const binDir = join(tempDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const fakePi = join(binDir, "pi");
		const fakeNode = join(binDir, "node");
		const fakeNodeMarker = join(tempDir, "fake-node-used");
		const envCapture = join(tempDir, "fake-pi.env");
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(envCapture)}, Object.entries(process.env).map(([key, value]) => key + "=" + (value ?? "")).join("\\n") + "\\n", "utf8");\n`,
			"utf8",
		);
		writeFileSync(fakeNode, `#!/bin/sh\necho fake-node-used > ${shellQuote(fakeNodeMarker)}\nexit 99\n`, "utf8");
		chmodSync(fakePi, 0o755);
		chmodSync(fakeNode, 0o755);

		const promptFile = join(tempDir, "prompt.txt");
		writeFileSync(promptFile, "file prompt", "utf8");
		assertSelfTest(parseArgs(["--label", "prompt-order", "--prompt-file", promptFile, "--prompt", "inline prompt"]).prompt === "inline prompt", "--prompt should override an earlier --prompt-file");
		assertSelfTest(parseArgs(["--label", "prompt-dash", "--prompt", "--starts-with-dash"]).prompt === "--starts-with-dash", "--prompt should accept dash-prefixed free-form text");
		assertSelfTest(parseArgs(["--label", "prompt-order", "--prompt", "inline prompt", "--prompt-file", promptFile]).prompt === "file prompt", "--prompt-file should override an earlier --prompt");

		const jsonlDir = join(tempDir, "jsonl-filter");
		mkdirSync(jsonlDir, { recursive: true });
		const staleJsonl = join(jsonlDir, "stale.jsonl");
		const freshJsonl = join(jsonlDir, "fresh.jsonl");
		writeFileSync(staleJsonl, "{}\n", "utf8");
		utimesSync(staleJsonl, new Date(1_000), new Date(1_000));
		const previousJsonlMtimes = snapshotJsonlMtimes(jsonlDir);
		writeFileSync(freshJsonl, "{}\n", "utf8");
		utimesSync(freshJsonl, new Date(3_000), new Date(3_000));
		assertSelfTest(findLatestJsonl(jsonlDir, { sinceMs: 2_000, previousMtimes: previousJsonlMtimes }) === freshJsonl, "JSONL discovery should ignore unchanged stale files before run start");
		assertSelfTest(findLatestJsonl(jsonlDir, { sinceMs: 4_000, previousMtimes: snapshotJsonlMtimes(jsonlDir) }) === undefined, "JSONL discovery should not return stale evidence when current run has no changed JSONL");

		assertSelfTest(!sealedNodePath(process.execPath, "").includes(delimiter), "empty inherited PATH must not leave an empty PATH segment");
		const hostilePath = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
		const sealedHostilePath = sealedNodePath(process.execPath, hostilePath);
		assertSelfTest(resolveCommand("pi", hostilePath) === fakePi, "direct PATH resolver did not prefer fake PATH head");
		assertSelfTest(requireNode() === process.execPath, "node resolver must use process.execPath");
		assertSelfTest(requireCommand("pi", { envPath: hostilePath, env: { ...process.env, PATH: sealedHostilePath } }) === fakePi, "pi prereq should use sealed PATH when executing the shim");
		assertSelfTest(!existsSync(fakeNodeMarker), "pi prereq should not use hostile fake node");

		const baseOptions = {
			ext: ROOT,
			cwd: ROOT,
			mode: DEFAULT_MODE,
			model: DEFAULT_MODEL,
			outDir: tempDir,
			safeLabel: "self-test",
			sessionDir: join(tempDir, "session"),
			sessionId: "self-test",
			settingSources: DEFAULT_SETTING_SOURCES,
			bridge: false,
			exposeBuiltinTools: false,
			eventDebug: false,
		};
		const plan = buildLaunchPlan(baseOptions, { pi: fakePi, node: process.execPath, sealedPath: sealedHostilePath }, "/bin/sh");
		const defaults = envMap(plan.envAssignments);
		assertSelfTest(defaults.get("PI_CURSOR_NATIVE_TOOL_DISPLAY") === "1", "native display must be forced on");
		assertSelfTest(defaults.get("PI_CURSOR_REGISTER_NATIVE_TOOLS") === "1", "native tool registration must be forced on");
		assertSelfTest(defaults.get("PI_CURSOR_SETTING_SOURCES") === "none", "setting sources must default to none");
		assertSelfTest(defaults.get("PI_CURSOR_PI_TOOL_BRIDGE") === "0", "bridge must default off");
		assertSelfTest(defaults.get("PI_CURSOR_EXPOSE_BUILTIN_TOOLS") === "0", "built-in exposure must default off");
		for (const name of DEBUG_ENV_NAMES) {
			assertSelfTest(plan.clearEnvNames.includes(name), `${name} must be cleared by default`);
		}
		assertSelfTest(plan.script.includes(shellQuote(fakePi)), "launch script must use resolved pi path");
		assertSelfTest(!plan.script.includes(" exec pi "), "launch script must not use bare pi");
		const hostileEnv = {
			...process.env,
			...Object.fromEntries(DEBUG_ENV_NAMES.map((name) => [name, join(tempDir, name)])),
			PATH: hostilePath,
			PI_CURSOR_REGISTER_NATIVE_TOOLS: "0",
			PI_CURSOR_SETTING_SOURCES: "all",
			PI_CURSOR_PI_TOOL_BRIDGE: "1",
			PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1",
		};
		const probe = run("/bin/sh", ["-c", plan.script], { env: hostileEnv });
		assertSelfTest(probe.status === 0, `fake-pi env capture exited ${probe.status}: ${probe.stderr?.toString() ?? ""}`);
		const capturedEnv = parseEnvCapture(envCapture);
		assertSelfTest(!existsSync(fakeNodeMarker), "launch PATH should force the resolved node before hostile fake node");
		assertSelfTest((capturedEnv.get("PATH") ?? "").split(delimiter)[0] === dirname(process.execPath), "captured PATH should start with resolved node directory");
		assertSelfTest(capturedEnv.get("PI_CURSOR_NATIVE_TOOL_DISPLAY") === "1", "captured env should force native display on");
		assertSelfTest(capturedEnv.get("PI_CURSOR_REGISTER_NATIVE_TOOLS") === "1", "captured env should force native registration on");
		assertSelfTest(capturedEnv.get("PI_CURSOR_SETTING_SOURCES") === "none", "captured env should force settings off");
		assertSelfTest(capturedEnv.get("PI_CURSOR_PI_TOOL_BRIDGE") === "0", "captured env should force bridge off");
		assertSelfTest(capturedEnv.get("PI_CURSOR_EXPOSE_BUILTIN_TOOLS") === "0", "captured env should force built-in exposure off");
		for (const name of DEBUG_ENV_NAMES) {
			assertSelfTest(!capturedEnv.has(name), `${name} should be absent from captured env by default`);
		}

		const optInPlan = buildLaunchPlan(
			{ ...baseOptions, settingSources: "all", bridge: true, exposeBuiltinTools: true, eventDebug: true },
			{ pi: fakePi, node: process.execPath, sealedPath: sealedHostilePath },
			"/bin/sh",
		);
		const optIns = envMap(optInPlan.envAssignments);
		assertSelfTest(optIns.get("PI_CURSOR_SETTING_SOURCES") === "all", "setting source opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_PI_TOOL_BRIDGE") === "1", "bridge opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_EXPOSE_BUILTIN_TOOLS") === "1", "built-in exposure opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_SDK_EVENT_DEBUG") === "1", "event debug opt-in must be reflected");
		assertSelfTest(optIns.get("PI_CURSOR_SDK_EVENT_DEBUG_DIR") === join(tempDir, "self-test.cursor-sdk-events"), "event debug dir must be deterministic under out-dir");
		for (const name of DEBUG_ENV_NAMES) {
			assertSelfTest(optInPlan.clearEnvNames.includes(name), `${name} must be cleared even when event debug is explicit`);
		}
		const eventDebugProbe = run("/bin/sh", ["-c", optInPlan.script], { env: hostileEnv });
		assertSelfTest(eventDebugProbe.status === 0, `fake-pi event-debug env capture exited ${eventDebugProbe.status}: ${eventDebugProbe.stderr?.toString() ?? ""}`);
		const capturedEventDebugEnv = parseEnvCapture(envCapture);
		assertSelfTest(capturedEventDebugEnv.get("PI_CURSOR_SDK_EVENT_DEBUG") === "1", "event debug should be explicitly enabled");
		assertSelfTest(capturedEventDebugEnv.get("PI_CURSOR_SDK_EVENT_DEBUG_DIR") === join(tempDir, "self-test.cursor-sdk-events"), "event debug dir should be deterministic under out-dir");
		assertSelfTest(!capturedEventDebugEnv.has("PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR"), "stale event debug run dir should be cleared");
		assertSelfTest(!capturedEventDebugEnv.has("PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR"), "stale event debug session dir should be cleared");
		assertSelfTest(!capturedEventDebugEnv.has("PI_CURSOR_SDK_EVENT_DEBUG_STDERR"), "stale event debug stderr flag should be cleared");

		const fakeTmux = join(binDir, "tmux");
		const deleteBufferMarker = join(tempDir, "delete-buffer-called");
		writeFileSync(
			fakeTmux,
			`#!/bin/sh\ncase "$1" in\n  -V) echo 'tmux fake'; exit 0 ;;\n  new-session) exit 0 ;;\n  load-buffer) cat >/dev/null; exit 0 ;;\n  paste-buffer) exit 77 ;;\n  delete-buffer) echo deleted > ${shellQuote(deleteBufferMarker)}; exit 0 ;;\n  kill-session) exit 0 ;;\n  *) echo "unexpected tmux command: $*" >&2; exit 64 ;;\nesac\n`,
			"utf8",
		);
		chmodSync(fakeTmux, 0o755);
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = hostilePath;
			let pasteFailed = false;
			try {
				runVisualSmoke({
					...baseOptions,
					prompt: "buffer cleanup prompt",
					startupMs: 1,
					waitMs: 1,
					width: 80,
					height: 24,
					historyLines: 100,
				});
			} catch (error) {
				pasteFailed = /paste-buffer failed/.test(error instanceof Error ? error.message : String(error));
			}
			assertSelfTest(pasteFailed, "fake tmux paste failure should exercise prompt-buffer cleanup path");
			assertSelfTest(existsSync(deleteBufferMarker), "prompt tmux buffer should be deleted when paste/send fails");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
		console.log("[visual-smoke] self-test PASS");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

const options = parseArgs(process.argv.slice(2));
try {
	if (options.selfTest) {
		runSelfTest();
		process.exit(0);
	}
	const artifacts = runVisualSmoke(options);
	checkLeftovers(options.leftoverPatterns);
	if (options.screenshot) {
		await writeTerminalScreenshot(artifacts.htmlPath, artifacts.pngPath, options.width, options.height);
	}
	console.log("[visual-smoke] artifacts:");
	console.log(`  ansi:       ${artifacts.ansiPath}`);
	console.log(`  text:       ${artifacts.textPath}`);
	console.log(`  html:       ${artifacts.htmlPath}`);
	if (options.screenshot) console.log(`  png:        ${artifacts.pngPath}`);
	console.log(`  jsonl.path: ${artifacts.jsonlPathFile}`);
	console.log(`  jsonl:      ${artifacts.jsonlPath}`);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
