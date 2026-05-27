export interface CursorCliFlagSpec<TValue = string> {
	[key: string]: unknown;
	names: readonly string[];
	assign?: (value: string) => TValue;
}

export type CursorCliFlagSpecMap<TArgs extends Record<string, unknown>> = {
	[K in keyof TArgs]?: CursorCliFlagSpec<unknown>;
};

export type ParsedCursorCliArgs<TDefaults extends Record<string, unknown>> = TDefaults & { help: boolean };

export declare function readArgvValue(
	argv: readonly string[],
	index: number,
	flagName: string,
	fail: (message: string) => never,
): string;
export declare function parseArgv<TDefaults extends Record<string, unknown>>(
	argv: readonly string[],
	options: { defaults: TDefaults; flags: CursorCliFlagSpecMap<TDefaults>; fail: (message: string) => never },
): ParsedCursorCliArgs<TDefaults>;
export declare function defaultSettingSourcesFromEnv(env?: NodeJS.ProcessEnv): string[] | undefined;
export declare function defaultApiKeyFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
export declare function readArgvApiKey(argv: readonly string[]): string | undefined;
export declare function apiKeySecretsFromProcess(
	argv?: readonly string[],
	env?: NodeJS.ProcessEnv,
): Array<string | undefined>;
export declare function requireApiKey(
	args: { apiKey?: string },
	env: NodeJS.ProcessEnv,
	fail: (message: string) => never,
): string;
export declare function defaultTimestampedDir(prefix: string, baseDir?: string): string;
export declare const commonProbePathFlag: <TKey extends string>(key: TKey) => CursorCliFlagSpec<string>;
export declare const commonProbeStringFlag: <TKey extends string>(key: TKey) => CursorCliFlagSpec<string>;
export declare const commonProbeFlags: {
	readonly cwd: CursorCliFlagSpec<string>;
	readonly model: CursorCliFlagSpec<string>;
	readonly prompt: CursorCliFlagSpec<string>;
	readonly out: CursorCliFlagSpec<string>;
	readonly sessionDir: CursorCliFlagSpec<string>;
	readonly promptFile: CursorCliFlagSpec<string>;
	readonly apiKey: CursorCliFlagSpec<string>;
	readonly settingSources: CursorCliFlagSpec<string[] | undefined>;
};
