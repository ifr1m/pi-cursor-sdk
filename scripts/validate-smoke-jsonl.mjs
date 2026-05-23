#!/usr/bin/env node
/**
 * Validate assistant usage fields in pi session JSONL files under a smoke directory.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function printHelp() {
	console.log(`Validate assistant usage metadata in pi smoke session JSONL files.

Usage:
  node scripts/validate-smoke-jsonl.mjs <smoke-dir>
  SMOKE_DIR=/tmp/pi-cursor-smoke node scripts/validate-smoke-jsonl.mjs

Arguments:
  smoke-dir                     Directory containing smoke session subdirs and JSONL files.
                                Defaults to SMOKE_DIR when the positional arg is omitted.

Options:
  -h, --help                    Show this help.

Exit codes:
  0  all scanned JSONL files have valid assistant usage metadata
  1  invalid arguments, unreadable directory, or validation failures
  2  no JSONL files found under the smoke directory

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

function isBadUsage(usage) {
	return (
		typeof usage.input !== "number" ||
		usage.input < 0 ||
		typeof usage.output !== "number" ||
		usage.output < 0 ||
		typeof usage.totalTokens !== "number" ||
		usage.totalTokens < 0 ||
		usage.cacheRead !== 0 ||
		usage.cacheWrite !== 0
	);
}

function main() {
	const args = process.argv.slice(2);
	if (args.includes("-h") || args.includes("--help")) {
		printHelp();
		return;
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
		const records = readFileSync(file, "utf8")
			.trim()
			.split(/\n+/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const messages = records.filter((record) => record.type === "message").map((record) => record.message);
		const assistants = messages.filter((message) => message.role === "assistant");
		const usage = assistants.map((message) => message.usage).filter(Boolean);
		const badUsage = usage.filter(isBadUsage);
		if (usage.length !== assistants.length || badUsage.length > 0) failures += 1;
		console.log(
			JSON.stringify({
				file: relative(smokeDir, file),
				assistantCount: assistants.length,
				usageCount: usage.length,
				badUsageCount: badUsage.length,
			}),
		);
	}

	process.exit(failures === 0 ? 0 : 1);
}

main();
