export declare function readArgvValue(
	argv: string[],
	index: number,
	flagName: string,
	fail: (message: string) => never,
): string;
export declare function parseArgv(
	argv: string[],
	options: { defaults: Record<string, unknown>; flags: Record<string, unknown>; fail: (message: string) => never },
): Record<string, unknown>;
export declare function defaultSettingSourcesFromEnv(env?: NodeJS.ProcessEnv): string[] | undefined;
export declare function defaultApiKeyFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
export declare function requireApiKey(
	args: { apiKey?: string },
	env: NodeJS.ProcessEnv,
	fail: (message: string) => never,
): string;
export declare function defaultTimestampedDir(prefix: string, baseDir?: string): string;
export declare const commonProbePathFlag: (key: string) => Record<string, unknown>;
export declare const commonProbeStringFlag: (key: string) => Record<string, unknown>;
export declare const commonProbeFlags: Record<string, unknown>;
