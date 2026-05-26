import { describe, expect, it } from "vitest";
import {
	classifyCursorRunDirectEmission,
	classifyCursorRunLiveEmission,
	isCursorRunFinishedSuccessfully,
	resolveCursorRunOutcome,
} from "../src/cursor-provider-run-outcome.js";

function makeWaitResult(status: "finished" | "cancelled" | "error", result?: string) {
	return {
		id: "run-1",
		agentId: "agent-1",
		status,
		result,
		durationMs: 1,
		model: { id: "composer-2.5" },
	};
}

describe("cursor-provider-run-outcome", () => {
	it("classifies live finished vs direct finished when signal aborted after SDK finish", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "hello"),
			signalAborted: true,
			textDeltas: ["hello"],
			emittedText: "",
		});
		expect(isCursorRunFinishedSuccessfully(outcome)).toBe(false);
		expect(classifyCursorRunLiveEmission(outcome)).toBe("cancelled");
		expect(classifyCursorRunDirectEmission(outcome)).toBe("finished");
	});

	it("classifies live cancelled but direct failed when wait errors after caller abort", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "boom"),
			signalAborted: true,
			textDeltas: [],
			emittedText: "",
		});
		expect(outcome.kind).toBe("error");
		expect(classifyCursorRunLiveEmission(outcome)).toBe("cancelled");
		expect(classifyCursorRunDirectEmission(outcome)).toBe("failed");
	});

	it("classifies SDK cancelled and error statuses for both emission strategies", () => {
		const cancelled = resolveCursorRunOutcome({
			waitResult: makeWaitResult("cancelled"),
			textDeltas: [],
			emittedText: "",
		});
		expect(classifyCursorRunLiveEmission(cancelled)).toBe("cancelled");
		expect(classifyCursorRunDirectEmission(cancelled)).toBe("cancelled");

		const failed = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "boom"),
			textDeltas: [],
			emittedText: "",
		});
		expect(classifyCursorRunLiveEmission(failed)).toBe("failed");
		expect(classifyCursorRunDirectEmission(failed)).toBe("failed");
	});

	it("marks successful finished runs and selects final text", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "final answer"),
			textDeltas: ["final"],
			emittedText: "",
		});
		expect(isCursorRunFinishedSuccessfully(outcome)).toBe(true);
		expect(classifyCursorRunLiveEmission(outcome)).toBe("finished");
		expect(classifyCursorRunDirectEmission(outcome)).toBe("finished");
		expect(outcome.kind).toBe("finished");
		if (outcome.kind === "finished") {
			expect(outcome.finalText).toBe("final answer");
			expect(outcome.assistantTextProduced).toBe(true);
		}
	});
});
