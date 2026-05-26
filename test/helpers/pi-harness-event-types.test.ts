import { describe, expect, it } from "vitest";
import { createEventHarness, type HarnessEventMap } from "./pi-harness.js";

describe("pi-harness event map types", () => {
	it("keeps compile-time negative fixtures for invalid harness payloads", () => {
		expect(true).toBe(true);
	});
});

describe("pi-harness before_agent_start results", () => {
	it("chains systemPrompt edits across multiple handlers", async () => {
		const pi = createEventHarness();
		pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}-first` }));
		pi.on("before_agent_start", (event) => {
			expect(event.systemPrompt).toContain("-first");
			return { systemPrompt: `${event.systemPrompt}-second` };
		});

		const result = await pi.invokeEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/repo", selectedTools: [] },
		});

		expect(result?.systemPrompt).toBe("base-first-second");
	});

	it("returns undefined when no handler modifies the prompt", async () => {
		const pi = createEventHarness();
		pi.on("before_agent_start", () => undefined);

		const result = await pi.invokeEvent("before_agent_start", {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/repo", selectedTools: [] },
		});

		expect(result).toBeUndefined();
	});
});

// Negative compile tests: invalid harness payloads must not type-check.
// @ts-expect-error session_start requires type and reason
const _invalidSessionStart = {} satisfies HarnessEventMap["session_start"];

const _invalidModelSelect = {
	type: "model_select",
	// @ts-expect-error model_select requires a concrete model
	model: undefined,
	previousModel: undefined,
	source: "set",
} satisfies HarnessEventMap["model_select"];

export {};
