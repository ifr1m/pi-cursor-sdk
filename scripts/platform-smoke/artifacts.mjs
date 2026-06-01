/**
 * Artifact management — directory layout, manifest, redaction scanning, packaging.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, relative, basename } from "node:path";

/** Create a suite artifact directory. */
export function createSuiteDir(artifactRoot, runId, targetName, suiteName) {
	const dir = resolve(process.cwd(), artifactRoot, runId, targetName, suiteName);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write artifact-manifest.json. */
export function writeManifest(dir, expectedFiles) {
	const actual = [];
	function walk(d) {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const fp = resolve(d, entry.name);
			if (entry.isDirectory()) walk(fp);
			else if (entry.isFile()) actual.push(relative(dir, fp));
		}
	}
	if (existsSync(dir)) walk(dir);

	const manifest = {
		expected: expectedFiles ?? [],
		present: actual,
		missing: (expectedFiles ?? []).filter(f => !actual.includes(f)),
		writtenAt: new Date().toISOString(),
	};
	writeFileSync(resolve(dir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));
	return manifest;
}

const SECRET_PATTERNS = [
	[/Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "Authorization header", "Authorization: Bearer [REDACTED_BEARER_TOKEN]"],
	[/(bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/gi, "bearer token", "$1[REDACTED_BEARER_TOKEN]"],
	[/connect\.sid=[A-Za-z0-9%]+/gi, "session cookie", "connect.sid=[REDACTED_SESSION_COOKIE]"],
	[/https?:\/\/[^/\s]*\/cursor-pi-tool-bridge\/[A-Za-z0-9_.:-]+\/mcp/gi, "bridge endpoint URL", "[REDACTED_BRIDGE_ENDPOINT_URL]"],
	[/"(apiKey|accessToken|refreshToken|session|cookie)"\s*:\s*"[^"\s]{12,}"/gi, "auth/token JSON field", '"$1":"[REDACTED_SECRET]"'],
];

/** Redact known secret material before writing logs/artifacts. */
export function redactSecrets(text) {
	let redacted = String(text ?? "");
	const cursorKey = process.env.CURSOR_API_KEY;
	if (cursorKey && cursorKey.length > 10) {
		redacted = redacted.split(cursorKey).join("[REDACTED_CURSOR_API_KEY]");
	}
	for (const [pattern, , replacement] of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

/** Scan text content for secrets. Returns array of violation descriptions. */
export function scanForSecrets(text) {
	const violations = [];
	const cursorKey = process.env.CURSOR_API_KEY;
	if (cursorKey && cursorKey.length > 10 && String(text ?? "").includes(cursorKey)) {
		violations.push("CURSOR_API_KEY literal found");
	}
	for (const [pattern, label] of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(String(text ?? ""))) violations.push(`potential ${label}`);
	}
	return violations;
}

/** Scan all text files in a directory for secrets. */
export function scanArtifacts(dir) {
	const findings = [];
	function walk(d) {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const fp = resolve(d, entry.name);
			if (entry.isDirectory()) { walk(fp); continue; }
			if (!entry.isFile()) continue;
			const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
			if (!["txt", "json", "jsonl", "md", "log", "ansi", "html", "yml", "yaml", "js", "mjs", "ts"].includes(ext)) continue;
			try {
				const content = readFileSync(fp, "utf-8");
				const violations = scanForSecrets(content);
				for (const v of violations) {
					findings.push({ file: relative(dir, fp), violation: v });
				}
			} catch { /* binary or unreadable */ }
		}
	}
	walk(dir);
	return findings;
}

/** Write summary.json for a suite. */
export function writeSummary(dir, data) {
	writeFileSync(resolve(dir, "summary.json"), JSON.stringify({
		...data,
		writtenAt: new Date().toISOString(),
	}, null, 2));
}

/** Write command.txt recording the command that was executed. */
export function writeCommand(dir, cmd) {
	writeFileSync(resolve(dir, "command.txt"), Array.isArray(cmd) ? cmd.join(" ") + "\n" : cmd + "\n");
}

/** Write exit-code.txt. */
export function writeExitCode(dir, code, signal) {
	writeFileSync(resolve(dir, "exit-code.txt"), `code=${code}\nsignal=${signal ?? "none"}\n`);
}

/** Package a directory as tar.gz (posix) or zip (powershell). */
export async function packageArtifacts(dir, archivePath) {
	const { execSync } = await import("node:child_process");
	const dirName = basename(dir);
	const parentDir = resolve(dir, "..");
	if (archivePath.endsWith(".tar.gz")) {
		execSync(`tar -czf "${archivePath}" -C "${parentDir}" "${dirName}"`, { stdio: "pipe" });
	} else if (archivePath.endsWith(".zip")) {
		execSync(`cd "${parentDir}" && zip -r "${archivePath}" "${dirName}"`, { stdio: "pipe" });
	}
	return archivePath;
}
