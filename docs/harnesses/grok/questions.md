# Grok native questions

The Grok plugin handles ACP `_x.ai/ask_user_question` independently of tool permissions and MCP `_x.ai/mcp/elicit`. It projects native single-choice, multi-select and optionless questions through the public Host Question contract. No Grok-specific Host or Renderer branch is needed.

## Native request and response

The request contains `sessionId`, `toolCallId`, `mode` (`default` or `plan`), and a nonempty `questions` array. Each question has unique `question` text, `options` with `label` and `description`, optional `preview`, and optional `multiSelect`. Native opaque question/option IDs do not replace the wire answer keys: replies use the original question text and option labels.

A selected option returns the native shape:

```json
{
  "outcome": "accepted",
  "answers": { "Which letter?": ["Alpha"] }
}
```

Unanswered questions are omitted from accepted replies, matching the native protocol. Every choice question permits Other. A typed answer returns `["Other"]` plus `annotations[question].notes`. Optionless questions use the same native notes shape. Selected option previews appear as text in the option description and return in `annotations[question].preview`; multiple selected previews are joined with a blank line. The plugin does not render the native interactive preview UI.

Desktop dismissal returns `{ "outcome": "cancelled" }`. MCP consent and tool approval responses retain their own wire shapes; an approval cannot answer a question.

## Lifecycle and timeout ownership

Only the matching native Session's active Turn may show a question. Idle, foreign-Session, replay and compaction requests cancel without opening a card. Duplicate native tool-call IDs do not create another card. Malformed requests return ACP Invalid params.

Question responses pass the shared Host validator before reaching Grok. Unknown, duplicate and late interaction responses are rejected. Native `interaction_resolved` closes the matching card; Turn cancellation, settlement, process fault and Session close cancel pending requests and close each card once.

Grok may resolve a tool's permission step before opening a question with the same tool-call ID. A resolution notification only withdraws an already-pending question; it must not suppress that tool's later question request.

Grok owns the question timeout. Stock Grok and grokgod builds without patch `0027-ask-question-timeout-metadata` do not carry a deadline. Patch 0027 adds optional `timeout: { deadlineUnixMs, action }`, where action is `recommended` or `decline`, from the effective native timer configuration. The plugin maps this to display-only `autoResolution`, separately from Host-owned `expiresAt`. The shared card displays a countdown only when this metadata exists, and shows “Waiting for Harness…” at zero. It never answers or cancels at that deadline; Grok remains authoritative. Disabled native timers omit the metadata. Patch 0027 reports the initial deadline. Patch `0028-ask-question-activity-ack` adds optional `resetOnActivity` and an acknowledged activity request. When this flag is true, the Desktop card coalesces trusted clicks, key/input events, scrolls and later window focus regain at about 250 ms. Hover, initial display and synthetic events do not send activity. `_x.ai/ask_user_question_activity` takes the native Session and tool-call IDs and returns `{ timeout }` only after the native timer processes a reset; disabled, closed or unacknowledged resets return `{ timeout: null }`. The native acknowledgement waits at most two seconds. The Host forwards the returned deadline and the renderer updates without replacing the card or losing its draft. Failed or late acknowledgements do not optimistically reset the display. Native configuration, including `timeout_reset_on_activity`, remains authoritative; no config is read or changed by Host. When native timeout resolves the tool, Grok broadcasts `interaction_resolved`; the plugin withdraws the card. That notification does not distinguish timeout from other native withdrawal, so the Host records `cancelled`, rather than inventing an expiry reason.

## grokgod dependencies and limits

This fork uses the patched grokgod Grok build. The native question protocol already exists in Grok; grokgod patch `0011-ask-question-timeout-action` adds configurable timeout selection and activity-based timeout reset. Host question routing does not require a new grokgod patch.

- Native `timeout_action` remains authoritative, including honest recommended-option selection on timeout. The Host never reports that selection as a user response.
- Desktop activity reset requires grokgod patch 0028 as well as patch 0011 and effective native `timeout_reset_on_activity = true`. Stock Grok and older grokgod metadata do not advertise reset support. The original fire-and-forget notification remains compatible, while Desktop uses the acknowledged request so its displayed deadline follows the native timer.
- Grok `multiSelect: true` (or `multi_select: true`) maps to Host `multiple: true`. Question groups containing a multi-select use the shared codexhost checkbox card above the Composer; all selected native labels are returned as an array. Other contributes one native `Other` label with notes. Single-choice groups permitting Other also use the shared card above the Composer so the normal chat message editor stays available. Other single-choice/text-only groups keep native Desktop cards. Conflicting flags and duplicate selections are rejected.
- Plan-mode questions support ordinary accept/cancel. The native TUI's Chat about this and Skip interview actions are not exposed.
- Patch `0025-mcp-elicitation-persist` is separately required for MCP Always allow; see [MCP elicitation](mcp-elicitation.md). Patch `0026-cua-turn-end-release` separately supplies Computer Use cleanup and the Mac Sky release bridge; see [Computer Use release](computer-use-release.md).

## Shared multi-select card

The browser-safe `codexhost/thread/questions/list` RPC takes `{ threadId }` and returns pending shared-card question groups, with interaction and Turn IDs. `codexhost/thread/question/respond` takes those same IDs plus Host answer values and an optional cancellation flag. The Host validates ownership, required answers, declared values and duplicate selections before forwarding a response. Retired or expired interactions reject late replies. `codexhost/thread/question/activity` takes the same ownership IDs without answers. It invokes the optional generic Session activity method only when native metadata enables reset, publishes the acknowledged `autoResolution`, and ignores results for retired questions. The activity path cannot submit or cancel a question. A question group is never also sent as a native single-choice card.

The renderer queries only the visible external Composer, without overlapping requests, and uses that Host connection for answers. The card sits outside the native Composer so its text fields are not mistaken for chat editors. Its open Shadow DOM isolates form controls from Desktop's global CSS resets and inherits the light/dark color scheme. The compact Question header, numbered rows, inline free-text answer and Skip/Send buttons follow Desktop's native question layout. Checkboxes retain their accessible roles, multiple selections show checkmarks, and both Skip and the header's dismiss button cancel without submitting selections. Selected rows, keyboard focus and a fixed footer remain visible while long question content scrolls. Selections survive refresh and chat switching; switching away hides the card, and returning queries pending state. Failed refreshes hide the stale card; response failures retain the draft for retry. Native withdrawal, Turn/Session termination and configured Host expiry remove pending questions. Grok's own native timeout still owns its questions; no new Grok timer or default answer is added.

The extension requires matching Host and renderer versions. It does not extend the native Codex model's question tool. Grok's native ACP protocol already carries multiple answers, so basic checkbox routing requires no additional grokgod patch; the fork's existing patch dependencies above still apply.

Native question surfaces marked with `data-codex-composer-request-navigation` or `data-codex-composer-request` retain their own editors and submission actions. Host chat controls do not mount into a Composer occupied by one of these surfaces; an existing set is removed until the native request closes. This keeps Harness icons, model and usage controls out of the answer choices and free-text response row, including single-choice cards used by other Harnesses.

## Verification

Focused adapter, Host and browser regressions cover ACP extension dispatch, single and multiple answers, Other notes, previews, invalid and late responses, ownership changes, native withdrawal, cancellation and Session termination. Browser cases cover isolated styles in both color schemes, keyboard selection, scrolling, chat switching, draft preservation and native Composer isolation.

Attended installed Desktop tests verified choice and typed responses, Alpha and Beta returned together, the aligned Grok card layout, and Claude's ordinary message box remaining usable while a question stays open. The user also confirmed a visible ticking countdown and its reset after interaction. The final reset retest ended in Grok's native recommended-option timeout; it did not submit a multi-select response. Exact elapsed time after the last attended interaction was not measured.

An isolated installed-binary probe with model `flash-max` and an eight-second native timeout verified that activity after four seconds advanced the acknowledged deadline by 4.012 seconds. Native timeout resolved after 12.010 seconds, 7 ms after that deadline. With reset disabled, activity returned null and resolution stayed at the original deadline (18 ms after it). Both results were native recommended-option selections, without a submitted user answer or changes to user config.

The local grokgod production executable compiled successfully. Additional native test compilation for patch 0028 stopped at the 15 GiB disk guard before assertions ran; native unit-test execution is not established by that build. Countdown and activity-reset acceptance used a locally rebuilt grokgod binary containing patches 0027 and 0028. Native Plan controls and interactive preview UI remain outside the supported surface.
