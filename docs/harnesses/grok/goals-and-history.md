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

The budget flag is trailing native syntax. The Adapter preserves the argument text and does not insert a budget. Native errors and native status messages are returned through the normal command output. Raw live `/goal` remains excluded by the shared command filter; the curated `/grok-goal` descriptor is the supported entry point.

Commands submitted while a Turn is running use the Host's existing stop-then-start path: cancel the active execution, wait for its terminal outcome, then execute the command. Stopping a Turn alone does not establish that the native goal is paused. Use `/grok-goal pause` to request that state transition.

## History identity and persistence

Local goal controls can finish without creating a conversation Turn. Grok marks their user echoes with `host_turn` inside the ACP update metadata. The Transport preserves both update and notification metadata. An admitted command is ephemeral only when native host-Turn evidence and a zero-token native response establish that result; a missing Native Turn Ref alone is insufficient.

ACP prompt replies can arrive before the persistence actor appends `turn_completed` to `updates.jsonl`. When the response supplies `promptId`, the Transport waits up to three seconds for that exact terminal record before settling a successful Turn. This prevents one command's delayed history from being assigned to the next command. Rewind likewise waits for a new native rewind marker before projecting the retained history.

## Editing an earlier message

Grok declares the optional public `history.rollbackToCheckpoint` capability. Host rollback removes the selected message's Turn and all later Turns through `open({ kind: "rollbackToCheckpoint", checkpoint, sourceRef, ... })`. The Grok Adapter resolves the checkpoint to the native Prompt Index and calls `_x.ai/rewind/execute` with `mode: "conversation_only"` and `force: true`.

The retained prefix must have exactly the expected native Turn keys and length, including an empty prefix. Host mappings retain the existing Host Turn IDs and use a revision-checked replacement transaction. Model, Thinking and Permission Mode are preserved. Rewind changes conversation context; it does not restore workspace files or Git state. Native goal-state changes are governed by Grok's own rewind semantics.

Invalid or foreign checkpoints are rejected before native mutation. Histories from older builds that contain unmarked local goal controls are rejected before rewind because their apparent sequential indices cannot establish native rewind boundaries. A native in-place rewind is not an atomic transaction with Host persistence: if the native operation succeeds and later validation or mapping persistence fails, the native history may already have changed; the Adapter reports failure and does not fabricate success or a replacement mapping.

## Validation and remaining limits

Isolated macOS trials on `/Users/karlchow/.grokgod/bin/grok`, reporting `1.0.45 (2bdd1d6a6369)`, verify local status/pause/clear/resume with no active goal, zero model calls for those controls, same-ID reopen, and two real model-backed Turns rewound to empty history without changing a sentinel file. These trials use temporary project and `GROK_HOME` directories and do not touch installed Desktop sessions.

The command surface covers native objective, budget, status, pause, resume and clear. Full autonomous goal execution remains partially qualified: native source includes in-Turn loops and queues a hidden GoalSummary after the original ACP response is resolved; queued user input runs first. A settled native cancellation auto-pauses an active goal and stale queued summaries are dropped until `/goal resume`. The Adapter currently projects output only during an active command/Turn. It does not yet advertise `autonomousTurns.observe` or a separate live goal dashboard. Background continuation projection and a real active-goal pause/resume/reopen trial remain acceptance gaps. Grok may restore an active goal as user-paused; Host resume does not automatically resume it.

Installed Desktop editing and command-menu acceptance require a separately approved deployment/restart. The screenshot's generic “Failed to edit message” was not correlated to an exact RPC failure; the regression tests establish the previously missing multi-Turn rollback path without asserting that it was the only possible cause of that screenshot.
