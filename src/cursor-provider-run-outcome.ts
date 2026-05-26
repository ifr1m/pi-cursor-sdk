import type { RunResult } from "@cursor/sdk";
import { selectCursorFinalText } from "./cursor-run-final-text.js";
import {
	formatCursorSdkAbortMessage,
	formatCursorSdkRunFailureDetail,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "./cursor-provider-errors.js";
import { hasUsableText } from "./cursor-record-utils.js";
import {
	buildIncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcomeInput,
} from "./cursor-incomplete-tool-visibility.js";

/** Unified SDK wait() facts consumed by live and direct emission strategies. */
export type CursorRunOutcome =
	| {
			kind: "finished";
			waitResult: RunResult;
			finalText: string;
			incompleteTools: IncompleteCursorToolRunOutcome;
			assistantTextProduced: boolean;
			signalAborted?: boolean;
	  }
	| {
			kind: "cancelled";
			waitResult: RunResult;
			incompleteTools: IncompleteCursorToolRunOutcome;
			abortMessage: string;
			signalAborted?: boolean;
	  }
	| {
			kind: "error";
			waitResult: RunResult;
			incompleteTools: IncompleteCursorToolRunOutcome;
			errorMessage: string;
			signalAborted?: boolean;
	  };

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
	return outcome.kind === "finished" && !outcome.signalAborted;
}

export function resolveCursorRunOutcome(params: ResolveCursorRunOutcomeParams): CursorRunOutcome {
	const { waitResult, signalAborted } = params;
	const finishedSuccessfully = waitResult.status === "finished" && !signalAborted;
	const incompleteToolsInput: IncompleteCursorToolRunOutcomeInput = {
		status: waitResult.status,
		signalAborted,
		assistantTextProduced:
			finishedSuccessfully &&
			hasCursorAssistantText(waitResult.result, params.textDeltas, params.planTextCandidate),
	};
	const incompleteTools = buildIncompleteCursorToolRunOutcome(incompleteToolsInput);

	if (waitResult.status === "error") {
		const failureDetail = formatCursorSdkRunFailureDetail(waitResult, params.runResultFallback);
		return {
			kind: "error",
			waitResult,
			incompleteTools,
			errorMessage: sanitizeCursorProviderError(failureDetail, params.resolvedApiKey ?? params.optionsApiKey),
			signalAborted,
		};
	}

	if (waitResult.status === "cancelled") {
		return {
			kind: "cancelled",
			waitResult,
			incompleteTools,
			abortMessage: formatCursorSdkAbortMessage(
				resolveCursorSdkAbortCause({
					signalAborted,
					sdkStatusCancelled: true,
				}),
			),
			signalAborted,
		};
	}

	const finalText = finishedSuccessfully
		? selectCursorFinalText(
				waitResult.result,
				params.textDeltas,
				params.emittedText,
				params.planTextCandidate,
				params.selectFinalTextOptions,
			)
		: "";

	return {
		kind: "finished",
		waitResult,
		finalText,
		incompleteTools,
		assistantTextProduced: incompleteToolsInput.assistantTextProduced ?? false,
		signalAborted,
	};
}

export type CursorRunLiveEmission = "finished" | "cancelled" | "failed";

function cursorRunOutcomeSignalAborted(outcome: CursorRunOutcome): boolean | undefined {
	return outcome.signalAborted;
}

export function classifyCursorRunLiveEmission(outcome: CursorRunOutcome): CursorRunLiveEmission {
	if (isCursorRunFinishedSuccessfully(outcome)) return "finished";
	if (outcome.kind === "cancelled" || cursorRunOutcomeSignalAborted(outcome)) return "cancelled";
	return "failed";
}

export type CursorRunDirectEmission = "finished" | "cancelled" | "failed";

export function classifyCursorRunDirectEmission(outcome: CursorRunOutcome): CursorRunDirectEmission {
	if (outcome.kind === "cancelled") return "cancelled";
	if (outcome.kind === "error") return "failed";
	return "finished";
}

export function getCursorRunAbortMessage(outcome: CursorRunOutcome): string {
	if (outcome.kind === "cancelled") return outcome.abortMessage;
	return formatCursorSdkAbortMessage(
		resolveCursorSdkAbortCause({
			signalAborted: cursorRunOutcomeSignalAborted(outcome),
			sdkStatusCancelled: outcome.waitResult.status === "cancelled",
		}),
	);
}
