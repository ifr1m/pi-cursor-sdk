import { AsyncLocalStorage } from "node:async_hooks";

const cursorSdkOutputSuppression = new AsyncLocalStorage<boolean>();

export const CURSOR_SDK_STARTUP_NOISE_PATTERNS = [
	"[hooks]",
	"managed_skills.",
	"CursorPluginsAgentSkillsService load completed",
	"LocalCursorRulesService load completed",
	"AgentSkillsCursorRulesService load completed",
	"Error initializing ignore mapping for",
	"Ripgrep path not configured. Call configureRipgrepPath() at startup.",
] as const;

export function isCursorSdkOutputSuppressed(): boolean {
	return cursorSdkOutputSuppression.getStore() === true;
}

export function suppressCursorSdkOutput<T>(operation: () => Promise<T>): Promise<T> {
	return cursorSdkOutputSuppression.run(true, operation);
}

export function isCursorSdkStartupNoise(text: string): boolean {
	return CURSOR_SDK_STARTUP_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
}

function createFilteredProcessWrite<TWrite extends typeof process.stdout.write>(write: TWrite, stream: NodeJS.WriteStream): TWrite {
	return ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (isCursorSdkOutputSuppressed() || isCursorSdkStartupNoise(text)) {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}
		return write.call(stream, chunk as string, encodingOrCallback as BufferEncoding, callback);
	}) as TWrite;
}

function createFilteredConsoleMethod<TMethod extends typeof console.log>(method: TMethod): TMethod {
	return ((...args: Parameters<TMethod>): void => {
		const text = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
		if (isCursorSdkOutputSuppressed() || isCursorSdkStartupNoise(text)) return;
		method(...args);
	}) as TMethod;
}

export function installCursorSdkOutputFilter(): () => void {
	const stdoutWrite = process.stdout.write;
	const stderrWrite = process.stderr.write;
	const consoleLog = console.log;
	const consoleInfo = console.info;
	const consoleWarn = console.warn;
	const consoleError = console.error;
	const consoleDebug = console.debug;
	process.stdout.write = createFilteredProcessWrite(stdoutWrite, process.stdout);
	process.stderr.write = createFilteredProcessWrite(stderrWrite, process.stderr) as typeof process.stderr.write;
	console.log = createFilteredConsoleMethod(consoleLog);
	console.info = createFilteredConsoleMethod(consoleInfo);
	console.warn = createFilteredConsoleMethod(consoleWarn);
	console.error = createFilteredConsoleMethod(consoleError);
	console.debug = createFilteredConsoleMethod(consoleDebug);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		process.stdout.write = stdoutWrite;
		process.stderr.write = stderrWrite;
		console.log = consoleLog;
		console.info = consoleInfo;
		console.warn = consoleWarn;
		console.error = consoleError;
		console.debug = consoleDebug;
	};
}
