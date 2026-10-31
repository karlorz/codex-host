# Grok same-turn interjection

Grok uses the ACP extension `x.ai/interject`, with `_x.ai/interject` as the legacy fallback. The extension writes text into the current Prompt's pending interjection buffer. Grok consumes it at its next native tool or model safe point, without cancelling the Prompt or starting another one. The Adapter does not manufacture an interruption or change Grok's instructions for handling unfinished work.

## Capability and acceptance

`capabilities.steer` is live and requires an open Session, a transport with `interject`, and an active user Turn whose cancellation has not started. Catalog-command Turns and autonomous `grok-autonomous-*` Turns cannot steer. `readCapabilities()` exposes the same decision across process boundaries.

The Adapter checks the target Turn before calling the native extension. Native `{ status: "queued" }` becomes `{ accepted: true }`; it acknowledges buffering rather than consumption. Empty input returns `invalidRequest`. An inactive or mismatched Turn returns `invalidState`. Missing native methods return `unsupported`. For explicit same-turn delivery, refusal is reported without cancelling and restarting.

## Composer queue and delivery

Every follow-up Enter in a loaded Thread with `modelProvider === "codexhost"` selects Desktop's native queue presentation before submission preparation or optimistic history. Ownership comes from conversation metadata, including when the Model is a hex-encoded `codexhost/plugin-v1@…` carrier. Official Codex Threads retain `inspect: official`, the native queue-mode reader, and native Steer when that is the user's setting.

On Desktops whose Manager lives in the Renderer, the hook wraps `getTurnCoordinator().options.getMessageQueueMode`, a sibling of `submissionHost`. The global settings reader has no Thread argument and is not wrapped. Desktop **26.1027.30824 / build 22943** exposes an RPC facade in the Renderer; `renderer-external-queue-policy.ts` sets the native `queueModeOverride: "queue"` on Composer's `sendMessage` before it reaches the main-process coordinator. Loaded metadata must identify one unambiguous Host/provider. Regular `queue` mode starts a normal Turn when idle. The queue row's explicit Steer action keeps its native path.

Host holds queued input until a command, tool, or agent-message completion. At that boundary it reads current capabilities, verifies the same Turn is still running, takes the current queue head, and sends `turn.steer`. Thus editing, deleting, or reordering a pending row changes what Grok receives. Multiple pending rows are delivered in order. Accepted input is projected as a `userMessage` in the current Turn, with the Desktop client identity, and the pending row is removed. There is no Host cancellation. Native consumption occurs at Grok's next safe point after receipt.

If the Turn completes before delivery, normal queue advancement starts the pending input as the next Turn. Harness commands stay queued for normal command execution. Renderer/Controller hooks and the Host/Grok plugin must be installed together; copying a bundle does not replace a process that already loaded it.

## Native history and execution limits

Grok records consumed interjections as native user messages with `synthetic_reason: "interjection"` and the prefix “The user sent a message while you were working:”. Cancellation instead records `prior_turn_interrupt: "mid_turn_abort"`. Reopening history preserves the original Host Turn identity.

Host receives completion notifications after native execution has advanced. Sending `x.ai/interject` from that notification can miss the native safe point before the next model request or tool call. The current boundary-triggered delivery therefore does not guarantee that B is skipped, even with separate tool calls. Sending earlier would require a native update/delete operation to keep the pending Desktop row editable; the direct interjection buffer currently exposes neither operation.

A tool boundary exists between separate native tool calls. It does not exist between statements inside one call such as `sleep 20; echo A; sleep 20; echo B`. Same-turn interjection cannot stop that call after A without interrupting the running tool. Whether Grok skips future work also depends on the follow-up instruction and Grok's native behavior; `reply Pong` alone does not guarantee cancellation of unfinished work.

## Composer verification

1. Keep the global Follow-up setting at **Steer**. Open a new Grok Thread and send `run sleep 20; echo A, then sleep 20; echo B`.
2. During the first sleep, Enter `reply Pong`. Expect an editable pending row, no immediate blue history bubble, and no interruption or queue-paused notice.
3. Inspect the actual tool calls. At the next available tool/model boundary, expect same-turn native interjection, history projection, and removal of the pending row. A combined call can finish both sleeps before this boundary.
4. To check a boundary after A specifically, ask for two separate tool calls. To require skipping B, explicitly ask the follow-up to skip the second command.
5. Send an idle Grok message and verify it starts a normal new Turn. In an official Codex Thread, Enter during a Turn must still use native Steer and `inspect: official`.
6. Edit and delete pending rows during a tool call; verify the edited text reaches native history and deleted text does not.

Focused tests replay Desktop's captured submission decision code for active Host queue admission, idle Host starts, and official Steer. Host tests cover pending edits, deletion, multiple messages, and same-turn projection. Adapter tests cover native capability, target validation, and the ACP interject wire request. These tests supplement real Composer verification.
