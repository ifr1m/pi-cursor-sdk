import { describe, expect, it } from "vitest";
import {
	installCursorSdkAbortErrorSuppression,
	isCursorSdkAbortConnectError,
} from "../src/cursor-sdk-abort-error-guard.js";

function makeCursorSdkAbortConnectError(): Error & { rawMessage: string; code: number; cause: DOMException } {
	const error = new Error("[canceled] This operation was aborted") as Error & {
		rawMessage: string;
		code: number;
		cause: DOMException;
	};
	error.name = "ConnectError";
	error.rawMessage = "This operation was aborted";
	error.code = 1;
	error.cause = new DOMException("This operation was aborted", "AbortError");
	error.stack =
		"ConnectError: [canceled] This operation was aborted\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456\n" +
		"Caused by: AbortError";
	return error;
}

describe("Cursor SDK abort error guard", () => {
	it("matches local Cursor SDK abort ConnectError shape", () => {
		expect(isCursorSdkAbortConnectError(makeCursorSdkAbortConnectError())).toBe(true);
		expect(isCursorSdkAbortConnectError(new Error("boom"))).toBe(false);
	});

	it("suppresses matching uncaught exceptions only after abort suppression is enabled", () => {
		const suppression = installCursorSdkAbortErrorSuppression();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			suppression.suppressAbortErrors();
			const emitted = process.emit("uncaughtException", makeCursorSdkAbortConnectError(), "uncaughtException");
			expect(emitted).toBe(false);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});
});
