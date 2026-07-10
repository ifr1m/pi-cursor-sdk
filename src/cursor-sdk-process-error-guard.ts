import { classifyCursorConnectError, isCursorSdkAbortConnectError } from "./cursor-provider-errors.js";

interface CursorSdkProcessErrorGuardToken {
	suppressAbortErrors: boolean;
}

export interface CursorSdkProcessErrorGuard {
	suppressAbortErrors(): void;
	dispose(): void;
}

type GenericProcessEmit = (event: string | symbol, ...args: unknown[]) => boolean;

// The local Cursor SDK can surface some ConnectRPC failures as process-level
// uncaught exceptions/unhandled rejections even when run.wait()/run.cancel() is awaited.
// Keep suppression scoped to active Cursor provider turns and tightly matched ConnectRPC shapes.
const activeProviderTurns = new Set<CursorSdkProcessErrorGuardToken>();
let activeCompactionPrep = 0;
let originalProcessEmit: GenericProcessEmit | undefined;
let captureCallbackInstalled = false;

function hasActiveAbortSuppression(): boolean {
	if (activeCompactionPrep > 0) return true;
	for (const turn of activeProviderTurns) {
		if (turn.suppressAbortErrors) return true;
	}
	return false;
}

function isCursorProvenance(source: string): boolean {
	return source === "cursor-sdk-stack" || source === "cursor-extension-connect-stack" || source === "cursor-backend-details";
}

function shouldSuppressProcessError(event: string | symbol, args: readonly unknown[]): boolean {
	if (event !== "uncaughtException" && event !== "unhandledRejection") return false;
	const error = args[0];
	const classification = classifyCursorConnectError(error);
	if (!classification) return false;
	// Abort ConnectErrors (user cancel, compaction teardown, and mid-turn SDK stall
	// aborts) must not take down pi while a Cursor provider turn or compaction prep is active.
	if (classification.kind === "abort") {
		return activeProviderTurns.size > 0 || hasActiveAbortSuppression();
	}
	if (activeProviderTurns.size === 0) return false;
	// pi's supported Cursor SDK runtime is Node, where the SDK uses connect-node.
	if (classification.kind === "network") return isCursorProvenance(classification.source) || classification.source === "connect-node-stack";
	return isCursorProvenance(classification.source);
}

function installProcessEmitPatch(): void {
	if (originalProcessEmit) return;
	originalProcessEmit = process.emit.bind(process) as GenericProcessEmit;
	process.emit = function patchedCursorSdkProcessErrorEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
		if (shouldSuppressProcessError(event, args)) return true;
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
	if (!force && (activeProviderTurns.size > 0 || activeCompactionPrep > 0)) return;
	process.setUncaughtExceptionCaptureCallback(null);
	captureCallbackInstalled = false;
}

function uninstallProcessEmitPatchIfIdle(): void {
	if (activeProviderTurns.size > 0 || activeCompactionPrep > 0 || !originalProcessEmit) return;
	uninstallCaptureCallbackIfIdle();
	process.emit = originalProcessEmit as typeof process.emit;
	originalProcessEmit = undefined;
}

export const __testUtils = {
	activeProviderTurnCount: (): number => activeProviderTurns.size,
};

export { isCursorSdkAbortConnectError };

export async function runWithCursorSdkCompactionPrepGuard<T>(operation: () => Promise<T>): Promise<T> {
	activeCompactionPrep += 1;
	const guard = installCursorSdkProcessErrorGuard();
	guard.suppressAbortErrors();
	try {
		return await operation();
	} finally {
		guard.dispose();
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		activeCompactionPrep -= 1;
		uninstallProcessEmitPatchIfIdle();
	}
}

export function installCursorSdkProcessErrorGuard(): CursorSdkProcessErrorGuard {
	installProcessEmitPatch();
	installCaptureCallbackIfAvailable();
	const token: CursorSdkProcessErrorGuardToken = { suppressAbortErrors: false };
	activeProviderTurns.add(token);
	let disposed = false;
	return {
		suppressAbortErrors(): void {
			if (disposed) return;
			token.suppressAbortErrors = true;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			activeProviderTurns.delete(token);
			uninstallProcessEmitPatchIfIdle();
		},
	};
}
