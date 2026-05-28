# Investigation: Cursor SDK `/session` Token Tracking

> **Point-in-time record:** This investigation was captured on 2026-05-21 (MDT) against pi dev baseline `@earendil-works/*` **0.75.3**. The repo dev baseline is now **0.76.0**; package-version references below describe the environment at investigation time unless noted otherwise.

## Summary

The supplied session's persisted assistant `usage` fields sum exactly to `/session` totals: 3,086 input, 319 output, 3,405 total. The problem is not JSONL loss or `/session` math; it is an accounting-contract gap in `pi-cursor-sdk`: split Cursor SDK live runs persist narrow text/prompt estimates, leaving tool-call/thinking/tool-result-heavy turns undercounted and often all-zero.

Implementation follow-up completed in this working tree: raw Cursor SDK `turn-ended.usage` remains diagnostic-only, while the provider now uses dual estimates: `usage.input/output` as approximate session activity, and `usage.totalTokens` as the context-safe replayable Cursor prompt estimate derived from `buildCursorPrompt()`. The final implementation isolates the policy in `src/cursor-usage-accounting.ts` and consumes matching split-run tool results through `src/cursor-live-run-accounting.ts` so usage input and bridge MCP result resolution share one deduped boundary.

## Symptoms

- Supplied session file: `<local pi session JSONL>`.
- Session ID: `<redacted session id>`.
- `/session` reported: User 1, Assistant 41, Tool Calls 40, Tool Results 40, Total 82.
- `/session` reported tokens: Input 3,086; Output 319; Total 3,405.
- Local inspection found 87 JSONL records, including 84 `message` records plus session/model/thinking metadata.
- Many assistant records in the session JSONL contain Cursor provider usage fields with `input: 0`, `output: 0`, `cacheRead: 0`, `cacheWrite: 0`, and `totalTokens: 0`, despite containing thinking text and tool calls.
- Timestamp note: file timestamp is `2026-05-22T00:20:18Z`, which is the evening of May 21, 2026 in MDT; local `date` returned Thu May 21, 2026.

## Background / Prior Research

### Phase 1.5 - Git archaeology: token/usage/session history

Read-only explore probe `8404A398-D7C6-4B90-8678-34D2D261E196` found that current undercount behavior likely follows from intentional Cursor-provider accounting changes:

- Commit `82a2eca` (2026-05-09, “Add Cursor login auth support”) changed usage from copying Cursor SDK cumulative usage to approximate pi-side prompt/output usage. Current references reported by the probe: `src/cursor-provider.ts:266-285`, `src/cursor-provider.ts:1198-1201`, `test/cursor-provider.test.ts:2758-2795`, `CHANGELOG.md:125-126`.
- Commit `0264388` (2026-05-10, “Fix Cursor native replay continuation”) added `promptInputTokensReported`, making live native replay count prompt input once. Current references: `src/cursor-provider.ts:636-640`, `test/cursor-provider.test.ts:2505-2507`.
- Commit `7c8f44b` (2026-05-15, “Budget Cursor prompts before send”) added related prompt budgeting. Current references: `src/cursor-provider.ts:274-277`, `src/cursor-provider.ts:879-884`, `CHANGELOG.md:73-74`.
- Commit `0a8908d` (2026-05-21, “Add Cursor local pi tool bridge”) extended the same live-run accounting to bridge tool turns. Current references: `src/cursor-provider.ts:673-693`, `src/cursor-provider.ts:896-902`, `README.md:246-250`.
- Commit `b58c545` (2026-05-21, “Clarify Cursor bridge contract and diagnostics”) documented the current accounting contract in `docs/cursor-model-ux-spec.md:91`: Cursor SDK usage is cumulative internal work; the extension reports approximate prompt/output usage; split runs count prompt once, later turns report `input: 0`.

Preliminary conclusion from git history: `/session` may be undercounting relative to user expectation because the provider intentionally persists approximate replayable pi usage, not total Cursor internal tokens or visible thinking/tool transcript text, and split Cursor runs produce many zero-usage turns.

## Investigator Findings

<!-- Pair investigator appends structured analysis here. -->

### Phase 2 - Supplied JSONL, pi `/session`, and correct accounting contract

**Date checked:** Thu May 21 18:32 MDT 2026 (`date`). The session filename timestamp `2026-05-22T00:20:18Z` is the same evening in MDT.

#### Commands / probes run

- `date` from repo root to confirm local date/time.
- Explore A: read-only probe for installed pi `/session` aggregation in `node_modules/@earendil-works/pi-*`.
- Explore B: read-only structural JSONL scan of the supplied session file. It emitted aggregate counts only; no message content or secrets were printed.
- Explore C: read-only probe for docs/tests locking current approximate-usage behavior. It also ran focused Vitest cases for the two relevant tests.
- Local spot checks with `nl -ba` against `src/cursor-provider.ts`, `src/context.ts`, installed pi package files, and `test/cursor-provider.test.ts`.
- Local Node structural estimator over the JSONL. It emitted lengths/token estimates only, not raw session content.
- Oracle plan pass for recommended accounting semantics and fix options, using only the evidence above.

#### Finding 1: The supplied JSONL usage sums exactly to the reported `/session` totals

The supplied JSONL has 87 records and no parse errors:

- Top-level records: `message: 84`, `session: 1`, `model_change: 1`, `thinking_level_change: 1`.
- Message roles: `assistant: 42`, `toolResult: 40`, `user: 2`.
- Assistant stop reasons: `toolUse: 40`, `stop: 1`, `aborted: 1`.
- Messages with `usage`: 42, all assistant messages.
- Messages without `usage`: 42, the 40 tool results and 2 user messages.

Summing persisted `message.usage` across assistant messages yields exactly:

- `input: 3,086`
- `output: 319`
- `cacheRead: 0`
- `cacheWrite: 0`
- `totalTokens: 3,405`

That exactly matches the reported `/session` token totals: input 3,086; output 319; total 3,405.

Zero-usage assistant turns explain the surprising display:

- 37 assistant messages have all numeric usage fields at 0.
- All 37 are assistant messages.
- Their content shapes are: `toolCall` only: 28, `thinking + toolCall`: 8, empty content: 1.
- The zero-usage assistant records still contain an estimated 141 thinking tokens and 720 tool-call tokens by chars/4; those are user-visible transcript artifacts but are not included in `message.usage.output` today.

The structural estimator also showed why the number feels too low:

- Assistant visible text estimate: 316 tokens, close to persisted output 319.
- Assistant thinking estimate: 270 tokens, not counted in persisted output.
- Assistant tool-call estimate: 828 tokens, not counted in persisted output.
- Tool-result text estimate: 4,753 tokens, not counted in persisted usage because `toolResult` messages have no `usage` field.
- One tool-result image estimate: 1,200 tokens, also not counted in persisted usage.
- Full visible transcript estimate by this rough method: 9,027 tokens.

Conclusion: `/session` is not losing persisted usage. It is faithfully reporting a narrow provider estimate: prompt input once plus assistant text output only.

#### Finding 2: Current provider code creates zero-usage split turns by design

Relevant code paths in `src/cursor-provider.ts`:

- `setApproximateUsage()` sets only `input`, text-only `output`, cache zeros, and `totalTokens = input + output` (`src/cursor-provider.ts:279-284`).
- `takeCursorNativePromptInputTokens()` counts a live Cursor SDK run's prompt input once, then returns 0 on later replay turns (`src/cursor-provider.ts:636-640`).
- Native replay tool-use turns append `toolCall` blocks, then call `setApproximateUsage(partial, takeCursorNativePromptInputTokens(run), outputText)` (`src/cursor-provider.ts:643-670`). If there was no text before the tool call and the prompt was already reported, the turn persists as usage 0.
- Bridge tool-use turns do the same (`src/cursor-provider.ts:673-695`).
- Final live replay turns also use `takeCursorNativePromptInputTokens(run)` (`src/cursor-provider.ts:770-779`), so the final answer commonly has `input: 0`.
- Non-live runs call `setApproximateUsage(partial, promptInputTokens, finalText)` once (`src/cursor-provider.ts:1298-1306`).
- The provider explicitly ignores Cursor SDK `turn-ended.usage` because it reports cumulative internal agent/tool/cache work, not replayable pi prompt context (`src/cursor-provider.ts:1198-1201`).

At investigation time, tests and docs locked this pre-fix behavior; the implementation follow-up above supersedes the later-turn zero-input expectation:

- `test/cursor-provider.test.ts:2758-2795`, test name `uses pi prompt/output estimates instead of Cursor cumulative internal usage`, injected huge `turn-ended.usage` values (`inputTokens: 6746960`, `outputTokens: 17701`, `cacheReadTokens: 6559232`) and asserted pi usage remained small and cache fields stayed zero.
- `test/cursor-provider.test.ts:2408-2510`, test name `does not duplicate final result after an earlier post-tool text turn`, asserted the split live run called `runWait` once, the first assistant turn counted prompt input, and later split turns did not count newly consumed tool results as input.
- `docs/cursor-model-ux-spec.md:32` states Cursor SDK usage is cumulative internal work, the extension reports approximate prompt/output usage, and split replay turns count prompt input once.
- `README.md:246-250` documents live Cursor run state spanning tool-use turns and approximate pi token usage.
- `CHANGELOG.md:126` records that raw Cursor cumulative usage was stopped to prevent false context-overflow and compaction triggers.

Conclusion: the supplied session is consistent with current code, docs, and tests. That does not mean the current contract is good enough.

#### Finding 3: Installed pi `/session` does not compute independent token estimates

At investigation time, installed package versions from `package.json` / `node_modules` were `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` at **0.75.3**.

`/session` is implemented in `@earendil-works/pi-coding-agent`, not in `pi-agent-core`:

- Command dispatch: `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2000-2003`.
- Renderer: `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:4289-4320`.
- It calls `this.session.getSessionStats()` and prints `stats.tokens.input`, `stats.tokens.output`, optional cache fields, and `stats.tokens.total` (`interactive-mode.js:4289-4313`).

`AgentSession.getSessionStats()`:

- Uses current `this.agent.state.messages`, not all JSONL entries (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2351-2363`).
- Counts tool calls by assistant content blocks with `type === "toolCall"` (`agent-session.js:2363-2366`).
- Sums only assistant `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite`, and `usage.cost.total` (`agent-session.js:2366-2370`).
- Returns `tokens.total` as `input + output + cacheRead + cacheWrite`, not as the sum of `usage.totalTokens` (`agent-session.js:2381-2387`).

Important nuance: in this supplied un-compacted branch, current `state.messages` and persisted branch message entries appear to align, so `/session` matches the JSONL usage sum exactly. After compaction or tree navigation, `/session` can differ from “all persisted entries” because `state.messages` is rebuilt from `sessionManager.buildSessionContext()` (`agent-session.js:1315-1316`, `1560-1561`, `2302-2303`; `session-manager.js:166-205`). The footer has different scope: it sums assistant usage from all persisted session entries (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js:61-76`).

Conclusion: `/session` currently reports only whatever providers persisted into assistant `usage` for messages in current context. It does not count visible transcript content, tool results, Cursor SDK internals, or billable usage independently.

#### Finding 4: The real design bug is overloaded usage semantics

`AssistantMessage.usage` is doing at least three jobs:

1. `/session` and footer token activity display.
2. Context display / compaction safety.
3. Provider/model usage approximation.

Those jobs conflict for Cursor SDK live runs because one Cursor SDK `Agent.send()` is split into many pi assistant/tool turns.

Evidence from pi core:

- `Usage` has component fields plus `totalTokens` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:169-181`).
- `AssistantMessage` requires `usage` (`pi-ai/dist/types.d.ts:189-199`), while `ToolResultMessage` has no `usage` field (`pi-ai/dist/types.d.ts:203-205`).
- Compaction/context uses `calculateContextTokens(usage)`, which prefers `usage.totalTokens` when set (`node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:74-80`).
- `estimateContextTokens()` uses the last assistant usage plus estimated trailing message tokens (`compaction.js:120-145`).
- The context estimator includes assistant text, assistant thinking, assistant tool calls, tool-result text/images, and summaries when it falls back to message estimates (`compaction.js:161-220`).
- Threshold compaction for a successful assistant message uses `calculateContextTokens(assistantMessage.usage)` directly (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1430-1451`).
- `getContextUsage()` uses `estimateContextTokens(this.messages)` after compaction safety checks (`agent-session.js:2392-2431`).

Evidence from this provider:

- `buildCursorPrompt()` includes assistant text and tool-call args (`src/context.ts:92-102`) and tool-result text (`src/context.ts:104-107`), but explicitly omits thinking (`src/context.ts:100`). It then budgets and returns the actual Cursor prompt text plus latest images (`src/context.ts:190-218`).
- Therefore the proper context/compaction estimate for Cursor runs should follow `buildCursorPrompt()` content, not raw visible transcript content and not raw Cursor SDK internals.

Current split-run behavior is safe against the old false-compaction bug because it does not copy huge Cursor SDK cumulative usage. But it is insufficient in the other direction: after a split live run, the last assistant message may have `input: 0` and `totalTokens` equal only that turn's text output. Since compaction prefers the latest assistant `usage.totalTokens`, context display and threshold compaction can undercount after tool-heavy split runs.

Conclusion: this is not just a `/session` presentation issue. The provider should separate **session activity estimates** from **context-safe prompt estimates** as much as the current `Usage` shape allows.

#### What “proper” token tracking should mean for Cursor SDK-backed `/session`

There is no single honest number that simultaneously means pi context, visible transcript, Cursor internal work, and billable usage.

Recommended semantics:

1. **Pi context / replayable prompt estimate**: approximate tokens that pi would put into the next Cursor prompt. This should be based on `buildCursorPrompt()` and image reserves. It should include assistant text, tool-call args, and tool results because those are replayed into Cursor prompt text, and should exclude thinking because `buildCursorPrompt()` omits it. This is the metric that should drive context display and compaction.
2. **Pi-visible session activity estimate**: rough user-facing accounting for visible assistant/tool activity. This can include assistant text, thinking, and tool-call args, plus optionally tool-result text/images as a separate “transcript/tool result estimate.” It should be labeled approximate.
3. **Cursor SDK internal usage**: raw or delta’d `turn-ended.usage` counters from Cursor. This may include internal agent/tool/cache work and can be cumulative. It is useful as diagnostics only unless Cursor documents a stable per-run billable-delta contract.
4. **Billable usage/cost**: not currently provable from this provider. Do not label Cursor SDK counters as billable without a Cursor SDK contract that says they are billable and non-cumulative per request.

For `/session`, the best UX is dual or multi-metric display:

- “Approx pi usage” or “Provider estimate”: summed `usage.input/output/cache*`.
- “Current context estimate”: `getContextUsage()` / context-safe `usage.totalTokens` path.
- “Visible transcript estimate”: approximate chars/4 estimate across user, assistant text/thinking/tool-call cards, and tool results.
- “Cursor internal usage”: diagnostic section only, clearly not billable.

If only the current `Usage` fields are available, prefer preserving `input/output` as session-activity components and use `totalTokens` for context-safe estimates because pi compaction already treats `totalTokens` as authoritative while `/session` ignores it.

#### Can Cursor SDK `turn-ended.usage` be normalized or delta’d safely?

Not safely for primary `message.usage` or compaction today.

Why not:

- The provider comment and tests reflect observed huge cumulative values (`src/cursor-provider.ts:1198-1201`; `test/cursor-provider.test.ts:2762-2768`).
- The counters can include internal agent, tool, and cache work that does not map to pi messages.
- Live run continuation splits one SDK run over many pi assistant/tool turns; attribution to individual pi turns is ambiguous.
- A first observed `turn-ended.usage` may already include prior checkpoint/cache/internal work. Treating that as pi prompt size reintroduces the old false context-overflow/compaction behavior described in `CHANGELOG.md:126`.

Safe limited use:

- Capture raw Cursor SDK usage in assistant diagnostics, not in `message.usage`, if useful.
- If Cursor SDK deltas are ever exposed, compute nonnegative deltas per `CursorLiveRun` only when counters are monotonic and previous counters are known.
- Discard or reset delta tracking when counters decrease, fields are missing, the SDK run changes, or a continuation boundary is ambiguous.
- Never feed raw or delta’d Cursor SDK usage into `usage.totalTokens`, context display, or compaction until Cursor documents a stable non-cumulative/billable contract.

#### Should `message.usage` include thinking, tool calls, and tool results?

Recommended split under the current pi schema:

- **Assistant text**: yes, include in `usage.output`.
- **Assistant thinking**: do not include in context totals because `buildCursorPrompt()` omits thinking (`src/context.ts:100`). It may be included in a separate visible transcript/session-output estimate if `/session` is changed to show that explicitly.
- **Assistant tool-call args**: include in context-safe estimates because `buildCursorPrompt()` includes tool calls (`src/context.ts:97-99`). For `/session` output, include only if the UX explicitly defines output as “assistant visible/generated content,” not strictly final text.
- **Tool results**: do not stuff into assistant `usage.output`. Tool results are separate messages with no `usage` field (`pi-ai/dist/types.d.ts:203-205`) and are not model output. For context-safe estimates they must be counted because `buildCursorPrompt()` includes tool results (`src/context.ts:104-107`). For `/session`, show as a separate transcript/tool-result estimate or count newly consumed tool results as `input` on the following assistant replay turn with strict `toolCallId` dedupe.

#### Implementation options

| Option | Summary | Pros | Risks / why not enough |
| --- | --- | --- | --- |
| A. Keep current behavior | Continue counting prompt once and text output only. | Matches current docs/tests; avoids raw SDK false compaction. | `/session` remains misleading for tool-heavy Cursor runs; context/compaction can undercount after split live runs. |
| B. Copy Cursor SDK `turn-ended.usage` | Use SDK counters as pi usage. | Big numbers look closer to “Cursor did work.” | Reintroduces known false context-overflow/compaction bug; not pi-context, not per-turn, not proven billable. Reject. |
| C. Delta Cursor SDK `turn-ended.usage` | Track per-run monotonic deltas and persist them. | Better diagnostic than raw cumulative counters. | Still internal/cache/tool work; ambiguous across split pi turns; unsafe for compaction. Use diagnostics only. |
| D. Improve extension pi estimates in existing `Usage` | Keep `input/output` as approximate session activity; set `usage.totalTokens` to context-safe `buildCursorPrompt()` estimate for context/compaction; count tool-call args/thinking in session output and tool results as deduped input. | Fixes immediate `/session` undercount and context undercount without raw SDK counters. Can be tested in this repo. | `usage.totalTokens` may differ from `input + output`; docs/tests must define this provider-specific contract. Recommended near-term. |
| E. Pi core schema/UI split | Add explicit provider usage, context estimate, visible transcript estimate, and internal diagnostics in pi core `/session`. | Correct long-term contract; avoids overloading `AssistantMessage.usage`. | Requires upstream pi changes outside this extension. Recommended long-term. |

#### Implemented extension fix path

Near-term extension changes, all in this repo:

1. **Split usage estimation into `src/cursor-usage-accounting.ts`.** Replace provider-local usage math with a focused helper that writes:
   - `usage.input`: incremental session input estimate for this assistant record.
   - `usage.output`: incremental session output estimate for this assistant record.
   - `usage.cacheRead/cacheWrite`: 0 unless a safe Cursor contract appears.
   - `usage.totalTokens`: context-safe estimate for the replayable pi prompt/context, allowed to differ from `input + output`.
2. **Export or add a context-token estimator in `src/context.ts`.** Reuse `buildCursorPrompt()` so context estimates follow the actual Cursor prompt formatting and thinking omission (`src/context.ts:92-107`, `190-218`). Do not duplicate formatting rules.
3. **Thread context into live replay usage setting.** `replayPendingCursorLiveRun()` and `emitCursorNativeRunNextTurn()` should be able to compute context tokens from current `context.messages + partial` before finalizing a split assistant record. Current replay path has the context at `replayPendingCursorLiveRun()` (`src/cursor-provider.ts:782-797`) but `emitCursorNativeRunNextTurn()` only receives `partial` and `run` (`src/cursor-provider.ts:723-780`).
4. **Count assistant output more honestly.** For `/session` session-output estimate, include text and tool-call args at minimum. Consider thinking only if docs say `/session output` includes visible assistant trace, not only model final text. Keep thinking out of `usage.totalTokens` because Cursor prompt omits it.
5. **Count consumed tool results as input with dedupe.** Keep live-run accounting state in `src/cursor-live-run-accounting.ts`. When replaying a pending run, consume newly observed matching `toolResult` messages by `toolCallId`, add them to the following assistant turn's `usage.input`, and pass the same consumed results to bridge MCP result resolution; never double-count across replay calls.
6. **Keep Cursor SDK usage diagnostic-only.** If needed, add a `diagnostics` entry for raw and guarded delta Cursor SDK usage. The type supports arbitrary diagnostic details (`node_modules/@earendil-works/pi-ai/dist/utils/diagnostics.d.ts:7-12`). Do not use it in `message.usage` or compaction.
7. **Update tests.** Add/adjust focused tests in `test/cursor-provider.test.ts`:
   - Huge `turn-ended.usage` remains ignored for persisted pi `input/output/cache` and `totalTokens` stays context-safe, not huge (`test/cursor-provider.test.ts:2758-2795`).
   - Split live-run later turns do not recount the original prompt, count newly consumed matching tool results as input, and have meaningful `usage.totalTokens` for context/compaction.
   - Tool-call-only and thinking+toolCall assistant turns no longer persist all-zero session activity if `/session` is meant to account visible assistant activity.
   - Tool-result input attribution, if implemented, is deduped by `toolCallId`.
8. **Update docs.** `docs/cursor-model-ux-spec.md:32` and `README.md:250` should distinguish approximate session activity, context estimate, Cursor internal diagnostics, and non-billable status.

Long-term pi-core changes, outside this repo:

- Change `/session` to display separate metrics instead of only summing assistant `usage.input/output/cache*` from current state (`agent-session.js:2351-2387`, `interactive-mode.js:4289-4313`).
- Reconcile `/session` and footer scope; footer sums all persisted assistant entries (`footer.js:61-76`) while `/session` sums current `state.messages` only.
- Add first-class transcript/context/provider/internal usage fields so providers do not have to overload `usage.totalTokens`.

#### How to avoid the old false compaction/context-overflow bug

Do not put raw Cursor SDK `turn-ended.usage` into `message.usage` or `usage.totalTokens`.

The safe invariant should be:

- `usage.input/output`: approximate pi-visible session activity, never raw cumulative Cursor internal counters.
- `usage.totalTokens`: approximate current replayable pi context size derived from `buildCursorPrompt()` or equivalent pi-context estimation, never raw cumulative Cursor internal counters.
- Cursor SDK `turn-ended.usage`: diagnostic-only until Cursor SDK documents safe non-cumulative billable semantics.

This preserves the protection added in `CHANGELOG.md:126` while fixing the current undercount: context/compaction can use `usage.totalTokens`, and `/session` can show better activity estimates without mistaking Cursor internal cache/tool work for prompt context.

#### Eliminated hypotheses

- **JSONL corruption or parser loss:** eliminated. The file parses cleanly and persisted usage sums exactly to the reported `/session` totals.
- **pi `/session` doing hidden tokenization:** eliminated. Installed `/session` just sums assistant `usage` fields from current state.
- **Tool results accidentally had usage that `/session` ignored:** eliminated for this session. Tool results have no `usage`, and the pi type does not define `usage` on `ToolResultMessage`.
- **Raw Cursor SDK usage is available in the JSONL for reconstruction:** not found in persisted message usage. Current provider ignores `turn-ended.usage`, so reconstructing Cursor internal totals from this JSONL is not supported.

#### Root cause

The current provider intentionally avoided unsafe Cursor SDK cumulative usage, but it collapsed several different accounting concepts into a narrow assistant text/prompt estimate. In split live runs, prompt input is counted once and later replay turns often have no text output, so persisted assistant usage can be zero even when the user sees thinking/tool-call/tool-result activity. pi `/session` then faithfully reports those narrow persisted assistant usage fields, producing totals that are technically consistent but UX-incomplete and likely context-underrepresenting after tool-heavy split runs.

#### Conclusion

There is a real accounting-contract gap. Current behavior matches docs/tests, but the better fix is not to restore raw Cursor SDK usage. The correct path is dual accounting: keep Cursor SDK counters out of compaction, improve pi-visible session estimates, and use context-safe `usage.totalTokens` or a future first-class pi field for replayable prompt/context size.

## Investigation Log

### Phase 1 - Initial Assessment
**Hypothesis:** Token tracking may be incomplete because Cursor SDK usage is persisted as zeros for intermediate assistant/tool-turn events, while `/session` aggregates only persisted `message.usage` fields and/or ignores visible text/tool transcript content.

**Findings:** The supplied JSONL exists outside the repo and is 778 KB with 87 records. A safe structural scan found many assistant records with zero-valued usage fields.

**Evidence:**
- Session JSONL path above.
- Structural scan: 87 records; type counts: `session: 1`, `model_change: 1`, `thinking_level_change: 1`, `message: 84`.
- User's `/session` output: 82 total visible messages/events, 3,405 total tokens.

**Conclusion:** Initial symptom confirmed: persisted usage exists but is often zero. Later phases traced this through provider usage emission and pi `/session` aggregation.

### Phase 4 - Oracle synthesis: proper fix path
**Hypothesis:** There is a safe way to improve token tracking without restoring raw Cursor SDK cumulative usage.

**Findings:** Oracle recommended a provider-side dual estimate now:
- `usage.input`: incremental approximate session input, including the initial `Agent.send()` prompt once plus newly consumed tool-result text on split live-run continuations, deduped by `toolCallId`.
- `usage.output`: approximate assistant-visible output for each pi assistant turn, including text, thinking, and tool-call name/args.
- `usage.cacheRead/cacheWrite`: keep `0` unless Cursor SDK exposes a safe pi-compatible contract.
- `usage.totalTokens`: context-safe current replayable Cursor prompt estimate derived from `buildCursorPrompt(context + partial)`, allowed to differ from `input + output` because pi compaction already treats `totalTokens` as authoritative context usage.

**Evidence:**
- `/session` ignores `usage.totalTokens` and sums components only: installed `interactive-mode.js:4289-4313` → `getSessionStats()`, installed `agent-session.js:2351-2387`.
- Compaction/context estimation already prefers `usage.totalTokens`: installed `compaction.js:74-80`, `120-145`.
- Provider's real replayable prompt format is centralized in `src/context.ts:88-107`, `190-218`; it includes assistant text/tool calls and tool results, omits thinking, and reserves latest user-image tokens.

**Conclusion:** Confirmed. Near-term implementation should use existing `Usage` fields more precisely, while long-term pi core should split context/session/provider/internal usage into first-class metrics.

## Root Cause

`pi-cursor-sdk` correctly avoided copying raw Cursor SDK cumulative usage, but it collapsed several different accounting concepts into one narrow provider estimate.

Concrete chain:
1. The provider estimates usage in `setApproximateUsage()` with only prompt input plus text output, then sets `totalTokens = input + output` (`src/cursor-provider.ts:279-284`).
2. Split live runs count the original Cursor prompt once via `takeCursorNativePromptInputTokens()` (`src/cursor-provider.ts:636-640`).
3. Native replay and bridge tool-use turns add tool-call blocks, then call `setApproximateUsage(..., outputText)`; tool-call args are not counted as output, and later split turns commonly get `input: 0` (`src/cursor-provider.ts:643-695`).
4. Final live replay turns also use `takeCursorNativePromptInputTokens()`, so final turns usually have `input: 0` (`src/cursor-provider.ts:723-780`).
5. Raw Cursor SDK `turn-ended.usage` is ignored because it reports cumulative internal agent/tool/cache work, not pi replayable prompt context (`src/cursor-provider.ts:1198-1201`). That avoids the prior false context-overflow/compaction bug and is still the correct safety choice.
6. Installed pi `/session` does not independently tokenize visible transcript content. It prints `getSessionStats()` and sums only assistant `usage.input/output/cacheRead/cacheWrite` from current `state.messages` (`interactive-mode.js:4289-4313`, `agent-session.js:2351-2387`).
7. Tool results have no `usage` field in the pi message type, so tool-result text/images are not counted by `/session` unless the provider attributes them to a following assistant turn (`pi-ai/dist/types.d.ts:169-205`).

For the supplied session, the persisted fields therefore exactly explain the observed output: 37 assistant records have all-zero usage even though 28 contain tool calls and 8 contain thinking plus tool calls; persisted totals are exactly 3,086 input, 319 output, 3,405 total.

This is a real accounting-contract gap. Current docs/tests explain the old behavior, but the user expectation is valid: tool-heavy Cursor sessions need better approximate tracking.

## Recommendations

1. **Implement dual estimates in `src/cursor-usage-accounting.ts`.** Use a focused helper that writes:
   - `usage.input`: incremental approximate session input for this assistant record.
   - `usage.output`: approximate assistant-visible output for this assistant record, including text, thinking, and tool-call name/args.
   - `usage.cacheRead/cacheWrite`: `0`.
   - `usage.totalTokens`: context-safe current replayable Cursor prompt estimate derived from `buildCursorPrompt(context + partial)`, allowed to differ from `input + output`.
2. **Export/reuse token estimators from `src/context.ts`.** Keep one source of truth for prompt/context token estimation by deriving context totals from `buildCursorPrompt()` rather than duplicating transcript formatting. Thinking should remain excluded from context totals because `buildCursorPrompt()` omits thinking.
3. **Thread context through live-run usage finalization.** `replayPendingCursorLiveRun()` / `emitCursorNativeRunNextTurn()` need enough context to compute `usage.totalTokens` after appending each split assistant turn.
4. **Count consumed tool results as session input with dedupe.** Keep live-run state in `src/cursor-live-run-accounting.ts`, add newly consumed matching tool-result text/images to the following assistant turn's `usage.input`, and pass that same consumed result set to bridge MCP resolution; do not double-count across replay calls.
5. **Keep raw Cursor SDK usage diagnostic-only.** Do not put raw or delta Cursor SDK `turn-ended.usage` into `message.usage` or compaction. Diagnostics can record scrubbed raw/delta values if useful, but must label them internal/non-billable.
6. **Update tests in `test/cursor-provider.test.ts` and `test/context.test.ts`.** Cover: raw huge `turn-ended.usage` remains ignored; tool-call-only and thinking+toolCall turns have nonzero session output; later split turns do not recount the original prompt; tool-result input is deduped; final/empty split turns still have meaningful `usage.totalTokens`; `usage.totalTokens` may differ from `input + output`; context estimate includes tool calls/results, omits thinking, respects prompt budgeting, and reserves latest user-image tokens.
7. **Update docs.** Align `README.md`, `docs/cursor-model-ux-spec.md`, `docs/cursor-native-tool-replay.md`, and `CHANGELOG.md` with the new contract: Cursor raw usage is internal/diagnostic, `input/output` are approximate session activity, and `totalTokens` is the context-safe replayable prompt estimate.
8. **Long-term pi-core improvement:** split `/session` metrics into first-class fields: provider estimate, context estimate, visible transcript estimate, and Cursor/internal diagnostics. Also reconcile `/session` current-state scope with footer all-entry scope.

Rejected alternatives:
- Copy raw Cursor SDK `turn-ended.usage`: rejects because it reintroduces cumulative/internal/cache false-compaction behavior.
- Delta Cursor SDK usage as primary usage: rejects because it remains internal and ambiguous across split pi turns; use diagnostics only.
- Count full prompt input on every split turn: rejects because it double-counts one Cursor SDK run.
- Put tool results into `usage.output`: rejects because tool results are not assistant output; attribute consumed tool results as deduped input or expose a separate transcript/tool-result metric.
- Docs-only fix: rejects because it leaves all-zero records and context undercount.

## Preventive Measures

- Regression tests now assert key parts of the new token contract: raw huge Cursor SDK `turn-ended.usage` remains ignored, split live runs count consumed tool results without recounting the original prompt, visible tool-call and thinking+toolCall turns have nonzero output, empty final split turns retain context-safe `usage.totalTokens`, and `usage.totalTokens` can exceed `input + output` as the context estimate.
- `buildCursorPrompt()` is now reused by `src/cursor-usage-accounting.ts` so prompt formatting, budgeting, image reserves, and token accounting stay aligned.
- The existing huge Cursor SDK usage test remains in place to prevent accidental reintroduction of raw cumulative counters into pi usage or compaction.
- Docs now distinguish approximate session activity, context estimate, and raw Cursor internal usage.
- Tool-result image accounting is covered as prompt placeholder text, matching `buildCursorPrompt()`.
