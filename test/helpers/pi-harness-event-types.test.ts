import { describe, expect, it } from "vitest";
import type { HarnessEventMap } from "./pi-harness.js";

describe("pi-harness event map types", () => {
	it("keeps compile-time negative fixtures for invalid harness payloads", () => {
		expect(true).toBe(true);
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
