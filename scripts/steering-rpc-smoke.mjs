#!/usr/bin/env node
/**
 * RPC steering smoke: queue steer after a native-replay tool-use turn completes execution.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonLines, terminateChild, waitForChildClose } from "./lib/cursor-child-process.mjs";
import { apiKeySecretsFromProcess } from "./lib/cursor-cli-args.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function printHelp() {
	console.log(`RPC steering smoke for pi-cursor-sdk live runs.

Usage:
  node scripts/steering-rpc-smoke.mjs

Environment:
  SMOKE_SESSION_DIR            Session directory for the RPC pi run. Defaults to /tmp/pi-cursor-steer-smoke-<timestamp>.
  PI_BIN                       Optional absolute pi executable path. smoke:live injects the parent-resolved path.
  CURSOR_API_KEY               Optional fallback auth. Stored pi auth in ~/.pi/agent/auth.json is also supported.

Options:
  -h, --help                   Show this help.

Exit codes:
  0  steering scenario completed without AgentBusyError; STEER_OK and STEER_CHAIN present
  1  validation failure, timeout, AgentBusyError, or non-zero pi exit

Notes:
  - Runs pi in RPC mode with native tool replay enabled and the pi bridge disabled.
  - Sends steer after the replayed bash tool finishes execution (post toolResult boundary).
  - Prints a single JSON result line on success; errors go to stderr.`);
}

function fail(message) {
	throw new Error(message);
}

function resolveCommand(command) {
	const result = spawnSync("/bin/sh", ["-lc", `command -v -- ${JSON.stringify(command)}`], { encoding: "utf8" });
	if (result.status !== 0) fail(`${command} is required on PATH`);
	const path = result.stdout.trim().split("\n")[0];
	if (!path || !path.startsWith("/")) fail(`${command} did not resolve to an absolute executable path: ${path || "<empty>"}`);
	return path;
}

function resolvePiBin() {
	const path = process.env.PI_BIN?.trim() || resolveCommand("pi");
	if (!path.startsWith("/")) fail(`PI_BIN must be an absolute path when provided: ${path}`);
	return path;
}

function assistantText(events) {
	return events
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.map((event) =>
			(event.message.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		)
		.join("\n");
}

function hasToolUseTurn(events) {
	return events.some(
		(event) =>
			event.type === "message_end" &&
			event.message?.role === "assistant" &&
			event.message?.stopReason === "toolUse",
	);
}

function hasToolExecutionEnd(events) {
	return events.some((event) => event.type === "tool_execution_end");
}

function waitFor(getStdout, predicate, timeoutMs = 300_000) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			const events = parseJsonLines(getStdout());
			if (predicate(events)) {
				resolve(events);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				reject(
					new Error(
						`timeout after ${timeoutMs}ms\nassistantText=${assistantText(events)}\nstdoutTail=${getStdout().slice(-4000)}`,
					),
				);
				return;
			}
			setTimeout(tick, 500);
		};
		tick();
	});
}

async function runPiRpcSmoke(sessionDir, piBin) {
	const args = ["-e", root, "--cursor-no-fast", "--model", "cursor/composer-2.5", "--mode", "rpc", "--session-dir", sessionDir];
	const env = {
		...process.env,
		PI_CURSOR_SETTING_SOURCES: "none",
		PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
		PI_CURSOR_PI_TOOL_BRIDGE: "0",
	};

	const child = spawn(piBin, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
	let closed = false;
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const send = (obj) => {
		if (!child.stdin.writable) fail("pi stdin closed before smoke command could be sent");
		child.stdin.write(`${JSON.stringify(obj)}\n`);
	};

	try {
		send({
			type: "prompt",
			message:
				"Steering smoke. Use bash once to run: git status --short. Do not answer until after the tool completes. Final answer must include STEER_OK=yes.",
		});

		await waitFor(
			() => stdout,
			(events) => hasToolUseTurn(events),
		);

		await waitFor(
			() => stdout,
			(events) => hasToolExecutionEnd(events),
		);

		send({ type: "steer", message: "and also include STEER_CHAIN=ok in the final answer" });

		await waitFor(
			() => stdout,
			(events) => {
				const text = assistantText(events);
				return text.includes("STEER_OK=yes") && text.includes("STEER_CHAIN=ok") && events.some((event) => event.type === "agent_end");
			},
		);

		const combined = stdout + stderr;
		if (/already has active run|AgentBusyError/i.test(combined)) {
			fail("AgentBusyError detected in smoke output");
		}

		const text = assistantText(parseJsonLines(stdout));
		if (!text.includes("STEER_OK=yes")) {
			fail(`missing STEER_OK=yes in assistant output: ${text.slice(0, 500)}`);
		}
		if (!text.includes("STEER_CHAIN=ok")) {
			fail(`missing STEER_CHAIN=ok in assistant output: ${text.slice(0, 500)}`);
		}

		child.stdin.end();
		const exitCode = await waitForChildClose(child);
		closed = true;
		if (exitCode !== 0) {
			let scrubbedStderr = scrubSensitiveText(stderr.slice(-2000));
			for (const secret of apiKeySecretsFromProcess()) {
				if (secret) scrubbedStderr = scrubSensitiveText(scrubbedStderr, secret);
			}
			fail(`pi exited ${exitCode}\nstderr=${scrubbedStderr}`);
		}

		return {
			ok: true,
			sessionDir,
			steerOk: true,
			steerChain: true,
		};
	} finally {
		if (!closed) await terminateChild(child);
	}
}

async function main() {
	if (process.argv.includes("-h") || process.argv.includes("--help")) {
		printHelp();
		return;
	}

	const sessionDir = process.env.SMOKE_SESSION_DIR ?? join("/tmp", `pi-cursor-steer-smoke-${Date.now()}`);
	const piBin = resolvePiBin();
	mkdirSync(sessionDir, { recursive: true });
	console.log(JSON.stringify(await runPiRpcSmoke(sessionDir, piBin)));
}

main().catch((error) => {
	let scrubbed = scrubSensitiveText(error instanceof Error ? error.message : String(error));
	for (const secret of apiKeySecretsFromProcess()) {
		if (secret) scrubbed = scrubSensitiveText(scrubbed, secret);
	}
	console.error(scrubbed);
	process.exitCode = 1;
});
