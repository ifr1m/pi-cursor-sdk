export interface CursorDebugProviderEventsArgs {
	settingSources?: string[];
	prompt?: string;
	apiKey?: string;
	[key: string]: unknown;
}
export declare function parseDebugProviderEventsArgs(
	argv: string[],
	env?: NodeJS.ProcessEnv,
): CursorDebugProviderEventsArgs;
export interface CursorPiSessionSnapshotState {
	copied: boolean;
	sessionFile?: string;
	reason?: string;
	recoveredAfterChildExit?: boolean;
	[key: string]: unknown;
}
export interface CursorDebugCaptureSummary {
	artifactDir: string;
	sessionFile?: string;
	counts: Record<string, number>;
	piSessionSnapshot: CursorPiSessionSnapshotState;
	[key: string]: unknown;
}
export declare function backfillPiSessionSnapshot(
	captureSummary: CursorDebugCaptureSummary,
	artifactDir: string,
	sessionDir: string,
): CursorDebugCaptureSummary;
export declare function runDebugProviderEvents(args: unknown): Promise<void>;
