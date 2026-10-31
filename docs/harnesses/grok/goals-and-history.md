# Grok goals and conversation rewind

The Grok plugin supports Desktop's `/goal` Goal mode and exposes `/grok-goal` through the shared Harness command menu. Both use Grok's native `/goal` handler; Grok owns objective interpretation, token accounting, goal status, persistence and execution.

| Input | Native operation |
| --- | --- |
| Desktop `/goal` mode + objective | Admit the opening `/goal` command and acknowledge Desktop's matching goal-set request without a second native creation |
| `/grok-goal <objective>` | Set the objective with Grok's native default budget |
| `/grok-goal <objective> --budget <tokens>` | Set an explicit native token budget |
| `/grok-goal` or `/grok-goal status` | Show native goal status |
| `/grok-goal pause` | Pause the native goal |
| `/grok-goal resume` | Resume the native goal; this can invoke the model |
| `/grok-goal clear` | Clear the native goal |

The budget flag is trailing native syntax. The Adapter preserves the argument text and does not insert a budget. Native state confirmation and a status summary are returned through the command output. The plugin declares curated `/goal` and `/grok-goal` descriptors; the shared filter still excludes unqualified live goal commands from other plugins.

Desktop 26.1023.51421 starts a new Goal-mode chat with `/goal <objective>` as its opening Turn, then sends `thread/goal/set` for that objective. Matching in-flight creation requests share one native operation. A later duplicate acknowledges the existing goal only while its confirmed native ID, objective, budget and active status still match. Older persisted goals with the same text do not satisfy that confirmation.

Ordinary text such as “set a goal to implement …” remains model input. Grok's native `update_goal` tool reports progress/completion for an existing goal; it cannot create one. Model-driven creation is unsupported on native build `2bdd1d6` until Grok supplies a creation tool that completes inside its session actor. A Host MCP wrapper around a new `/goal` prompt would wait on its own calling Turn. No phrase matching or official Codex goal-tool injection is enabled.

Commands submitted while a Turn is running use the Host's existing stop-then-start path: cancel the active execution, wait for its terminal outcome, then execute the command. Stopping a Turn alone does not establish that the native goal is paused. Use `/grok-goal pause` to request that state transition.

## History identity and persistence

Goal controls use the optional Session goals capability independently of conversation Turn settlement. `/grok-goal` commands finish as ephemeral control entries. Native `goal_updated`/`goal_cleared` updates confirm state; the persisted goal snapshot supplies native creation time and read/reopen state. Tokens use native goal accounting (the high-water counter on disk, `tokens_used` on the wire); elapsed milliseconds exclude paused intervals and are converted to whole seconds. No budget is inserted. Objective plus paused status, multiline/reserved control objectives, embedded budget command syntax, and budget-only changes are rejected because the native command cannot apply them atomically.

While a native goal is active, ordinary user Turns and configuration/compaction operations are refused until the goal is paused. This prevents input queued behind native goal work from claiming the worker's output. Direct shared pause and active/paused-goal clear controls cancel an active worker, wait for its terminal outcome, then apply the native control. Clearing an already-complete goal waits for its worker and native summarizer to finish without cancelling them. The wait shares the control deadline; timeout or a changed goal/session fails explicitly and cannot send a late clear. Native failures remain explicit.

Planning can request native tool approval before a parent worker Turn exists. The current interaction contract requires an active Turn, so a planner request in that phase cannot be shown as a parent approval and native planning can pause. Use an explicitly selected native permission policy that permits the planning work. The Adapter does not change that policy automatically.

Native goal planning can keep the ACP prompt response open after creating goal state. Creation confirmation does not wait for that response. Pause, resume and clear wait for the native control response and matching durable state; a cancellation update alone cannot acknowledge a pending pause. Later independent native prompts have their own Prompt Index and terminal ID and are projected as autonomous Turns; hidden reminder input remains hidden. Persistence settlement waits for the matching terminal append. Ordinary prompt identity checks are unchanged. Local legacy transports without the optional observer retain their explicit host-Turn/zero-token settlement checks.

Hidden input becomes a historical Turn when it has an explicit Prompt Index, a fresh native terminal ID and execution evidence: agent output/thought, a tool call or nonzero native usage. A native goal worker cancelled before its first Item is also retained using native goal context. Terminal prefixes such as `task-completed-*` and `subagent-completed-*` do not establish whether a response is real. Replay, live settlement and usage share this classification.

Fresh or reused terminal IDs without execution evidence complete ephemerally for notification-only hidden prompts and stay out of replay. Reusing a durable terminal ID for a new response with execution fails explicitly. Skipped reminders still consume their native Prompt Index. Real background responses missing from older Host mappings are backfilled with native checkpoints; existing Host Turn IDs remain stable. Live settlement checks the exact terminal key and its new occurrence, so an older same-key record cannot acknowledge delayed persistence.

Each observed worker emits `turn.autonomous.started` to admit its identity, then `turn.started` before any Item or terminal. Host projection requires both events. The regression test `app-server-host.grok-goal-worker.test.ts` exercises Desktop's opening command and duplicate goal-set through the real Grok Adapter and Host, including successive worker rounds and persisted mappings; its opt-in native case runs the same path with the real executable.

Active goals prevent idle release between rounds. Goal pause/clear use the native handler; native busy/error outcomes are reported rather than converted into success. Reopening reads native state and never automatically resumes a paused goal. The public Host bridge and Desktop accounting requirements are described in [Native goals](../../architecture/harness-goals.md).

ACP prompt replies can arrive before the persistence actor appends `turn_completed` to `updates.jsonl`. When the response supplies `promptId`, the Transport waits up to three seconds for a new occurrence of that exact terminal record before settling a successful Turn. This prevents one command's delayed history from being assigned to the next command. Rewind likewise waits for a new native rewind marker before projecting the retained history.

## Goal helper chats

Native planner, skeptic and summarizer sessions are projected through the shared Subagent bridge. The Adapter retains child/session/attempt identity and binds each helper through `parent_prompt_id`, matching its owning worker's terminal key. Standalone helper events are buffered until that key is confirmed, then published before the owning Turn closes. They do not create a separate worker or fabricated parent Turn.

Replay puts pre-input planners and post-terminal summaries in their actual owning Turn. A helper spawned after the parent terminal becomes visible on reopen. Grok persists the goal summarizer output appended to the worker last message; when that message ends with the exact summarizer output and keeps a non-empty prefix, replay splits it into two Agent Messages so the summary is the final answer. Missing ownership produces no guessed attachment. Native model IDs and meaningful roles are retained; `general-purpose` is not a role. Child links open final read-only transcripts, including an honestly empty cancelled child. Continuous child transcript streaming is not claimed. See [Grok Subagents](subagent-status-and-model.md).

## Editing an earlier message

Grok declares the optional public `history.rollbackToCheckpoint` capability. Host rollback removes the selected message's Turn and all later Turns through `open({ kind: "rollbackToCheckpoint", checkpoint, sourceRef, ... })`. The Grok Adapter resolves the checkpoint to the native Prompt Index and calls `_x.ai/rewind/execute` with `mode: "conversation_only"` and `force: true`.

The retained prefix must have exactly the expected native Turn keys and length, including an empty prefix. Host mappings retain the existing Host Turn IDs and use a revision-checked replacement transaction. Model, Thinking and Permission Mode are preserved. Rewind changes conversation context; it does not restore workspace files or Git state. Native goal-state changes are governed by Grok's own rewind semantics.

Invalid or foreign checkpoints are rejected before native mutation. Histories from older builds that contain unmarked local goal controls are rejected before rewind because their apparent sequential indices cannot establish native rewind boundaries. A native in-place rewind is not an atomic transaction with Host persistence: if the native operation succeeds and later validation or mapping persistence fails, the native history may already have changed; the Adapter reports failure and does not fabricate success or a replacement mapping.

## Validation and remaining limits

Isolated macOS trials on `/Users/karlchow/.grokgod/bin/grok`, reporting `1.0.45 (2bdd1d6a6369)`, verify local status/pause/clear/resume with no active goal, zero model calls for those controls, same-ID reopen, and two real model-backed Turns rewound to empty history without changing a sentinel file. These trials use temporary project and `GROK_HOME` directories and do not touch installed Desktop sessions.

The active-goal native control trial also passed: goal creation, independent worker observation, pause with a cancelled worker and real terminal identity, same-ID paused reopen, and clear. The repaired full-Host native completion trial passed with an explicitly selected Always approve policy and a 150,000-token test budget: native completion, immediate goal clear, completed parent Turn, at least five readable helper histories and the timestamp file. This uses a disposable project and native home; installed Desktop housekeeping remains a separate acceptance check.

The command surface covers native objective, budget, status, pause, resume and clear. Native control and autonomous-observation code has focused regression tests. A fresh native TUI comparison reached budget_limited at 51,461 / 50,000 tokens after writing its file; native accounting can cross the threshold while an inference finishes. That run qualifies native budget stopping, separately from shared-panel budgeting and goal completion. Installed Desktop panel behavior, completion auto-clear, active pause/resume/Stop, budget exhaustion and paused restore still require Desktop acceptance; native-only tests do not qualify those paths. Grok may restore an active goal as user-paused; Host resume does not automatically resume it.

Installed Desktop editing and command-menu acceptance require a separately approved deployment/restart. The screenshot's generic “Failed to edit message” was not correlated to an exact RPC failure; the regression tests establish the previously missing multi-Turn rollback path without asserting that it was the only possible cause of that screenshot.
