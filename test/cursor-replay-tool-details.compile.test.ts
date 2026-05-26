import type { CursorReplayTitledActivityDetails } from "../src/cursor-replay-tool-details.js";

// Compile-time regression: structured tool names must not satisfy titled-activity details.
const _rejectEditOnTitledActivity: CursorReplayTitledActivityDetails = {
	variant: "titledActivity",
	// @ts-expect-error edit uses the dedicated edit variant
	cursorToolName: "edit",
	title: "Cursor edit",
};

const _rejectWriteOnTitledActivity: CursorReplayTitledActivityDetails = {
	variant: "titledActivity",
	// @ts-expect-error write uses the dedicated write variant
	cursorToolName: "write",
	title: "Cursor write",
};

const _rejectGenerateImageOnTitledActivity: CursorReplayTitledActivityDetails = {
	variant: "titledActivity",
	// @ts-expect-error generateImage uses the dedicated generateImage variant
	cursorToolName: "generateImage",
	title: "Cursor image generation",
};

void _rejectEditOnTitledActivity;
void _rejectWriteOnTitledActivity;
void _rejectGenerateImageOnTitledActivity;
