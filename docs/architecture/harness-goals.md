# Native goals for external Harnesses

External mapped Threads route `thread/goal/get`, `thread/goal/set` and `thread/goal/clear` through the optional public `HarnessSession.goals` capability. The owning Adapter confirms native state. Host provides no goal scheduler, completion inference or external model-tool injection. Official Codex requests and notifications retain their original route.

## Contract and Desktop projection

Browser-safe `HarnessGoal` schemas live in `shared-contracts`; Session operations live in `harness-adapter`. A supporting producer supplies objective, status, token budget, native tokens used, elapsed active seconds, and epoch-second creation/update timestamps. Required accounting cannot be filled with assumed zeros. Goal changes emit `goal.changed`; Host projects `thread/goal/updated` or `thread/goal/cleared` with the mapped Host Thread ID. Unsupported plugins return `-32076`, including reads; null means a supported native read confirmed no goal.

Set supports objective, active/paused status and an optional token budget, subject to native restrictions. Mutations preserve explicit origin; missing/null origin remains null. Desktop 26.1023.51421 omits origin even for automatic mutations. Its clear-after-completion and pause-on-interrupt requests are controls, with no inference Turn. Unsupported status writes reject explicitly. Failed/uncertain confirmation must be re-read before retrying.

Requests reuse the per-Thread operation queue and idle-release guard. Goal operations and notifications are pinned to the current external Session; output from a replaced Session is discarded. Active native goals keep their Session alive between rounds through `hasBackgroundWork()`. Native continuation owns its own real Turn identity and uses the existing autonomous Turn path. Goal confirmation is independent of worker completion.

## Producer status

| Producer | Native controls | Shared native panel | Model-facing goal tools |
| --- | --- | --- | --- |
| Grok | Native `/goal`; structured updates and persisted goal state | Implemented; installed Desktop acceptance pending | Native Harness owns its available tools; official Codex tools are not injected |
| ZCode | Typed `session/goal`, independent worker events; active goals block idle release | Not exposed: goal-level accounting/timestamp mapping remains unqualified and ZCode is not installed on the implementation host | Native tools unqualified |
| DeepSeek Harness | Existing `/dsh-goal` lifecycle | Not exposed pending native accounting/control qualification | Separate native qualification |
| Other plugins | Existing native capabilities vary | Optional contract available; no implicit support | Separate native qualification |

A native goal command alone does not establish panel support. Harnesses lacking required metrics can still have native goals; a limited display would require its own supported contract. No Host-managed fallback is enabled.

## Acceptance

Focused checks cover unsupported routing/no official fall-through, official pass-through, absent origin, native accounting validation, clear/pause without fabricated Turns, plugin loading, goal background ownership and independent worker identity. Native trials are separate from installed Desktop acceptance. Desktop acceptance must compare native state/usage to the panel, observe completion auto-clear, pause/resume/Stop, budget exhaustion and paused restore. Restart and installation are user-controlled.

The contract matches the generated goal definitions of bundled Codex CLI 0.165.0-alpha.1.2 and inspected Desktop 26.1023.51421. Grok 1.0.45 native active-control acceptance covers creation, independent worker observation, pause with native terminal identity, paused reopen and clear. Full native completion trials timed out; completion and budget exhaustion remain unqualified. Installed Desktop acceptance is pending. Future Desktop versions require compatibility verification.
