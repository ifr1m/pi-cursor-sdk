import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplayFromSpec } from "../src/cursor-transcript-tool-specs.js";
import {
	CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE,
	buildCursorReplayEditDetails,
	parseCursorReplayToolDetails,
} from "../src/cursor-replay-tool-details.js";
import {
	renderCursorReplayResult,
	type CursorReplayRenderTheme,
} from "../src/cursor-native-tool-display-replay.js";

const theme = {
	fg: (_name: string, value: string) => value,
	bold: (value: string) => value,
} as CursorReplayRenderTheme;

function renderReplayResult(details: unknown, text = "ok", isError = false): string {
	return renderCursorReplayResult(
		{ content: [{ type: "text", text }], details },
		{ expanded: false, isPartial: false },
		theme,
		{ isError, showImages: false } as never,
		isError,
	)
		.render(120)
		.join("\n");
}

describe("cursor replay tool details contract", () => {
	it("parses known edit, write, and generateImage detail variants", () => {
		const edit = parseCursorReplayToolDetails({
			cursorToolName: "edit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			cursorToolName: "write",
			path: "out.txt",
			linesCreated: 3,
		});
		const image = parseCursorReplayToolDetails({
			cursorToolName: "generateImage",
			imagePath: "/tmp/out.png",
			summary: "saved /tmp/out.png",
		});

		expect(edit).toMatchObject({ variant: "edit", cursorToolName: "edit" });
		expect(write).toMatchObject({ variant: "write", cursorToolName: "write" });
		expect(image).toMatchObject({ variant: "generateImage", cursorToolName: "generateImage" });
	});

	it("parses titled activity details and ignores unknown fields at the boundary", () => {
		const parsed = parseCursorReplayToolDetails({
			cursorToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
			untrusted: "drop-me",
		});
		expect(parsed).toEqual({
			variant: "titledActivity",
			cursorToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
		});
		expect(parsed).not.toHaveProperty("untrusted");
	});

	it("parses generic fallback details without a title", () => {
		const parsed = parseCursorReplayToolDetails({
			cursorToolName: "futureTool",
			summary: "done",
		});
		expect(parsed).toEqual({
			variant: "genericFallback",
			cursorToolName: "futureTool",
			summary: "done",
		});
	});

	it("renders edit replay through the typed edit renderer path", () => {
		const rendered = renderReplayResult(
			buildCursorReplayEditDetails({
				path: "src/example.ts",
				diffString: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
				linesAdded: 1,
			}),
		);
		expect(rendered).toContain("edit");
		expect(rendered).toContain("src/example.ts");
		expect(rendered).toContain("added 1 line");
	});

	it("renders write replay through the typed write renderer path", () => {
		const rendered = renderReplayResult({
			cursorToolName: "write",
			path: "notes.txt",
			linesCreated: 2,
			expandedText: "hello\nworld",
		});
		expect(rendered).toContain("write");
		expect(rendered).toContain("notes.txt");
		expect(rendered).toContain("2 lines");
	});

	it("produces typed generateImage details from the display spec producer", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "success", value: { filePath: "/tmp/generated.png" }, error: undefined },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const details = parseCursorReplayToolDetails(display.result.details);
		expect(details).toMatchObject({
			variant: "generateImage",
			cursorToolName: "generateImage",
			imagePath: "/tmp/generated.png",
		});
		expect(details).not.toHaveProperty("title");
	});

	it("renders generateImage producer details with the legacy visible title and path", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "success", value: { filePath: "/tmp/generated.png" }, error: undefined },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");
		expect(rendered).toContain(`${CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE} saved generated.png`);
		expect(rendered).not.toContain("Cursor image generation");
	});

	it("renders path-only edit errors with the title-backed error body", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "edit",
			name: "edit",
			args: { path: "src/a.ts" },
			result: { status: "error", value: undefined, error: "no match" },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "", true);

		expect(display.result.details).toMatchObject({
			cursorToolName: "edit",
			title: "Cursor edit",
		});
		expect(rendered).toContain("Cursor edit");
		expect(rendered).toContain("Error: no match");
		expect(rendered).not.toMatch(/^edit src\/a\.ts$/m);
	});

	it("renders path-only edit no-change results with the Cursor edit replay title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "edit",
			name: "edit",
			args: { path: "src/a.ts" },
			result: { status: "success", value: { linesAdded: 0, linesRemoved: 0 }, error: undefined },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(display.result.details).toMatchObject({
			cursorToolName: "edit",
			title: "Cursor edit",
		});
		expect(rendered).toContain("Cursor edit");
		expect(rendered).not.toMatch(/^edit src\/a\.ts$/m);
	});

	it("renders path-only write errors with the title-backed error body", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "write",
			name: "write",
			args: { path: "src/a.ts" },
			result: { status: "error", value: undefined, error: "permission denied" },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "", true);

		expect(display.result.details).toMatchObject({
			cursorToolName: "write",
			title: "Cursor write",
		});
		expect(rendered).toContain("write src/a.ts");
		expect(rendered).toContain("Error: permission denied");
		expect(rendered).not.toMatch(/^write src\/a\.ts$/m);
	});

	it("renders generateImage producer error details with the legacy visible title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "error", value: undefined, error: "image generation failed" },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderCursorReplayResult(
			{
				content: display.result.content,
				details: display.result.details,
			},
			{ expanded: false, isPartial: false },
			theme,
			{ isError: true, showImages: false } as never,
			true,
		)
			.render(120)
			.join("\n");
		expect(rendered).toContain(CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE);
		expect(rendered).not.toMatch(/^image generation failed$/m);
	});
});
