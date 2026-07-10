import { describe, expect, it } from "vitest";
import { isUnauthenticatedConnectError } from "../src/cursor-provider-errors.js";
import {
	installCursorSdkProcessErrorGuard,
	isCursorSdkAbortConnectError,
	runWithCursorSdkCompactionPrepGuard,
} from "../src/cursor-sdk-process-error-guard.js";

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

function makeCursorSdkUnauthenticatedConnectError(): Error & { rawMessage: string; code: number } {
	const error = new Error("[unauthenticated] Error") as Error & { rawMessage: string; code: number };
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 16;
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorBackendUnauthenticatedConnectError(): Error & { rawMessage: string; code: number; details: Array<{ type: string }> } {
	const error = makeCursorSdkUnauthenticatedConnectError() as Error & {
		rawMessage: string;
		code: number;
		details: Array<{ type: string }>;
	};
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19";
	error.details = [{ type: "aiserver.v1.ErrorDetails" }];
	return error;
}

function makeCursorSdkNestedStallAbortConnectError(): Error & {
	rawMessage: string;
	code: number;
	cause: Error & { rawMessage: string; code: number; cause: DOMException };
} {
	const innerCause = new DOMException("This operation was aborted", "AbortError");
	const inner = new Error("[canceled] This operation was aborted") as Error & {
		rawMessage: string;
		code: number;
		cause: DOMException;
	};
	inner.name = "ConnectError";
	inner.rawMessage = "This operation was aborted";
	inner.code = 1;
	inner.cause = innerCause;
	inner.stack =
		"ConnectError: [canceled] This operation was aborted\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";

	const error = new Error("[unknown] [canceled] This operation was aborted") as Error & {
		rawMessage: string;
		code: number;
		cause: Error & { rawMessage: string; code: number; cause: DOMException };
	};
	error.name = "ConnectError";
	error.rawMessage = "[canceled] This operation was aborted";
	error.code = 2;
	error.cause = inner;
	error.stack =
		"ConnectError: [unknown] [canceled] This operation was aborted\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1126528\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

function makeCursorSdkWriteEcanceledConnectError(): Error & {
	rawMessage: string;
	code: number;
	cause: Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException };
} {
	const innerCause = Object.assign(new Error("write ECANCELED"), {
		errno: -89,
		code: "ECANCELED",
		syscall: "write",
	}) as NodeJS.ErrnoException;

	const inner = new Error("[internal] write ECANCELED") as Error & {
		rawMessage: string;
		code: number;
		cause: NodeJS.ErrnoException;
	};
	inner.name = "ConnectError";
	inner.rawMessage = "write ECANCELED";
	inner.code = 13;
	inner.cause = innerCause;
	inner.stack =
		"ConnectError: [internal] write ECANCELED\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:263:30";

	const error = new Error("[unknown] [internal] write ECANCELED") as Error & {
		rawMessage: string;
		code: number;
		cause: Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException };
	};
	error.name = "ConnectError";
	error.rawMessage = "[internal] write ECANCELED";
	error.code = 2;
	error.cause = inner;
	error.stack =
		"ConnectError: [unknown] [internal] write ECANCELED\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1126528\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:263:30";
	return error;
}

function makeNonCursorUnauthenticatedConnectError(): Error & { rawMessage: string; code: number } {
	const error = makeCursorSdkUnauthenticatedConnectError();
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19";
	return error;
}

function makeCursorSdkNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = new Error("[aborted] read ECONNRESET") as Error & {
		rawMessage: string;
		code: number;
		cause: NodeJS.ErrnoException;
	};
	error.name = "ConnectError";
	error.rawMessage = "read ECONNRESET";
	error.code = 10;
	error.cause = Object.assign(new Error("read ECONNRESET"), {
		code: "ECONNRESET",
		syscall: "read",
	});
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorSdkHttp2EnhanceYourCalmConnectError(): Error & {
	rawMessage: string;
	code: number;
	cause: Error & { rawMessage: string; code: string };
} {
	const error = new Error("[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM") as Error & {
		rawMessage: string;
		code: number;
		cause: Error & { rawMessage: string; code: string };
	};
	error.name = "ConnectError";
	error.rawMessage = "Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM";
	error.code = 2;
	error.cause = Object.assign(new Error("stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"), {
		rawMessage: "stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
		code: "ERR_HTTP2_STREAM_ERROR",
	});
	error.stack =
		"ConnectError: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/connect-error.js:71:20\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

function makeCursorExtensionNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///C:/Users/example/.pi/agent/git/github.com/fitchmultz/pi-cursor-sdk/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

function makeCursorBackendNetworkConnectError(): Error & {
	rawMessage: string;
	code: number;
	cause: NodeJS.ErrnoException;
	details: Array<{ type: string }>;
} {
	const error = makeCursorSdkNetworkConnectError() as Error & {
		rawMessage: string;
		code: number;
		cause: NodeJS.ErrnoException;
		details: Array<{ type: string }>;
	};
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	error.details = [{ type: "aiserver.v1.ErrorDetails" }];
	return error;
}

function makeCursorBackendUnavailableConnectError(): Error & {
	rawMessage: string;
	code: number;
	details: Array<{ type: string }>;
} {
	const error = new Error("[unavailable] Error") as Error & {
		rawMessage: string;
		code: number;
		details: Array<{ type: string }>;
	};
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 14;
	error.stack =
		"ConnectError: [unavailable] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19";
	error.details = [{ type: "aiserver.v1.ErrorDetails" }];
	return error;
}

function makeGenericConnectNodeNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/@connectrpc/connect-node/dist/esm/node-universal-client.js:293:63";
	return error;
}

function makeProvenanceFreeNetworkConnectError(): Error & { rawMessage: string; code: number; cause: NodeJS.ErrnoException } {
	const error = makeCursorSdkNetworkConnectError();
	error.stack =
		"ConnectError: [aborted] read ECONNRESET\n" +
		"    at file:///repo/node_modules/some-other-connect-client/index.js:10:1";
	return error;
}

describe("Cursor SDK process error guard", () => {
	it("matches local Cursor SDK abort ConnectError shape", () => {
		expect(isCursorSdkAbortConnectError(makeCursorSdkAbortConnectError())).toBe(true);
		expect(isCursorSdkAbortConnectError(new Error("boom"))).toBe(false);
	});

	it("matches Cursor SDK unauthenticated ConnectError shape", () => {
		expect(isUnauthenticatedConnectError(makeCursorSdkUnauthenticatedConnectError())).toBe(true);
		expect(isUnauthenticatedConnectError(new Error("boom"))).toBe(false);
	});

	it("matches nested Cursor SDK stall-abort ConnectError shape", () => {
		expect(isCursorSdkAbortConnectError(makeCursorSdkNestedStallAbortConnectError())).toBe(true);
	});

	it("suppresses nested stall-abort ConnectErrors during compaction prep", async () => {
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			await runWithCursorSdkCompactionPrepGuard(async () => {
				const emitted = process.emit(
					"uncaughtException",
					makeCursorSdkNestedStallAbortConnectError(),
					"uncaughtException",
				);
				expect(emitted).toBe(true);
				expect(listenerCalled).toBe(false);
			});
		} finally {
			process.removeListener("uncaughtException", listener);
		}
	});

	it("suppresses abort ConnectErrors while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeCursorSdkAbortConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses nested stall-abort ConnectErrors while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit(
				"uncaughtException",
				makeCursorSdkNestedStallAbortConnectError(),
				"uncaughtException",
			);
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it.each([
		["Cursor SDK stack", makeCursorSdkUnauthenticatedConnectError],
		["Cursor backend details", makeCursorBackendUnauthenticatedConnectError],
	])("suppresses Cursor unauthenticated process errors with %s while a provider turn is active", (_name, makeError) => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("does not suppress non-Cursor unauthenticated ConnectErrors", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeNonCursorUnauthenticatedConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it.each([
		["Cursor SDK stack", makeCursorSdkNetworkConnectError],
		["extension-local connect-node stack", makeCursorExtensionNetworkConnectError],
		["Cursor backend details", makeCursorBackendNetworkConnectError],
		["Cursor backend unavailable details", makeCursorBackendUnavailableConnectError],
	])("suppresses Cursor network process errors with %s while a provider turn is active", (_name, makeError) => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses Cursor SDK HTTP/2 stream reset process errors while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit(
				"uncaughtException",
				makeCursorSdkHttp2EnhanceYourCalmConnectError(),
				"uncaughtException",
			);
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses Cursor SDK write ECANCELED process errors while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit(
				"uncaughtException",
				makeCursorSdkWriteEcanceledConnectError(),
				"uncaughtException",
			);
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("suppresses Cursor network unhandled rejections while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("unhandledRejection", listener);
		try {
			const emitted = process.emit("unhandledRejection", makeCursorSdkNetworkConnectError(), Promise.resolve());
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("unhandledRejection", listener);
			suppression.dispose();
		}
	});

	it("suppresses generic connect-node network errors while a provider turn is active", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeGenericConnectNodeNetworkConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(false);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it("does not suppress provenance-free network ConnectErrors during an active provider turn", () => {
		const suppression = installCursorSdkProcessErrorGuard();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeProvenanceFreeNetworkConnectError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
			suppression.dispose();
		}
	});

	it.each([
		["Cursor SDK stack", makeCursorSdkNetworkConnectError],
		["Cursor SDK HTTP/2 stream reset", makeCursorSdkHttp2EnhanceYourCalmConnectError],
		["generic connect-node stack", makeGenericConnectNodeNetworkConnectError],
	])("does not suppress %s network ConnectErrors after guard disposal", (_name, makeError) => {
		const suppression = installCursorSdkProcessErrorGuard();
		suppression.dispose();
		let listenerCalled = false;
		const listener = () => {
			listenerCalled = true;
		};
		process.once("uncaughtException", listener);
		try {
			const emitted = process.emit("uncaughtException", makeError(), "uncaughtException");
			expect(emitted).toBe(true);
			expect(listenerCalled).toBe(true);
		} finally {
			process.removeListener("uncaughtException", listener);
		}
	});
});
