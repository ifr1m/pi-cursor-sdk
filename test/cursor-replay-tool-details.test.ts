import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplayFromSpec } from "../src/cursor-transcript-tool-specs.js";
import {
	buildCursorReplayEditDetails,
	parseCursorReplayToolDetails,
	type CursorReplayEditDetails,
	type CursorReplayGenerateImageDetails,
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
			title: "Cursor generateImage",
			imagePath: "/tmp/out.png",
			summary: "saved /tmp/out.png",
		} satisfies CursorReplayGenerateImageDetails);

		expect(edit?.cursorToolName).toBe("edit");
		expect(write?.cursorToolName).toBe("write");
		expect(image?.cursorToolName).toBe("generateImage");
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
			cursorToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
		} satisfies CursorReplayTitledActivityDetails);
		expect(parsed).not.toHaveProperty("untrusted");
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
		expect(details?.cursorToolName).toBe("generateImage");
		if (details?.cursorToolName !== "generateImage") throw new Error("expected generateImage details");
		expect(details.imagePath).toBe("/tmp/generated.png");
	});
});
