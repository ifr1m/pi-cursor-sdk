import type { RunResult } from "@cursor/sdk";
import { selectCursorFinalText } from "./cursor-provider-live-run-drain.js";
import {
	formatCursorSdkAbortMessage,
	formatCursorSdkRunFailureDetail,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
	type CursorSdkRunFailureSource,
} from "./cursor-provider-errors.js";
import { hasUsableText } from "./cursor-record-utils.js";
import {
	buildIncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcomeInput,
} from "./cursor-incomplete-tool-visibility.js";

/** Unified SDK wait() facts consumed by live and direct emission strategies. */
export interface CursorRunOutcome {
	waitResult: RunResult;
	signalAborted?: boolean;
	finalText: string;
	incompleteTools: IncompleteCursorToolRunOutcome;
	assistantTextProduced: boolean;
	abortMessage: string;
	errorMessage: string;
}

export interface ResolveCursorRunOutcomeParams {
	waitResult: RunResult;
	signalAborted?: boolean;
	textDeltas: readonly string[];
	emittedText: string;
	planTextCandidate?: string;
	selectFinalTextOptions?: { allowPartialPrefix?: boolean };
	runResultFallback?: string;
	resolvedApiKey?: string;
	optionsApiKey?: string;
}

function hasCursorAssistantText(
	resultText: unknown,
	textDeltas: readonly string[],
	fallbackText?: string,
): boolean {
	return (
		hasUsableText(typeof resultText === "string" ? resultText : undefined) ||
		hasUsableText(textDeltas.join("")) ||
		hasUsableText(fallbackText)
	);
}

export function isCursorRunFinishedSuccessfully(outcome: CursorRunOutcome): boolean {
	return outcome.waitResult.status === "finished" && !outcome.signalAborted;
}

export function resolveCursorRunOutcome(params: ResolveCursorRunOutcomeParams): CursorRunOutcome {
	const finishedSuccessfully = params.waitResult.status === "finished" && !params.signalAborted;
	const incompleteToolsInput: IncompleteCursorToolRunOutcomeInput = {
		status: params.waitResult.status,
		signalAborted: params.signalAborted,
		assistantTextProduced:
			finishedSuccessfully &&
			hasCursorAssistantText(params.waitResult.result, params.textDeltas, params.planTextCandidate),
	};
	const finalText = finishedSuccessfully
		? selectCursorFinalText(
				params.waitResult.result,
				params.textDeltas,
				params.emittedText,
				params.planTextCandidate,
				params.selectFinalTextOptions,
			)
		: "";
	const failureDetail = formatCursorSdkRunFailureDetail(
		params.waitResult as CursorSdkRunFailureSource,
		params.runResultFallback,
	);

	return {
		waitResult: params.waitResult,
		signalAborted: params.signalAborted,
		finalText,
		incompleteTools: buildIncompleteCursorToolRunOutcome(incompleteToolsInput),
		assistantTextProduced: incompleteToolsInput.assistantTextProduced ?? false,
		abortMessage: formatCursorSdkAbortMessage(
			resolveCursorSdkAbortCause({
				signalAborted: params.signalAborted,
				sdkStatusCancelled: params.waitResult.status === "cancelled",
			}),
		),
		errorMessage: sanitizeCursorProviderError(failureDetail, params.resolvedApiKey ?? params.optionsApiKey),
	};
}

export type CursorRunLiveEmission = "finished" | "cancelled" | "failed";

export function classifyCursorRunLiveEmission(outcome: CursorRunOutcome): CursorRunLiveEmission {
	if (isCursorRunFinishedSuccessfully(outcome)) return "finished";
	if (outcome.waitResult.status === "cancelled" || outcome.signalAborted) return "cancelled";
	return "failed";
}

export type CursorRunDirectEmission = "finished" | "cancelled" | "failed";

export function classifyCursorRunDirectEmission(outcome: CursorRunOutcome): CursorRunDirectEmission {
	if (outcome.waitResult.status === "cancelled") return "cancelled";
	if (outcome.waitResult.status === "error") return "failed";
	return "finished";
}
