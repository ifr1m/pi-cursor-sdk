import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { getCursorAgentMessageOffset } from "./cursor-provider-turn-finalize.js";
import type { installCursorSdkAbortErrorSuppression } from "./cursor-sdk-abort-error-guard.js";
import type {
	CursorProviderTurnPrepared,
	CursorProviderTurnRunnerParams,
	CursorProviderTurnRuntime,
	CursorProviderTurnSend,
} from "./cursor-provider-turn-types.js";

export interface SendCursorProviderTurnParams {
	params: CursorProviderTurnRunnerParams;
	runtime: CursorProviderTurnRuntime;
	prepared: CursorProviderTurnPrepared;
	sdkAbortErrorSuppression: ReturnType<typeof installCursorSdkAbortErrorSuppression>;
	throwIfAborted: () => void;
}

export async function sendCursorProviderTurn(sendParams: SendCursorProviderTurnParams): Promise<CursorProviderTurnSend> {
	const { params, runtime, prepared, sdkAbortErrorSuppression, throwIfAborted } = sendParams;
	const { options } = params;
	const { agent, turnCoordinator, sendPlan, bootstrap, liveRun, prompt, sendPayload, cwd } = prepared;
	const { sdkEventDebug } = runtime;

	runtime.sdkRun = null;
	runtime.abortListener = () => {
		sdkAbortErrorSuppression.suppressAbortErrors();
		runtime.activeLiveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
		if (runtime.sdkRun) {
			runtime.sdkRun.cancel().catch(() => {});
		}
	};
	runtime.abortSignal = options?.signal;
	runtime.abortSignal?.addEventListener("abort", runtime.abortListener, { once: true });

	throwIfAborted();
	const cursorAgentMessageOffset = await getCursorAgentMessageOffset(agent.agentId, cwd, sdkEventDebug);
	throwIfAborted();
	sdkEventDebug?.recordSendMeta({
		mode: sendPlan.mode,
		reason: sendPlan.reason,
		resetAgent: sendPlan.resetAgent,
		bootstrap,
		promptText: prompt.text,
		imageCount: prompt.images.length,
		useNativeToolReplay: prepared.useNativeToolReplay,
		bridgeEnabled: prepared.bridgeRun !== undefined,
		nativeReplayId: prepared.nativeReplayId,
		promptInputTokens: prepared.promptInputTokens,
	});
	sdkEventDebug?.recordSendPayload(sendPayload);
	sdkEventDebug?.recordProviderEvent("agent_send_start", sendPayload);
	const run = await agent.send(sendPayload, {
		onDelta: (args) => {
			sdkEventDebug?.recordOnDelta(args.update);
			turnCoordinator.handleDelta(args.update);
		},
		onStep: (args) => {
			sdkEventDebug?.recordOnStep(args.step);
			turnCoordinator.handleStep(args.step);
		},
	});
	runtime.sdkRun = run;
	sdkEventDebug?.recordRunMeta({
		runId: run.id,
		agentId: run.agentId,
		status: run.status,
	});
	sdkEventDebug?.attachRunStream(run);
	sdkEventDebug?.recordProviderEvent("agent_send_returned", {
		runId: run.id,
		agentId: run.agentId,
		status: run.status,
	});
	if (liveRun) cursorLiveRuns.attachSdkRun(liveRun, run);
	if (options?.signal?.aborted) {
		sdkAbortErrorSuppression.suppressAbortErrors();
		liveRun?.bridgeRun?.cancel("Cursor SDK run aborted");
		await run.cancel().catch(() => {});
		throw new CursorLiveRunAbortError();
	}

	return { run, prepared, cursorAgentMessageOffset };
}
