import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";

export type CursorAgentsContextExtensionApi = CursorModelLifecycleExtensionApi;

export function registerCursorAgentsContextDedup(pi: CursorAgentsContextExtensionApi): void {
	registerCursorModelLifecycle(pi, {
		beforeAgentStart: async (event, ctx) => {
			const { resolveCursorFacingSystemPrompt } = await import("./cursor-agents-context.js");
			const resolved = resolveCursorFacingSystemPrompt(
				event.systemPrompt,
				ctx.model,
				event.systemPromptOptions,
			);
			if (resolved === event.systemPrompt) return undefined;
			return { systemPrompt: resolved };
		},
	});
}
