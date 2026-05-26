import { describe, expect, it } from "vitest";
import type {
	CursorDebugCaptureSummary,
	CursorDebugProviderEventsArgs,
	CursorDebugProviderEventsRunSummary,
} from "../scripts/debug-provider-events.d.mts";
import type { CursorDebugSdkEventsArgs } from "../scripts/debug-sdk-events.d.mts";
import { parseDebugProviderEventsArgs } from "../scripts/debug-provider-events.mjs";
import { parseDebugSdkEventsArgs } from "../scripts/debug-sdk-events.mjs";
import { defaultSettingSourcesFromEnv } from "../scripts/lib/cursor-cli-args.mjs";
import { waitForChildClose } from "../scripts/lib/cursor-child-process.mjs";

describe("maintainer script declaration contracts", () => {
	it("keeps compile-time negative fixtures for stale declaration shapes", () => {
		expect(true).toBe(true);
	});
});

type AssertEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never;

const _settingSourcesReturn: AssertEqual<ReturnType<typeof defaultSettingSourcesFromEnv>, string[] | undefined> = true;
const _waitForChildCloseReturn: AssertEqual<Awaited<ReturnType<typeof waitForChildClose>>, number> = true;

const _providerArgsHelp: boolean = parseDebugProviderEventsArgs(["--prompt", "hello"], { CURSOR_API_KEY: "key" }).help;
const _sdkArgsHelp: boolean = parseDebugSdkEventsArgs(["--prompt", "hello"], { CURSOR_API_KEY: "key" }).help;

const _validProviderArgs = {
	cwd: "/tmp/work",
	model: "cursor/composer-2.5",
	help: false,
} satisfies CursorDebugProviderEventsArgs;

const _validSdkArgs = {
	cwd: "/tmp/work",
	model: "composer-2.5",
	includeConversation: false,
	help: false,
} satisfies CursorDebugSdkEventsArgs;

const _validCaptureSummary = {
	artifactDir: "/tmp/out",
	counts: { errors: 0 },
	piSessionSnapshot: { copied: false },
} satisfies CursorDebugCaptureSummary;

const _validRunSummary = {
	artifactDir: "/tmp/out",
	artifacts: { summary: "/tmp/out/summary.json" },
	counts: { errors: 0 },
	elapsedMs: 100,
	model: "cursor/composer-2.5",
	cwd: "/repo",
	sessionDir: "/tmp/out/session",
	extensionVersion: "0.1.20",
	sdkVersion: "1.0.0",
	waitResultRecorded: true,
} satisfies CursorDebugProviderEventsRunSummary;

const _invalidProviderArgs = {
	cwd: "/tmp/work",
	model: "cursor/composer-2.5",
	// @ts-expect-error parsed probe args always include help
} satisfies CursorDebugProviderEventsArgs;

const _invalidSdkArgs = {
	cwd: "/tmp/work",
	model: "composer-2.5",
	includeConversation: false,
	// @ts-expect-error parsed probe args always include help
} satisfies CursorDebugSdkEventsArgs;

const _invalidProviderSettingSources = {
	cwd: "/tmp/work",
	model: "cursor/composer-2.5",
	help: false,
	// @ts-expect-error settingSources is parsed as string[] | undefined
	settingSources: "all",
} satisfies CursorDebugProviderEventsArgs;

const _invalidRunSummary = {
	artifactDir: "/tmp/out",
	artifacts: { summary: "/tmp/out/summary.json" },
	counts: { errors: 0 },
	elapsedMs: 100,
	model: "cursor/composer-2.5",
	cwd: "/repo",
	sessionDir: "/tmp/out/session",
	extensionVersion: "0.1.20",
	sdkVersion: "1.0.0",
	// @ts-expect-error run summary is projected, not the raw capture summary
	piSessionSnapshot: { copied: false },
} satisfies CursorDebugProviderEventsRunSummary;

void [
	_settingSourcesReturn,
	_waitForChildCloseReturn,
	_providerArgsHelp,
	_sdkArgsHelp,
	_validProviderArgs,
	_validSdkArgs,
	_validCaptureSummary,
	_validRunSummary,
	_invalidProviderArgs,
	_invalidSdkArgs,
	_invalidProviderSettingSources,
	_invalidRunSummary,
];
