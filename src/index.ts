import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverModels, type CursorModelFallbackIssue } from "./model-discovery.js";
import { registerCursorFastControls } from "./cursor-state.js";
import { streamCursor } from "./cursor-provider.js";

export default async function (pi: ExtensionAPI) {
	registerCursorFastControls(pi);
	let fallbackIssue: CursorModelFallbackIssue | undefined;
	const models = await discoverModels({
		onFallback: (issue) => {
			fallbackIssue = issue;
		},
	});

	if (fallbackIssue) {
		const issue = fallbackIssue;
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(issue.message, "warning");
		});
	}

	pi.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: "https://cursor.com",
		apiKey: "CURSOR_API_KEY",
		api: "cursor-sdk",
		models,
		streamSimple: streamCursor,
	});
}
