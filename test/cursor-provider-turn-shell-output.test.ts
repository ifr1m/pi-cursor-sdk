import { describe, expect, it } from "vitest";
import {
	CursorShellOutputTracker,
	getCursorShellOutputDelta,
	mergeShellOutputDeltasIntoCursorToolCall,
} from "../src/cursor-provider-turn-shell-output.js";

describe("CursorShellOutputTracker", () => {
	it("buffers stdout/stderr for a single active shell call", () => {
		const tracker = new CursorShellOutputTracker();
		tracker.onShellToolStarted("shell-1");
		tracker.appendShellOutputDelta({ stream: "stdout", data: "line one\n" });
		tracker.appendShellOutputDelta({ stream: "stderr", data: "warn\n" });

		expect(tracker.takeDeltasForCall("shell-1")).toEqual({
			stdout: ["line one\n"],
			stderr: ["warn\n"],
		});
	});

	it("drops buffered deltas when multiple shell calls overlap", () => {
		const tracker = new CursorShellOutputTracker();
		tracker.onShellToolStarted("shell-1");
		tracker.appendShellOutputDelta({ stream: "stdout", data: "first\n" });
		tracker.onShellToolStarted("shell-2");
		tracker.appendShellOutputDelta({ stream: "stdout", data: "ambiguous\n" });

		expect(tracker.takeDeltasForCall("shell-1")).toBeUndefined();
		expect(tracker.takeDeltasForCall("shell-2")).toBeUndefined();
	});
});

describe("mergeShellOutputDeltasIntoCursorToolCall", () => {
	it("fills empty completed stdout from buffered deltas", () => {
		const merged = mergeShellOutputDeltasIntoCursorToolCall(
			{
				name: "shell",
				result: { status: "success", value: { stdout: "", stderr: "", exitCode: 0 } },
			},
			{ stdout: ["delta output\n"], stderr: [] },
		);
		expect(merged).toMatchObject({
			result: { status: "success", value: { stdout: "delta output\n", stderr: "" } },
		});
	});

	it("keeps completed stdout when already present", () => {
		const toolCall = {
			name: "shell",
			result: { status: "success", value: { stdout: "completed\n", stderr: "" } },
		};
		expect(
			mergeShellOutputDeltasIntoCursorToolCall(toolCall, {
				stdout: ["delta\n"],
				stderr: [],
			}),
		).toBe(toolCall);
	});
});

describe("getCursorShellOutputDelta", () => {
	it("parses stdout shell-output-delta updates", () => {
		expect(
			getCursorShellOutputDelta({
				type: "shell-output-delta",
				event: { case: "stdout", value: { data: "ok\n" } },
			} as never),
		).toEqual({ stream: "stdout", data: "ok\n" });
	});
});
