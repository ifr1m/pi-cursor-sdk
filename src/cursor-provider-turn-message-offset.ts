import { countCursorAgentMessages } from "./cursor-agent-message-web-tools.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";

export async function getCursorAgentMessageOffset(
	agentId: string,
	cwd: string,
	sdkEventDebug: CursorSdkEventDebugSink | undefined,
): Promise<number | undefined> {
	try {
		return await countCursorAgentMessages(agentId, cwd);
	} catch (error) {
		sdkEventDebug?.recordError("cursor_agent_message_count", error);
		return undefined;
	}
}
