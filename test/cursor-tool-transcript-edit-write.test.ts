import { describe, expect, it } from "vitest";
import { CURSOR_REPLAY_ACTIVITY_TOOL_NAME } from "../src/cursor-tool-names.js";
import { buildCursorPiToolDisplay } from "../src/cursor-tool-transcript.js";


describe("formatCursorToolTranscript edit and write", () => {

	it("uses native edit replay only when Cursor edit args can truthfully satisfy pi edit schema", () => {
		const editDisplay = buildCursorPiToolDisplay({
			name: "edit",
			args: { path: "src/index.ts", oldText: "old line\n", newText: "new line\n" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 1, diffString: "--- a/src/index.ts\n+++ b/src/index.ts" } },
		});
		const writeDisplay = buildCursorPiToolDisplay({
			name: "write",
			args: { path: "new.txt", content: "hello\n" },
			result: { status: "success", value: { linesCreated: 1, fileSize: 6, fileContentAfterWrite: "hello\n" } },
		});

		expect(editDisplay).toMatchObject({
			toolName: "edit",
			args: { path: "src/index.ts", edits: [{ oldText: "old line\n", newText: "new line\n" }] },
			result: { details: { cursorToolName: "edit", diff: "--- a/src/index.ts\n+++ b/src/index.ts" } },
			isError: false,
		});
		expect(editDisplay.toolName).not.toContain("cursor");
		expect(editDisplay.result.content[0].text).toContain("edit src/index.ts");
		expect(editDisplay.result.content[0].text).toContain("+1 -1");
		expect(writeDisplay).toMatchObject({
			toolName: "write",
			args: { path: "new.txt", content: "hello\n" },
			result: { details: { cursorToolName: "write", fileContentAfterWrite: "hello\n" } },
			isError: false,
		});
		expect(writeDisplay.toolName).not.toContain("cursor");
		expect(writeDisplay.result.content[0].text).toContain("write new.txt");
		expect(writeDisplay.result.content[0].text).toContain("Created 1 lines");
		expect(writeDisplay.result.content[0].text).toContain("hello");
	});

	it("falls back path-only Cursor edit replay to neutral cursor activity", () => {
		const editDisplay = buildCursorPiToolDisplay({
			name: "edit",
			args: { path: ".tool-demo-temp.txt" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 0, diffString: "--- a/.tool-demo-temp.txt\n+++ b/.tool-demo-temp.txt" } },
		});

		expect(editDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: ".tool-demo-temp.txt", activityTitle: "Cursor edit", activitySummary: ".tool-demo-temp.txt" },
			result: { details: { cursorToolName: "edit", title: "Cursor edit", summary: ".tool-demo-temp.txt", diff: "--- a/.tool-demo-temp.txt\n+++ b/.tool-demo-temp.txt" } },
			isError: false,
		});
		expect(editDisplay.args).not.toHaveProperty("edits");
		expect(editDisplay.result.content[0].text).toContain("edit .tool-demo-temp.txt");
	});

	it("maps Cursor StrReplace to schema-valid edit replay and notebook edits to neutral cursor activity", () => {
		const strReplaceDisplay = buildCursorPiToolDisplay({
			name: "StrReplace",
			args: { path: "src/index.ts", old_string: "before", new_string: "after" },
			result: { status: "success", value: { linesAdded: 2, linesRemoved: 1, diff: "--- a/src/index.ts\n+++ b/src/index.ts" } },
		});
		const notebookDisplay = buildCursorPiToolDisplay({
			name: "EditNotebook",
			args: { path: "notebooks/demo.ipynb", cellId: "cell-1" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 0, unifiedDiff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
		});
		const genericNotebookEditDisplay = buildCursorPiToolDisplay({
			name: "edit",
			args: { path: "notebooks/demo.ipynb", oldText: "before", newText: "after" },
			result: { status: "success", value: { linesAdded: 1, linesRemoved: 1, unifiedDiff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
		});

		expect(strReplaceDisplay).toMatchObject({
			toolName: "edit",
			args: { path: "src/index.ts", edits: [{ oldText: "before", newText: "after" }] },
			result: { details: { cursorToolName: "edit", diff: "--- a/src/index.ts\n+++ b/src/index.ts" } },
			isError: false,
		});
		expect(notebookDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: "notebooks/demo.ipynb", cellId: "cell-1", activityTitle: "Cursor edit", activitySummary: "notebooks/demo.ipynb" },
			result: { details: { cursorToolName: "edit", title: "Cursor edit", diff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
			isError: false,
		});
		expect(genericNotebookEditDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: "notebooks/demo.ipynb", oldText: "before", newText: "after", activityTitle: "Cursor edit", activitySummary: "notebooks/demo.ipynb" },
			result: { details: { cursorToolName: "edit", title: "Cursor edit", diff: "--- a/notebooks/demo.ipynb\n+++ b/notebooks/demo.ipynb" } },
			isError: false,
		});
		expect(strReplaceDisplay.toolName).not.toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
		expect(notebookDisplay.args).not.toHaveProperty("edits");
		expect(genericNotebookEditDisplay.args).not.toHaveProperty("edits");
	});

	it("builds replay-only native pi display data for Cursor workflow and utility tools", () => {
		const lintsDisplay = buildCursorPiToolDisplay(
			{
				name: "readLints",
				args: { path: "/repo/src/index.ts" },
				result: {
					status: "success",
					value: { fileDiagnostics: [{ path: "/repo/src/index.ts", diagnostics: [] }], totalDiagnostics: 0 },
				},
			},
			{ cwd: "/repo" },
		);
		const todosDisplay = buildCursorPiToolDisplay({
			name: "updateTodos",
			args: {},
			result: {
				status: "success",
				value: {
					todos: [
						{ content: "Run Read/Grep/Glob", status: "completed" },
						{ content: "Run Task/MCP", status: "pending" },
					],
					totalCount: 2,
				},
			},
		});
		const planDisplay = buildCursorPiToolDisplay({
			name: "createPlan",
			args: {},
			result: {
				status: "success",
				value: {
					todos: [
						{ content: "Draft plan", status: "completed" },
						{ content: "Review plan", status: "pending" },
					],
					totalCount: 2,
				},
			},
		});
		const taskDisplay = buildCursorPiToolDisplay({
			name: "task",
			args: { description: "Quick ls demo subagent" },
			result: {
				status: "success",
				value: { result: { success: { command: "ls src | head -5", stdout: "context.ts\ncursor-provider.ts\n" } } },
			},
		});
		const mcpDisplay = buildCursorPiToolDisplay({
			name: "mcp",
			args: { toolName: "git" },
			result: {
				status: "success",
				value: { content: [{ text: { text: "## Git Status ✅\n13 modified" } }], isError: false },
			},
		});
		const deleteDisplay = buildCursorPiToolDisplay(
			{
				name: "delete",
				args: { path: "/repo/.debug/delete-me.txt" },
				result: { status: "success", value: { fileSize: 9 } },
			},
			{ cwd: "/repo" },
		);

		expect(lintsDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { paths: ["src/index.ts"], diagnosticCount: 0, activityTitle: "Cursor diagnostics", activitySummary: "0 diagnostics in src/index.ts" },
			result: { details: { cursorToolName: "readLints", title: "Cursor diagnostics", summary: "0 diagnostics in src/index.ts" } },
			isError: false,
		});
		expect(lintsDisplay.result.content[0].text).toContain("No diagnostics in src/index.ts");
		expect(todosDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { totalCount: 2, activityTitle: "Cursor todos", activitySummary: "1/2 completed, 1 pending" },
			result: {
				details: {
					cursorToolName: "updateTodos",
					title: "Cursor todos",
					summary: "1/2 completed, 1 pending",
				},
			},
			isError: false,
		});
		expect(planDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { totalCount: 2, activityTitle: "Cursor plan", activitySummary: "1/2 completed, 1 pending" },
			result: {
				details: {
					cursorToolName: "createPlan",
					title: "Cursor plan",
					summary: "1/2 completed, 1 pending",
				},
			},
			isError: false,
		});
		expect(todosDisplay.result.content[0].text).toContain("✓ Run Read/Grep/Glob (completed)");
		expect(taskDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { description: "Quick ls demo subagent", activityTitle: "Cursor task", activitySummary: "Quick ls demo subagent: $ ls src | head -5" },
			result: { details: { cursorToolName: "task", title: "Cursor task", summary: "Quick ls demo subagent: $ ls src | head -5" } },
			isError: false,
		});
		expect(taskDisplay.result.content[0].text).toContain("context.ts");
		expect(mcpDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { toolName: "git", activityTitle: "Cursor MCP", activitySummary: "git · ## Git Status ✅" },
			result: { details: { cursorToolName: "mcp", title: "Cursor MCP", summary: "git · ## Git Status ✅" } },
			isError: false,
		});
		expect(mcpDisplay.result.content[0].text).toContain("## Git Status ✅");
		expect(mcpDisplay.result.content[0].text).not.toContain('"content"');
		expect(deleteDisplay).toMatchObject({
			toolName: CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
			args: { path: ".debug/delete-me.txt", activityTitle: "Cursor delete", activitySummary: ".debug/delete-me.txt" },
			result: { details: { cursorToolName: "delete", title: "Cursor delete", path: ".debug/delete-me.txt" } },
			isError: false,
		});
		expect(deleteDisplay.result.content[0].text).toContain("Deleted 9 bytes");
	});
});
