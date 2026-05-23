#!/usr/bin/env node
/**
 * Validate assistant presence and usage fields in pi session JSONL files under a smoke directory.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function printHelp() {
	console.log(`Validate assistant presence and usage metadata in pi smoke session JSONL files.

Usage:
  node scripts/validate-smoke-jsonl.mjs <smoke-dir>
  SMOKE_DIR=/tmp/pi-cursor-smoke node scripts/validate-smoke-jsonl.mjs

Arguments:
  smoke-dir                     Directory containing smoke session subdirs and JSONL files.
                                Defaults to SMOKE_DIR when the positional arg is omitted.

Options:
  -h, --help                    Show this help.

Exit codes:
  0  every scanned JSONL file has at least one assistant message and valid assistant usage metadata
  1  invalid arguments, unreadable directory, invalid JSONL, empty/no-assistant files, or usage validation failures
  2  no JSONL files found under the smoke directory

Enforced invariants:
  - each scanned JSONL file contains parseable JSONL records
  - each scanned JSONL file contains at least one persisted assistant message
  - every persisted assistant message has usage metadata
  - assistant usage input/output/totalTokens are non-negative numbers
  - assistant usage cacheRead/cacheWrite are exactly 0

Notes:
  - Prints one JSON summary line per scanned session file.
  - Does not print session message contents or secrets.`);
}

function fail(message) {
	console.error(`validate-smoke-jsonl: ${message}`);
	process.exit(1);
}

function collectJsonlFiles(root) {
	const files = [];
	function walk(dir) {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const st = statSync(path);
			if (st.isDirectory()) walk(path);
			else if (path.endsWith(".jsonl")) files.push(path);
		}
	}
	walk(root);
	return files.sort();
}

function isNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBadUsage(usage) {
	return (
		!usage ||
		typeof usage !== "object" ||
		!isNonNegativeNumber(usage.input) ||
		!isNonNegativeNumber(usage.output) ||
		!isNonNegativeNumber(usage.totalTokens) ||
		usage.cacheRead !== 0 ||
		usage.cacheWrite !== 0
	);
}

function parseJsonlFile(file) {
	const lines = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const records = [];
	let parseErrorCount = 0;
	for (const line of lines) {
		try {
			records.push(JSON.parse(line));
		} catch {
			parseErrorCount += 1;
		}
	}
	return { lineCount: lines.length, records, parseErrorCount };
}

function main() {
	const args = process.argv.slice(2);
	if (args.includes("-h") || args.includes("--help")) {
		printHelp();
		return;
	}

	if (args.length > 1) {
		fail("too many arguments; pass only the smoke directory");
	}

	const smokeDir = args[0] ?? process.env.SMOKE_DIR;
	if (!smokeDir) {
		fail("missing smoke directory; pass a path or set SMOKE_DIR");
	}

	let files;
	try {
		files = collectJsonlFiles(smokeDir);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	if (files.length === 0) {
		console.error(`validate-smoke-jsonl: no JSONL files under ${smokeDir}`);
		process.exit(2);
	}

	let failures = 0;
	for (const file of files) {
		let summary;
		try {
			const { lineCount, records, parseErrorCount } = parseJsonlFile(file);
			const messages = records.filter((record) => record.type === "message").map((record) => record.message);
			const assistants = messages.filter((message) => message?.role === "assistant");
			const usage = assistants.map((message) => message.usage).filter(Boolean);
			const badUsage = assistants.map((message) => message.usage).filter(isBadUsage);
			const fileFailure = lineCount === 0 || parseErrorCount > 0 || assistants.length === 0 || usage.length !== assistants.length || badUsage.length > 0;
			if (fileFailure) failures += 1;
			summary = {
				file: relative(smokeDir, file),
				lineCount,
				parseErrorCount,
				messageCount: messages.length,
				assistantCount: assistants.length,
				usageCount: usage.length,
				badUsageCount: badUsage.length,
			};
		} catch (error) {
			failures += 1;
			summary = {
				file: relative(smokeDir, file),
				readError: error instanceof Error ? error.message : String(error),
			};
		}
		console.log(JSON.stringify(summary));
	}

	process.exit(failures === 0 ? 0 : 1);
}

main();
