# Grok goals and conversation rewind

The Grok plugin exposes `/grok-goal` through the shared Harness command menu. It forwards the command to Grok's native `/goal` handler; Grok owns objective interpretation, token accounting, goal status, persistence and execution.

| Input | Native operation |
| --- | --- |
| `/grok-goal <objective>` | Set the objective with Grok's native default budget |
| `/grok-goal <objective> --budget <tokens>` | Set an explicit native token budget |
| `/grok-goal` or `/grok-goal status` | Show native goal status |
| `/grok-goal pause` | Pause the native goal |
| `/grok-goal resume` | Resume the native goal; this can invoke the model |
| `/grok-goal clear` | Clear the native goal |

The budget flag is trailing native syntax. The Adapter preserves the argument text and does not insert a budget. Native state confirmation and a status summary are returned through the command output. Raw live `/goal` remains excluded by the shared command filter; the curated `/grok-goal` descriptor is the supported entry point.

Commands submitted while a Turn is running use the Host's existing stop-then-start path: cancel the active execution, wait for its terminal outcome, then execute the command. Stopping a Turn alone does not establish that the native goal is paused. Use `/grok-goal pause` to request that state transition.

## History identity and persistence

Goal controls use the optional Session goals capability independently of conversation Turn settlement. `/grok-goal` commands finish as ephemeral control entries. Native `goal_updated`/`goal_cleared` updates confirm state; the persisted goal snapshot supplies native creation time and read/reopen state. Tokens use native goal accounting (the high-water counter on disk, `tokens_used` on the wire); elapsed milliseconds exclude paused intervals and are converted to whole seconds. No budget is inserted. Objective plus paused status, multiline/reserved control objectives, embedded budget command syntax, and budget-only changes are rejected because the native command cannot apply them atomically.

While a native goal is active, ordinary user Turns and configuration/compaction operations are refused until the goal is paused. This prevents input queued behind native goal work from claiming the worker's output. Direct shared pause/clear controls cancel an active worker, wait for its terminal outcome, then apply the native control. Native failures remain explicit.

Native goal planning can keep the ACP prompt response open after creating goal state. Creation confirmation does not wait for that response. Pause, resume and clear wait for the native control response and matching durable state; a cancellation update alone cannot acknowledge a pending pause. Later independent native prompts have their own Prompt Index and terminal ID and are projected as autonomous Turns; hidden reminder input remains hidden. Persistence settlement waits for the matching terminal append. Ordinary prompt identity checks are unchanged. Local legacy transports without the optional observer retain their explicit host-Turn/zero-token settlement checks.

Active goals prevent idle release between rounds. Goal pause/clear use the native handler; native busy/error outcomes are reported rather than converted into success. Reopening reads native state and never automatically resumes a paused goal. The public Host bridge and Desktop accounting requirements are described in [Native goals](../../architecture/harness-goals.md).

ACP prompt replies can arrive before the persistence actor appends `turn_completed` to `updates.jsonl`. When the response supplies `promptId`, the Transport waits up to three seconds for that exact terminal record before settling a successful Turn. This prevents one command's delayed history from being assigned to the next command. Rewind likewise waits for a new native rewind marker before projecting the retained history.

## Editing an earlier message

Grok declares the optional public `history.rollbackToCheckpoint` capability. Host rollback removes the selected message's Turn and all later Turns through `open({ kind: "rollbackToCheckpoint", checkpoint, sourceRef, ... })`. The Grok Adapter resolves the checkpoint to the native Prompt Index and calls `_x.ai/rewind/execute` with `mode: "conversation_only"` and `force: true`.

The retained prefix must have exactly the expected native Turn keys and length, including an empty prefix. Host mappings retain the existing Host Turn IDs and use a revision-checked replacement transaction. Model, Thinking and Permission Mode are preserved. Rewind changes conversation context; it does not restore workspace files or Git state. Native goal-state changes are governed by Grok's own rewind semantics.

Invalid or foreign checkpoints are rejected before native mutation. Histories from older builds that contain unmarked local goal controls are rejected before rewind because their apparent sequential indices cannot establish native rewind boundaries. A native in-place rewind is not an atomic transaction with Host persistence: if the native operation succeeds and later validation or mapping persistence fails, the native history may already have changed; the Adapter reports failure and does not fabricate success or a replacement mapping.

## Validation and remaining limits

Isolated macOS trials on `/Users/karlchow/.grokgod/bin/grok`, reporting `1.0.45 (2bdd1d6a6369)`, verify local status/pause/clear/resume with no active goal, zero model calls for those controls, same-ID reopen, and two real model-backed Turns rewound to empty history without changing a sentinel file. These trials use temporary project and `GROK_HOME` directories and do not touch installed Desktop sessions.

The active-goal native control trial also passed: goal creation, independent worker observation, pause with a cancelled worker and real terminal identity, same-ID paused reopen, and clear. An earlier trial exposed premature pause acknowledgement; the current control path waits for worker settlement and native acknowledgement. Full completion trials timed out despite observed worker output, so autonomous completion and budget exhaustion remain unqualified.

The command surface covers native objective, budget, status, pause, resume and clear. Native control and autonomous-observation code has focused regression tests. Installed Desktop panel behavior, completion auto-clear, active pause/resume/Stop, budget exhaustion and paused restore still require Desktop acceptance; native-only tests do not qualify those paths. Grok may restore an active goal as user-paused; Host resume does not automatically resume it.

Installed Desktop editing and command-menu acceptance require a separately approved deployment/restart. The screenshot's generic “Failed to edit message” was not correlated to an exact RPC failure; the regression tests establish the previously missing multi-Turn rollback path without asserting that it was the only possible cause of that screenshot.
