#!/usr/bin/env node
/**
 * RPC steering smoke: queue steer after a native-replay tool-use turn completes execution.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const CHILD_SHUTDOWN_GRACE_MS = 2_000;

function printHelp() {
	console.log(`RPC steering smoke for pi-cursor-sdk live runs.

Usage:
  node scripts/steering-rpc-smoke.mjs

Environment:
  SMOKE_SESSION_DIR            Session directory for the RPC pi run. Defaults to /tmp/pi-cursor-steer-smoke-<timestamp>.
  CURSOR_API_KEY               Required Cursor API key for live pi runs.

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

function parseEvents(stdout) {
	const events = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// ignore partial lines
		}
	}
	return events;
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
			const events = parseEvents(getStdout());
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

function waitForChildClose(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code ?? 1));
	});
}

function signalChild(child, signal) {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") {
			child.kill(signal);
		} else {
			process.kill(-child.pid, signal);
		}
	} catch {
		try {
			child.kill(signal);
		} catch {
			// child already exited
		}
	}
}

async function terminateChild(child) {
	child.stdin.destroy();
	if (child.exitCode !== null || child.signalCode !== null) return;
	signalChild(child, "SIGTERM");
	const killTimer = setTimeout(() => signalChild(child, "SIGKILL"), CHILD_SHUTDOWN_GRACE_MS);
	try {
		await waitForChildClose(child);
	} finally {
		clearTimeout(killTimer);
	}
}

async function runPiRpcSmoke(sessionDir) {
	const args = ["-e", root, "--cursor-no-fast", "--model", "cursor/composer-2.5", "--mode", "rpc", "--session-dir", sessionDir];
	const env = {
		...process.env,
		PI_CURSOR_SETTING_SOURCES: "none",
		PI_CURSOR_NATIVE_TOOL_DISPLAY: "1",
		PI_CURSOR_PI_TOOL_BRIDGE: "0",
	};

	const child = spawn("pi", args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
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

		const text = assistantText(parseEvents(stdout));
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
			fail(`pi exited ${exitCode}\nstderr=${stderr.slice(-2000)}`);
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

	if (!process.env.CURSOR_API_KEY) {
		fail("steering-rpc-smoke: CURSOR_API_KEY is required");
	}

	const sessionDir = process.env.SMOKE_SESSION_DIR ?? join("/tmp", `pi-cursor-steer-smoke-${Date.now()}`);
	mkdirSync(sessionDir, { recursive: true });
	console.log(JSON.stringify(await runPiRpcSmoke(sessionDir)));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
