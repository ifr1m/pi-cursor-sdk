import { describe, expect, expectTypeOf, it } from "vitest";
import { buildCursorPiToolDisplayFromSpec } from "../src/cursor-transcript-tool-specs.js";
import {
	CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE,
	buildCursorReplayEditDetails,
	parseCursorReplayToolDetails,
	type CursorReplayActivityCursorToolName,
	type CursorReplayEditDetails,
	type CursorReplayGenerateImageDetails,
	type CursorReplayGenericFallbackDetails,
	type CursorReplayTitledActivityDetails,
	type CursorReplayWriteDetails,
} from "../src/cursor-replay-tool-details.js";
import {
	renderCursorReplayResult,
	type CursorReplayRenderTheme,
} from "../src/cursor-native-tool-display-replay.js";

const theme = {
	fg: (_name: string, value: string) => value,
	bold: (value: string) => value,
} as CursorReplayRenderTheme;

function renderReplayResult(details: unknown, text = "ok"): string {
	return renderCursorReplayResult(
		{ content: [{ type: "text", text }], details },
		{ expanded: false, isPartial: false },
		theme,
		{ isError: false, showImages: false },
		false,
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
		} satisfies CursorReplayEditDetails);
		const write = parseCursorReplayToolDetails({
			cursorToolName: "write",
			path: "out.txt",
			linesCreated: 3,
		} satisfies CursorReplayWriteDetails);
		const image = parseCursorReplayToolDetails({
			cursorToolName: "generateImage",
			imagePath: "/tmp/out.png",
			summary: "saved /tmp/out.png",
		} satisfies CursorReplayGenerateImageDetails);

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
		} satisfies CursorReplayTitledActivityDetails);
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
		} satisfies CursorReplayGenericFallbackDetails);
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
			result: { status: "success", value: { filePath: "/tmp/generated.png" } },
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
			result: { status: "success", value: { filePath: "/tmp/generated.png" } },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");
		expect(rendered).toContain(`${CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE} saved generated.png`);
		expect(rendered).not.toContain("Cursor image generation");
	});
});

describe("cursor replay tool details type contract", () => {
	it("requires structured tool names on dedicated variants", () => {
		expectTypeOf<CursorReplayEditDetails["variant"]>().toEqualTypeOf<"edit">();
		expectTypeOf<CursorReplayWriteDetails["variant"]>().toEqualTypeOf<"write">();
		expectTypeOf<CursorReplayGenerateImageDetails["variant"]>().toEqualTypeOf<"generateImage">();
		expectTypeOf<CursorReplayTitledActivityDetails["variant"]>().toEqualTypeOf<"titledActivity">();
		expectTypeOf<CursorReplayGenericFallbackDetails["variant"]>().toEqualTypeOf<"genericFallback">();
	});

	it("excludes structured tool names from activity cursorToolName", () => {
		expectTypeOf<"edit">().not.toMatchTypeOf<CursorReplayActivityCursorToolName>();
		expectTypeOf<"write">().not.toMatchTypeOf<CursorReplayActivityCursorToolName>();
		expectTypeOf<"generateImage">().not.toMatchTypeOf<CursorReplayActivityCursorToolName>();
		expectTypeOf<"mcp">().toMatchTypeOf<CursorReplayActivityCursorToolName>();
	});
});
