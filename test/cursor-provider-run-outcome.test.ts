import { describe, expect, it } from "vitest";
import {
	classifyCursorRunEmission,
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
	it("normalizes signal-aborted finished waits to cancelled outcomes", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "hello"),
			signalAborted: true,
			textDeltas: ["hello"],
			emittedText: "",
		});
		expect(outcome.kind).toBe("cancelled");
		expect(isCursorRunFinishedSuccessfully(outcome)).toBe(false);
		expect(classifyCursorRunEmission(outcome)).toBe("cancelled");
	});

	it("normalizes signal-aborted error waits to cancelled outcomes", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "boom"),
			signalAborted: true,
			textDeltas: [],
			emittedText: "",
		});
		expect(outcome.kind).toBe("cancelled");
		expect(classifyCursorRunEmission(outcome)).toBe("cancelled");
	});

	it("never produces finished outcomes with signalAborted", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "hello"),
			signalAborted: true,
			textDeltas: [],
			emittedText: "",
		});
		if (outcome.kind === "finished") {
			expect.fail("finished outcome must not carry caller abort");
		}
	});

	it("classifies SDK cancelled and error statuses for both emission strategies", () => {
		const cancelled = resolveCursorRunOutcome({
			waitResult: makeWaitResult("cancelled"),
			textDeltas: [],
			emittedText: "",
		});
		expect(cancelled.kind).toBe("error");
		expect(classifyCursorRunEmission(cancelled)).toBe("failed");
		if (cancelled.kind === "error") {
			expect(cancelled.errorMessage).toContain("Network error");
			expect(cancelled.errorMessage).toContain("pi will retry automatically");
		}

		const failed = resolveCursorRunOutcome({
			waitResult: makeWaitResult("error", "boom"),
			textDeltas: [],
			emittedText: "",
		});
		expect(classifyCursorRunEmission(failed)).toBe("failed");
	});

	it("keeps caller AbortSignal cancels as cancelled outcomes", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("cancelled"),
			signalAborted: true,
			textDeltas: [],
			emittedText: "",
		});
		expect(outcome.kind).toBe("cancelled");
		expect(classifyCursorRunEmission(outcome)).toBe("cancelled");
		if (outcome.kind === "cancelled") {
			expect(outcome.abortMessage).toBe("Cancelled: prompt interrupted.");
		}
	});

	it("marks successful finished runs and selects final text", () => {
		const outcome = resolveCursorRunOutcome({
			waitResult: makeWaitResult("finished", "final answer"),
			textDeltas: ["final"],
			emittedText: "",
		});
		expect(isCursorRunFinishedSuccessfully(outcome)).toBe(true);
		expect(classifyCursorRunEmission(outcome)).toBe("finished");
		expect(outcome.kind).toBe("finished");
		if (outcome.kind === "finished") {
			expect(outcome.finalText).toBe("final answer");
			expect(outcome.assistantTextProduced).toBe(true);
		}
	});
});
