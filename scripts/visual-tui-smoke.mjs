#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WIDTH = 150;
const DEFAULT_HEIGHT = 45;
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_STARTUP_MS = 5_000;
const DEFAULT_HISTORY_LINES = 3_000;
const DEFAULT_MODEL = "cursor/composer-2.5";
const DEFAULT_MODE = "plan";
const DEFAULT_SETTING_SOURCES = "none";

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
  --expose-builtin-tools        Opt in to exposing overlapping built-in pi tools to Cursor.
  --event-debug                 Set PI_CURSOR_SDK_EVENT_DEBUG=1 for the run.
  --leftover-pattern REGEX      After capture, fail if a process command still matches REGEX. Repeatable.
  --no-screenshot               Write .ansi/.txt/.html/.jsonl.path only; use agent_browser manually.
  -h, --help                    Show this help.

Native replay isolation defaults:
  PI_CURSOR_NATIVE_TOOL_DISPLAY=1
  PI_CURSOR_SETTING_SOURCES=none
  PI_CURSOR_PI_TOOL_BRIDGE=0
  PI_CURSOR_EXPOSE_BUILTIN_TOOLS=0
  TERM=xterm-256color

Artifacts written:
  <label>.ansi                  Raw tmux ANSI capture.
  <label>.txt                   Plain tmux text capture.
  <label>.html                  Self-contained browser/xterm render.
  <label>.png                   Browser-rendered screenshot, unless --no-screenshot.
  <label>.jsonl.path            Latest persisted pi session JSONL path.

Prerequisites:
  - pi, node, tmux, and npm-installed dev dependencies on PATH / in node_modules.
  - The runner resolves pi/node/tmux from the parent PATH and reuses those paths inside tmux.
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

function parseArgs(argv) {
	const options = {
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
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			index += 1;
			if (index >= argv.length) fail(`${arg} requires a value`, EXIT_USAGE);
			return argv[index];
		};

		switch (arg) {
			case "-h":
			case "--help":
				printHelp();
				process.exit(0);
			case "--label":
				options.label = next();
				break;
			case "--prompt":
				options.prompt = next();
				break;
			case "--prompt-file":
				options.prompt = readPromptFile(next());
				break;
			case "--ext":
				options.ext = resolve(next());
				break;
			case "--cwd":
				options.cwd = resolve(next());
				break;
			case "--out-dir":
				options.outDir = resolve(next());
				break;
			case "--wait-ms":
				options.waitMs = parseInteger(next(), arg);
				break;
			case "--startup-ms":
				options.startupMs = parseInteger(next(), arg);
				break;
			case "--model":
				options.model = next();
				break;
			case "--mode": {
				const mode = next();
				if (mode !== "agent" && mode !== "plan") fail(`--mode must be agent or plan: ${mode}`, EXIT_USAGE);
				options.mode = mode;
				break;
			}
			case "--session-dir":
				options.sessionDir = resolve(next());
				break;
			case "--session-id":
				options.sessionId = next();
				break;
			case "--width":
				options.width = parseInteger(next(), arg);
				break;
			case "--height":
				options.height = parseInteger(next(), arg);
				break;
			case "--history-lines":
				options.historyLines = parseInteger(next(), arg);
				break;
			case "--setting-sources": {
				const settingSources = next();
				if (!settingSources.trim()) fail("--setting-sources requires a non-empty value", EXIT_USAGE);
				options.settingSources = settingSources;
				break;
			}
			case "--bridge":
				options.bridge = true;
				break;
			case "--expose-builtin-tools":
				options.exposeBuiltinTools = true;
				break;
			case "--event-debug":
				options.eventDebug = true;
				break;
			case "--leftover-pattern":
				options.leftoverPatterns.push(next());
				break;
			case "--no-screenshot":
				options.screenshot = false;
				break;
			default:
				fail(`unknown option: ${arg}`, EXIT_USAGE);
		}
	}

	if (!options.label?.trim()) fail("--label is required", EXIT_USAGE);
	if (!options.prompt?.trim()) fail("--prompt or --prompt-file is required", EXIT_USAGE);

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
		input: options.input,
		stdio: options.stdio ?? (options.input === undefined ? "pipe" : ["pipe", "pipe", "pipe"]),
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function resolveCommand(command) {
	const result = run("/bin/sh", ["-lc", `command -v -- ${shellQuote(command)}`]);
	if (result.status !== 0) fail(`${command} is required on PATH`, EXIT_USAGE);
	const path = result.stdout.toString().trim().split("\n")[0];
	if (!path || !path.startsWith("/")) fail(`${command} did not resolve to an absolute executable path: ${path || "<empty>"}`, EXIT_USAGE);
	return path;
}

function requireCommand(command) {
	const path = resolveCommand(command);
	const args = command === "tmux" ? ["-V"] : ["--version"];
	const result = run(path, args);
	if (result.status !== 0) fail(`${command} failed prerequisite check at ${path}`, EXIT_USAGE);
	return path;
}

function resolveShell(shell) {
	if (shell.startsWith("/")) return shell;
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

function findLatestJsonl(root) {
	const matches = [];
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
				matches.push({ path, mtimeMs: statSync(path).mtimeMs });
			}
		}
	}
	visit(root);
	matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return matches[0]?.path;
}

function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlJson(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function loadXtermAssets() {
	const require = createRequire(import.meta.url);
	try {
		return {
			css: readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"),
			js: readFileSync(require.resolve("@xterm/xterm/lib/xterm.js"), "utf8"),
		};
	} catch (error) {
		throw new Error(`failed to load @xterm/xterm assets; run npm install: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function buildHtml({ ansi, plain, options }) {
	const assets = loadXtermAssets();
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pi-cursor-sdk visual smoke: ${escapeHtml(options.label)}</title>
<style>
${assets.css}
:root { color-scheme: dark; }
body {
	margin: 0;
	padding: 16px;
	background: #0b0f14;
	color: #d8dee9;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
header {
	margin: 0 0 12px;
	font-size: 13px;
	line-height: 1.4;
	color: #9aa4b2;
}
header code { color: #d8dee9; }
#terminal {
	display: inline-block;
	padding: 12px;
	border: 1px solid #303846;
	border-radius: 8px;
	background: #0b0f14;
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.fallback {
	white-space: pre-wrap;
	font-family: Menlo, Monaco, Consolas, "Liberation Mono", monospace;
	font-size: 12px;
}
</style>
<script>${assets.js}</script>
</head>
<body>
<header>
	<div><strong>pi-cursor-sdk visual smoke</strong> <code>${escapeHtml(options.label)}</code></div>
	<div>model <code>${escapeHtml(options.model)}</code> · mode <code>${escapeHtml(options.mode)}</code> · cwd <code>${escapeHtml(options.cwd)}</code></div>
	<div>session <code>${escapeHtml(options.sessionId)}</code> · captured ${new Date().toISOString()}</div>
</header>
<div id="terminal"></div>
<noscript><pre class="fallback">${escapeHtml(plain)}</pre></noscript>
<script>
const ansi = ${htmlJson(ansi)};
const fallbackText = ${htmlJson(plain)};
const terminalElement = document.getElementById("terminal");
try {
	const term = new Terminal({
		cols: ${options.width},
		rows: ${options.height},
		convertEol: true,
		fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
		fontSize: 13,
		lineHeight: 1.18,
		scrollback: ${options.historyLines},
		theme: {
			background: '#0b0f14',
			foreground: '#d8dee9',
			cursor: '#d8dee9'
		}
	});
	term.open(terminalElement);
	term.resize(${options.width}, ${options.height});
	term.write(ansi, () => {
		document.body.setAttribute("data-render-ready", "true");
	});
} catch (error) {
	const pre = document.createElement("pre");
	pre.className = "fallback";
	pre.textContent = fallbackText + "\\n\\n[xterm render failed: " + String(error) + "]";
	terminalElement.replaceChildren(pre);
	document.body.setAttribute("data-render-ready", "true");
}
</script>
</body>
</html>
`;
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

async function writeScreenshot(htmlPath, pngPath, width, height) {
	let browser;
	try {
		const { chromium } = await import("playwright");
		browser = await chromium.launch();
		const page = await browser.newPage({
			viewport: {
				width: Math.max(1_200, width * 10),
				height: Math.max(800, height * 22),
			},
			deviceScaleFactor: 1,
		});
		await page.goto(pathToFileURL(htmlPath).href);
		await page.waitForSelector('body[data-render-ready="true"]', { timeout: 30_000 });
		await page.locator("#terminal").screenshot({ path: pngPath });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to capture PNG with Playwright: ${message}\nInstall Chromium with: npx playwright install chromium\nOr rerun with --no-screenshot and capture ${htmlPath} with agent_browser.`);
	} finally {
		if (browser) await browser.close();
	}
}

function runVisualSmoke(options) {
	const commands = {
		pi: requireCommand("pi"),
		node: requireCommand("node"),
		tmux: requireCommand("tmux"),
	};

	mkdirSync(options.outDir, { recursive: true });
	mkdirSync(options.sessionDir, { recursive: true });

	const sessionName = `pi-visual-${options.safeLabel}-${process.pid}`;
	const bufferName = `pi-visual-prompt-${process.pid}`;
	const shell = resolveShell(process.env.SHELL || "/bin/bash");
	const envAssignments = [
		["PI_CURSOR_NATIVE_TOOL_DISPLAY", "1"],
		["PI_CURSOR_SETTING_SOURCES", options.settingSources],
		["PI_CURSOR_PI_TOOL_BRIDGE", options.bridge ? "1" : "0"],
		["PI_CURSOR_EXPOSE_BUILTIN_TOOLS", options.exposeBuiltinTools ? "1" : "0"],
		["TERM", "xterm-256color"],
	];
	if (options.eventDebug) envAssignments.push(["PI_CURSOR_SDK_EVENT_DEBUG", "1"]);
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
	const script = `export PATH=${shellQuote(process.env.PATH ?? "")}\ncd ${shellQuote(options.cwd)} || exit 97\n${command}\n`;

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
	try {
		const start = run(commands.tmux, ["new-session", "-d", "-s", sessionName, "-x", String(options.width), "-y", String(options.height), "--", shell, "-lc", script]);
		if (start.status !== 0) throw new Error(`tmux new-session failed: ${start.stderr?.toString().trim() || start.status}`);
		sessionStarted = true;

		sleep(options.startupMs);
		const load = run(commands.tmux, ["load-buffer", "-b", bufferName, "-"], { input: Buffer.from(options.prompt, "utf8") });
		if (load.status !== 0) throw new Error(`tmux load-buffer failed: ${load.stderr?.toString().trim() || load.status}`);
		const paste = run(commands.tmux, ["paste-buffer", "-b", bufferName, "-t", sessionName]);
		if (paste.status !== 0) throw new Error(`tmux paste-buffer failed: ${paste.stderr?.toString().trim() || paste.status}`);
		// Give bracketed paste handling a moment to finish before submitting.
		sleep(250);
		const enter = run(commands.tmux, ["send-keys", "-t", sessionName, "Enter"]);
		if (enter.status !== 0) throw new Error(`tmux send-keys failed: ${enter.stderr?.toString().trim() || enter.status}`);
		run(commands.tmux, ["delete-buffer", "-b", bufferName]);

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
		writeUtf8(htmlPath, buildHtml({ ansi, plain, options }));

		const jsonlPath = findLatestJsonl(options.sessionDir);
		if (!jsonlPath) throw new Error(`no persisted .jsonl found under ${options.sessionDir}`);
		writeUtf8(jsonlPathFile, `${jsonlPath}\n`);

		return { ansiPath, textPath, htmlPath, pngPath, jsonlPathFile, jsonlPath };
	} finally {
		if (sessionStarted) run(commands.tmux, ["kill-session", "-t", sessionName]);
	}
}

const options = parseArgs(process.argv.slice(2));
try {
	const artifacts = runVisualSmoke(options);
	checkLeftovers(options.leftoverPatterns);
	if (options.screenshot) {
		await writeScreenshot(artifacts.htmlPath, artifacts.pngPath, options.width, options.height);
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
