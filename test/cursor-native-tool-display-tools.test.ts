import { describe, expect, it, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as replay from "../src/cursor-native-tool-display-replay.js";
import { wrapNativeCursorTool } from "../src/cursor-native-tool-display-tools.js";

describe("wrapNativeCursorTool", () => {
	it("does not use Cursor replay rendering for ordinary pi edit toolCallIds", () => {
		const replaySpy = vi.spyOn(replay, "renderCursorReplayResult").mockReturnValue(new Text("", 0, 0));
		const delegateRenderResult = vi.fn().mockReturnValue(new Text("pi edit", 0, 0));
		const definition = {
			name: "edit",
			description: "edit",
			parameters: Type.Object({}),
			execute: vi.fn(),
			renderResult: delegateRenderResult,
		} as unknown as ToolDefinition<typeof Type.Object, unknown, unknown>;
		const wrapped = wrapNativeCursorTool(definition, () => definition);
		const theme = { fg: (_style: string, text: string) => text, bold: (text: string) => text } as never;

		wrapped.renderResult?.(
			{
				content: [{ type: "text", text: "edit src/foo.ts" }],
				details: {
					path: "src/foo.ts",
					diffString: "--- a\n+++ b\n",
					linesAdded: 1,
					linesRemoved: 1,
				},
			},
			{ expanded: false, isPartial: false } as never,
			theme,
			{ isError: false, toolCallId: "ordinary-edit-1" } as never,
		);

		expect(replaySpy).not.toHaveBeenCalled();
		expect(delegateRenderResult).toHaveBeenCalledOnce();
		replaySpy.mockRestore();
	});
});
