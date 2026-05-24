#!/usr/bin/env node
/**
 * Maintainer-only Cursor SDK event capture probe.
 * Captures timestamped run.stream(), onDelta, and onStep surfaces for one run.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const CURSOR_SETTING_SOURCES_ENV = "PI_CURSOR_SETTING_SOURCES";

const ARTIFACTS = {
	metadata: "metadata.json",
	streamEvents: "stream-events.jsonl",
	onDelta: "on-delta.jsonl",
	onStep: "on-step.jsonl",
	waitResult: "wait-result.json",
	conversation: "conversation.json",
	summary: "summary.json",
};

const DEFAULT_MODEL = "composer-2.5";
const RAW_ARTIFACT_WARNING =
	"Raw artifact files may contain local paths, project text, tool args/results, or secrets from the workspace. Do not commit or share them.";

function readSdkVersion() {
	try {
		const sdkEntry = require.resolve("@cursor/sdk");
		const sdkPackagePath = join(dirname(sdkEntry), "../../package.json");
		return JSON.parse(readFileSync(sdkPackagePath, "utf8")).version;
	} catch {
		return "unknown";
	}
}

function artifactPath(artifactDir, name) {
	return join(artifactDir, ARTIFACTS[name]);
}

function printHelp() {
	console.log(`Capture timestamped Cursor SDK event timelines for one local run.

Usage:
  CURSOR_API_KEY=... npm run debug:sdk-events -- [options]
  node scripts/debug-sdk-events.mjs [options]

Options:
  --cwd <path>                 Agent working directory. Default: process.cwd().
  --model <id>                 Cursor model id. Default: ${DEFAULT_MODEL}.
  --prompt <text>              Required user prompt for the run.
  --out <dir>                  Artifact directory. Default: /tmp/pi-cursor-sdk-sdk-events-<timestamp>.
  --setting-sources <value>    Comma-separated Cursor setting sources, or all/none.
                               Default: PI_CURSOR_SETTING_SOURCES env, otherwise all.
  --include-conversation       Also capture run.conversation() when supported.
  --api-key <key>              Cursor API key. Prefer CURSOR_API_KEY to avoid shell history.
  -h, --help                   Show this help.

Stdout:
  Prints artifact paths and summary counts only. Raw payloads stay on disk under:
  ${ARTIFACTS.streamEvents} (run.stream()), ${ARTIFACTS.onDelta} (onDelta), ${ARTIFACTS.onStep} (onStep).

Exit codes:
  0  capture completed
  1  invalid arguments, missing auth, or Cursor SDK failure

Safety:
  - Never prints CURSOR_API_KEY or --api-key values.
  - Default artifact root is outside the repo (/tmp/...).
  - ${RAW_ARTIFACT_WARNING}
  - Verify Cursor SDK behavior against the installed @cursor/sdk package and/or
    https://cursor.com/docs/sdk/typescript before drawing integration conclusions.`);
}

function fail(message, secrets = []) {
	const scrubbed = scrubSensitiveText(message, secrets);
	console.error(`debug-sdk-events: ${scrubbed}`);
	process.exit(1);
}

function scrubSensitiveText(text, secrets = []) {
	let scrubbed = text;
	for (const secret of secrets) {
		if (secret) scrubbed = scrubbed.split(secret).join("[REDACTED]");
	}
	return scrubbed
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/(api[_-]?key|authorization|auth[_-]?token)(["'\s:=]+)[^"'\s,}]+/gi, "$1$2[REDACTED]");
}

function resolveSettingSources(raw) {
	if (!raw) return ["all"];
	const normalized = raw.trim().toLowerCase();
	if (["0", "false", "off", "none", "omit", "disabled"].includes(normalized)) return undefined;
	if (["1", "true", "on", "all"].includes(normalized)) return ["all"];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function parseDebugSdkEventsArgs(argv, env = process.env) {
	const args = {
		cwd: process.cwd(),
		model: DEFAULT_MODEL,
		prompt: undefined,
		out: undefined,
		settingSources: resolveSettingSources(env[CURSOR_SETTING_SOURCES_ENV]),
		includeConversation: false,
		apiKey: env.CURSOR_API_KEY?.trim() || undefined,
		help: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--include-conversation") {
			args.includeConversation = true;
			continue;
		}
		if (arg === "--cwd") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--cwd requires a path");
			args.cwd = resolve(value);
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			args.cwd = resolve(arg.slice("--cwd=".length));
			continue;
		}
		if (arg === "--model") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--model requires a value");
			args.model = value.trim();
			continue;
		}
		if (arg.startsWith("--model=")) {
			args.model = arg.slice("--model=".length).trim();
			continue;
		}
		if (arg === "--prompt") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--prompt requires a value");
			args.prompt = value;
			continue;
		}
		if (arg.startsWith("--prompt=")) {
			args.prompt = arg.slice("--prompt=".length);
			continue;
		}
		if (arg === "--out") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--out requires a directory path");
			args.out = resolve(value);
			continue;
		}
		if (arg.startsWith("--out=")) {
			args.out = resolve(arg.slice("--out=".length));
			continue;
		}
		if (arg === "--setting-sources") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--setting-sources requires a value");
			args.settingSources = resolveSettingSources(value);
			continue;
		}
		if (arg.startsWith("--setting-sources=")) {
			args.settingSources = resolveSettingSources(arg.slice("--setting-sources=".length));
			continue;
		}
		if (arg === "--api-key") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail("--api-key requires a value");
			args.apiKey = value.trim();
			continue;
		}
		if (arg.startsWith("--api-key=")) {
			args.apiKey = arg.slice("--api-key=".length).trim();
			continue;
		}
		fail(`unknown argument: ${arg}`);
	}
	return args;
}

function defaultOutDir() {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join("/tmp", `pi-cursor-sdk-sdk-events-${stamp}`);
}

function eventType(value) {
	if (value && typeof value === "object" && typeof value.type === "string") return value.type;
	return "unknown";
}

function countByType(records, selector) {
	const counts = {};
	for (const record of records) {
		const type = selector(record);
		counts[type] = (counts[type] ?? 0) + 1;
	}
	return counts;
}

function timingSummary(records) {
	if (records.length === 0) {
		return { eventCount: 0, firstMs: undefined, lastMs: undefined, maxGapMs: undefined };
	}
	const elapsed = records.map((record) => record.elapsedMs);
	let maxGapMs = 0;
	for (let index = 1; index < elapsed.length; index++) {
		maxGapMs = Math.max(maxGapMs, elapsed[index] - elapsed[index - 1]);
	}
	return {
		eventCount: records.length,
		firstMs: elapsed[0],
		lastMs: elapsed[elapsed.length - 1],
		maxGapMs,
	};
}

function writeJsonl(path, records) {
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`);
}

function pushTimed(records, startedAt, key, value) {
	records.push({
		ts: new Date().toISOString(),
		elapsedMs: Date.now() - startedAt,
		[key]: value,
	});
}

function writeEventArtifacts(artifactDir, { streamEvents, deltaEvents, stepEvents }) {
	writeJsonl(artifactPath(artifactDir, "streamEvents"), streamEvents);
	writeJsonl(artifactPath(artifactDir, "onDelta"), deltaEvents);
	writeJsonl(artifactPath(artifactDir, "onStep"), stepEvents);
}

function summarizeConversation(conversation) {
	if (!conversation) return undefined;
	if (Array.isArray(conversation)) return { turnCount: conversation.length };
	return conversation;
}

export function buildSummary({ artifactDir, streamEvents, deltaEvents, stepEvents, waitResult, conversation, includeConversation }) {
	return {
		artifactDir,
		files: {
			metadata: artifactPath(artifactDir, "metadata"),
			streamEvents: artifactPath(artifactDir, "streamEvents"),
			onDelta: artifactPath(artifactDir, "onDelta"),
			onStep: artifactPath(artifactDir, "onStep"),
			waitResult: artifactPath(artifactDir, "waitResult"),
			conversation: includeConversation ? artifactPath(artifactDir, "conversation") : undefined,
		},
		counts: {
			stream: countByType(streamEvents, (record) => eventType(record.event)),
			onDelta: countByType(deltaEvents, (record) => eventType(record.update)),
			onStep: countByType(stepEvents, (record) => eventType(record.step)),
		},
		timing: {
			stream: timingSummary(streamEvents),
			onDelta: timingSummary(deltaEvents),
			onStep: timingSummary(stepEvents),
		},
		wait: waitResult
			? {
					status: waitResult.status,
					durationMs: waitResult.durationMs,
					hasResultText: Boolean(waitResult.result?.trim()),
				}
			: undefined,
		conversation: summarizeConversation(conversation),
		warnings: [RAW_ARTIFACT_WARNING],
	};
}

function printStdoutSummary(summary) {
	console.log(JSON.stringify(summary, null, 2));
}

async function captureEvents(args) {
	const artifactDir = args.out ?? defaultOutDir();
	mkdirSync(artifactDir, { recursive: true });
	const startedAt = Date.now();
	const metadata = {
		capturedAt: new Date(startedAt).toISOString(),
		cwd: args.cwd,
		model: args.model,
		settingSources: args.settingSources ?? null,
		prompt: args.prompt,
		packageVersion: packageJson.version,
		sdkVersion: readSdkVersion(),
		includeConversation: args.includeConversation,
		warnings: [RAW_ARTIFACT_WARNING],
	};
	writeFileSync(artifactPath(artifactDir, "metadata"), `${JSON.stringify(metadata, null, 2)}\n`);

	const streamEvents = [];
	const deltaEvents = [];
	const stepEvents = [];
	let agent;
	try {
		const { Agent } = await import("@cursor/sdk");
		agent = await Agent.create({
			apiKey: args.apiKey,
			model: { id: args.model },
			local: args.settingSources ? { cwd: args.cwd, settingSources: args.settingSources } : { cwd: args.cwd },
		});

		const run = await agent.send(
			{ text: args.prompt },
			{
				onDelta: ({ update }) => pushTimed(deltaEvents, startedAt, "update", update),
				onStep: ({ step }) => pushTimed(stepEvents, startedAt, "step", step),
			},
		);

		for await (const event of run.stream()) {
			pushTimed(streamEvents, startedAt, "event", event);
		}

		const waitResult = await run.wait();
		writeFileSync(artifactPath(artifactDir, "waitResult"), `${JSON.stringify(waitResult, null, 2)}\n`);

		let conversation;
		if (args.includeConversation) {
			if (run.supports("conversation")) {
				conversation = await run.conversation();
			} else {
				conversation = {
					skipped: true,
					reason: run.unsupportedReason("conversation") ?? "conversation unsupported",
				};
			}
			writeFileSync(artifactPath(artifactDir, "conversation"), `${JSON.stringify(conversation, null, 2)}\n`);
		}

		writeEventArtifacts(artifactDir, { streamEvents, deltaEvents, stepEvents });

		const summary = buildSummary({
			artifactDir,
			streamEvents,
			deltaEvents,
			stepEvents,
			waitResult,
			conversation,
			includeConversation: args.includeConversation,
		});
		writeFileSync(artifactPath(artifactDir, "summary"), `${JSON.stringify(summary, null, 2)}\n`);
		printStdoutSummary(summary);
	} catch (error) {
		writeEventArtifacts(artifactDir, { streamEvents, deltaEvents, stepEvents });
		const message = error instanceof Error ? error.message : String(error);
		fail(message, [args.apiKey]);
	} finally {
		agent?.close();
	}
}

async function main(argv = process.argv.slice(2), env = process.env) {
	const args = parseDebugSdkEventsArgs(argv, env);
	if (args.help) {
		printHelp();
		process.exit(0);
	}
	if (!args.prompt?.trim()) {
		fail("--prompt is required");
	}
	if (!args.apiKey) {
		fail("Cursor API key is required. Set CURSOR_API_KEY or pass --api-key.");
	}
	await captureEvents(args);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		fail(message);
	});
}
