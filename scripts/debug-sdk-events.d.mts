export interface CursorDebugSdkEventsArgs {
	settingSources?: string;
	[key: string]: unknown;
}
export interface CursorSdkEventDebugSummary {
	counts: Record<string, Record<string, number>>;
	wait: { status: string; durationMs: number; hasResultText: boolean };
	conversation: { turnCount: number };
	files: { streamEvents: string };
	[key: string]: unknown;
}
export declare function parseDebugSdkEventsArgs(argv: string[], env?: NodeJS.ProcessEnv): CursorDebugSdkEventsArgs;
export declare function createTimingTracker(): unknown;
export interface CursorSdkEventJsonlSink {
	appendStream(event: unknown): void;
	appendDelta(update: unknown): void;
	appendStep(step: unknown): void;
	getSummaryState(): { counts: { stream: Record<string, number> } };
	close(): Promise<void>;
}
export declare function createEventJsonlSink(artifactDir: string, startedAt: number): CursorSdkEventJsonlSink;
export declare function buildSummary(input: Record<string, unknown>): CursorSdkEventDebugSummary;
