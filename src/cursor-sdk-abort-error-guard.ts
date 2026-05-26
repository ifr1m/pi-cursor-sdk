import { asRecord } from "./cursor-record-utils.js";

interface CursorSdkAbortErrorSuppressionToken {
	suppress: boolean;
}

export interface CursorSdkAbortErrorSuppression {
	suppressAbortErrors(): void;
	dispose(): void;
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

type GenericProcessEmit = (event: string | symbol, ...args: unknown[]) => boolean;

// The local Cursor SDK can surface abort-time ConnectRPC cancellation as a process-level
// uncaught exception/unhandled rejection even when run.cancel() is awaited/caught.
const activeSuppressions = new Set<CursorSdkAbortErrorSuppressionToken>();
let originalProcessEmit: GenericProcessEmit | undefined;
let captureCallbackInstalled = false;

export function isCursorSdkAbortConnectError(error: unknown): boolean {
	const record = asRecord(error);
	const name = error instanceof Error ? error.name : getString(record, "name");
	const message = error instanceof Error ? error.message : getString(record, "message");
	const rawMessage = getString(record, "rawMessage") ?? message;
	const code = record?.code;
	const cause = asRecord(record?.cause);
	const causeName = getString(cause, "name");
	const stack = error instanceof Error ? error.stack ?? "" : getString(record, "stack") ?? "";

	return (
		name === "ConnectError" &&
		(code === 1 || code === "canceled") &&
		Boolean(rawMessage && /(?:operation was aborted|canceled)/i.test(rawMessage)) &&
		(causeName === "AbortError" || /AbortError/.test(stack)) &&
		stack.includes("@cursor/sdk") &&
		stack.includes("@connectrpc/connect-node")
	);
}

function hasActiveSuppression(): boolean {
	for (const suppression of activeSuppressions) {
		if (suppression.suppress) return true;
	}
	return false;
}

function shouldSuppressProcessError(event: string | symbol, args: readonly unknown[]): boolean {
	if (event !== "uncaughtException" && event !== "unhandledRejection") return false;
	return hasActiveSuppression() && isCursorSdkAbortConnectError(args[0]);
}

function installProcessEmitPatch(): void {
	if (originalProcessEmit) return;
	originalProcessEmit = process.emit.bind(process) as GenericProcessEmit;
	process.emit = function patchedCursorSdkAbortEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
		if (shouldSuppressProcessError(event, args)) return false;
		return originalProcessEmit!(event, ...args);
	} as typeof process.emit;
}

function installCaptureCallbackIfAvailable(): void {
	if (captureCallbackInstalled || process.hasUncaughtExceptionCaptureCallback()) return;
	process.setUncaughtExceptionCaptureCallback((error: Error) => {
		if (shouldSuppressProcessError("uncaughtException", [error])) return;
		uninstallCaptureCallbackIfIdle(true);
		if (originalProcessEmit?.("uncaughtException", error)) return;
		throw error;
	});
	captureCallbackInstalled = true;
}

function uninstallCaptureCallbackIfIdle(force = false): void {
	if (!captureCallbackInstalled) return;
	if (!force && activeSuppressions.size > 0) return;
	process.setUncaughtExceptionCaptureCallback(null);
	captureCallbackInstalled = false;
}

function uninstallProcessEmitPatchIfIdle(): void {
	if (activeSuppressions.size > 0 || !originalProcessEmit) return;
	uninstallCaptureCallbackIfIdle();
	process.emit = originalProcessEmit as typeof process.emit;
	originalProcessEmit = undefined;
}

export const __testUtils = {
	activeSuppressionCount: (): number => activeSuppressions.size,
};

export function installCursorSdkAbortErrorSuppression(): CursorSdkAbortErrorSuppression {
	installProcessEmitPatch();
	const token: CursorSdkAbortErrorSuppressionToken = { suppress: false };
	activeSuppressions.add(token);
	let disposed = false;
	return {
		suppressAbortErrors(): void {
			if (disposed) return;
			token.suppress = true;
			installCaptureCallbackIfAvailable();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			activeSuppressions.delete(token);
			uninstallProcessEmitPatchIfIdle();
		},
	};
}
