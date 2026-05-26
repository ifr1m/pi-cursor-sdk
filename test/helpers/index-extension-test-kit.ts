import { vi } from "vitest";
import {
	createExtensionRegistrationPi,
	type CursorExtensionRegistrationPi,
	type PiHarness,
	type PiHarnessOptions,
} from "./pi-harness.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../../src/cursor-native-tool-display.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../../src/cursor-pi-tool-bridge.js";
import { __testUtils as cursorSessionCwdTestUtils } from "../../src/cursor-session-cwd.js";

export {
	nativeToolDisplayTestUtils,
	cursorPiToolBridgeTestUtils,
	cursorSessionCwdTestUtils,
};

export function createExtensionPi(
	initialTools?: PiHarnessOptions["initialTools"],
): PiHarness & CursorExtensionRegistrationPi {
	return createExtensionRegistrationPi(initialTools ? { initialTools } : undefined);
}

export async function resetIndexExtensionTestState(): Promise<void> {
	vi.clearAllMocks();
	delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
	delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
	delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
	await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
	cursorSessionCwdTestUtils.reset();
	nativeToolDisplayTestUtils.reset();
}
