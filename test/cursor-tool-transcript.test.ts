import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplay, formatCursorToolTranscript, mergeCursorToolCalls } from "../src/cursor-tool-transcript.js";

describe("formatCursorToolTranscript", () => {
	it("formats Cursor read results as a pi-like read transcript", () => {
		const transcript = formatCursorToolTranscript({
			name: "read",
			args: { path: "README.md" },
			result: {
				status: "success",
				value: { content: "# pi-cursor-sdk\n\nA pi provider extension", totalLines: 3, fileSize: 42 },
			},
		});

		expect(transcript).toBe("read README.md\n\n# pi-cursor-sdk\n\nA pi provider extension\n");
	});

	it("fills empty Cursor read results from a safe local file preview", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-"));
		try {
			writeFileSync(join(dir, "README.md"), "# Local title\n\nLocal body\n");

			const transcript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(dir, "README.md") },
					result: { status: "success", value: { content: "", totalLines: 3, fileSize: 26 } },
				},
				{ cwd: dir },
			);

			expect(transcript).toContain("read README.md");
			expect(transcript).toContain("# Local title");
			expect(transcript).toContain("Local body");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fill empty Cursor read results from sensitive or out-of-workspace files", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "cursor-tool-transcript-outside-"));
		try {
			writeFileSync(join(dir, ".env"), "API_KEY=do-not-show\n");
			writeFileSync(join(outsideDir, "notes.txt"), "outside content\n");

			const sensitiveTranscript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(dir, ".env") },
					result: { status: "success", value: { content: "", totalLines: 1, fileSize: 20 } },
				},
				{ cwd: dir },
			);
			const outsideTranscript = formatCursorToolTranscript(
				{
					name: "read",
					args: { path: join(outsideDir, "notes.txt") },
					result: { status: "success", value: { content: "", totalLines: 1, fileSize: 16 } },
				},
				{ cwd: dir },
			);

			expect(sensitiveTranscript).not.toContain("do-not-show");
			expect(outsideTranscript).not.toContain("outside content");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("shortens absolute workspace paths to relative paths", () => {
		const transcript = formatCursorToolTranscript(
			{
				name: "read",
				args: { path: "/repo/README.md" },
				result: { status: "success", value: { content: "# Title" } },
			},
			{ cwd: "/repo" },
		);

		expect(transcript).toContain("read README.md");
		expect(transcript).not.toContain("/repo/README.md");
	});

	it("formats Cursor shell results as a pi-like bash transcript", () => {
		const transcript = formatCursorToolTranscript({
			name: "shell",
			args: { command: "date" },
			result: {
				status: "success",
				value: { stdout: "Sat May  9 10:48:38 MDT 2026\n", stderr: "", exitCode: 0, executionTime: 12 },
			},
		});

		expect(transcript).toContain("$ date\n\nSat May  9 10:48:38 MDT 2026");
		expect(transcript).toContain("Took 0.0s");
	});

	it("builds native pi display data for Cursor ls calls without parsing formatted transcript headers", () => {
		const display = buildCursorPiToolDisplay({
			name: "ls",
			args: { path: "." },
			result: {
				status: "success",
				value: {
					directoryTreeRoot: {
						name: "root",
						children: [{ name: "src" }, { name: "test" }],
					},
				},
			},
		});

		expect(display).toMatchObject({
			toolName: "ls",
			args: { path: "." },
			result: { content: [{ type: "text", text: "root\n  src\n  test" }] },
			isError: false,
		});
		expect(display.result.content[0].text).not.toContain("ls .");
	});

	it("builds native pi display data for Cursor read and shell calls", () => {
		const readDisplay = buildCursorPiToolDisplay({
			name: "read",
			args: { path: "README.md" },
			result: { status: "success", value: { content: "# Title" } },
		});
		const shellDisplay = buildCursorPiToolDisplay({
			name: "run_terminal_cmd",
			args: { command: "date" },
			result: { status: "success", value: { stdout: "Sat May  9\n", stderr: "", exitCode: 0 } },
		});

		expect(readDisplay).toMatchObject({
			toolName: "read",
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "# Title" }] },
			isError: false,
		});
		expect(shellDisplay).toMatchObject({
			toolName: "bash",
			args: { command: "date" },
			result: { content: [{ type: "text", text: "Sat May  9" }] },
			isError: false,
		});
	});

	it("keeps started tool args when the completed Cursor update only contains a result", () => {
		const merged = mergeCursorToolCalls(
			{ name: "read", args: { path: "src/index.ts" } },
			{ name: "read", result: { status: "success", value: { content: "export default" } } },
		);

		expect(formatCursorToolTranscript(merged)).toContain("read src/index.ts");
	});

	it("maps common Cursor aliases to pi-like command names", () => {
		const transcript = formatCursorToolTranscript({
			name: "run_terminal_cmd",
			args: { command: "pwd" },
			result: { status: "success", value: { stdout: "/tmp\n", stderr: "", exitCode: 0, executionTime: 1 } },
		});

		expect(transcript).toContain("$ pwd");
		expect(transcript).toContain("/tmp");
	});

	it("bounds large Cursor read output", () => {
		const transcript = formatCursorToolTranscript(
			{
				name: "read",
				args: { path: "big.txt" },
				result: { status: "success", value: { content: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") } },
			},
			{ maxLines: 3, maxChars: 1000 },
		);

		expect(transcript).toContain("read big.txt");
		expect(transcript).toContain("line 0\nline 1\nline 2");
		expect(transcript).toContain("17 more lines");
	});
});
