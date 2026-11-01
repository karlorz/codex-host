# Grok background activity

Grok's native TUI separates process Tasks (`Run`), Watchers (streaming `Monitor` processes and timed `Loop` registrations), and genuine Subagents. A Loop registration is a schedule; each native invocation can create a real child agent. Grok owns scheduling, overlap prevention, expiry, persistence and completion wakeups.

## Desktop presentation

Run and Monitor processes associated with a detached `commandExecution` Item use Desktop's **Background processes** section and terminal output. Genuine children use native child Threads. Neither gets a duplicate extension row. The Adapter reports the known `commandItemId` association, including retained completed associations in its bounded in-memory history; a restored process with no such association remains accessible as a process-typed supplemental row.

Loop schedules and unassociated processes appear in one extension-owned **Background activity** section inside the existing native thread-summary panel. Rows expand inline for native prompt/output, cadence, next-run timestamp and controls. There is no activity entry above the composer, portal fallback or separate full-height pane. The native Goal, Plan, slash menu, process UI and child navigation retain their own state and layout.

The section uses the native summary heading, row-label and secondary-text typography utilities, including dynamic-isle density variants. Its heading collapses the section without stopping discovery, polling or the schedule; reopening preserves selected row details. Temporary panel hiding retains this expansion state, and changing conversation resets it. Expanded Loop details show the first prompt line as a heading and place the remaining exact text under a collapsed **Schedule instructions** disclosure. Its open state survives polling; choosing another row resets it. Prompt text uses the panel font and process output retains monospace formatting. Instructions render as text, not executable markup.

Discovered child Threads expose the same native activity path convention as delegated children: their description/title, role or native child identity. Desktop can then place working children and completed-child counts in its normal compact Subagents summary. The full native Subagents tab retains completed history. This projection does not invent parent Turns or alter native child completion state.

Desktop's existing **Toggle summary** / **Toggle pinned summary** header action provides the native opening path for eligible local chats, independently of process or child rows. The extension does not open or pin the panel itself. That control's source placement is established for Desktop 26.1027.30824; Loop-only initial access remains an acceptance check. User screenshots establish mounting in a chat with concurrent native activity, rather than every possible opening state.

The versioned binding requires an active external conversation, its native workspace, exactly one visible summary root and one unambiguous native section container. It does not search localized headings or change native classes/styles. Missing, ambiguous or hidden panels leave no extension node; polling continues to discover actual activity and materialize children. A validated container may retain supplemental rows when its last native section disappears. A connected validated container is remembered across temporary hiding and revalidated before reuse; changing conversation clears that reference. Panel replacement, layout changes, context changes and disposal remove or retarget only extension-owned nodes. Static-derived default/dynamic-isle fixtures qualify this candidate; installed screenshots establish mounting for the shown mixed-activity state, while Loop-only initial panel availability remains a separate acceptance requirement. This is a private DOM integration, not a supported Codex plugin UI slot.

Only running, scheduled or unknown supplemental activity keeps the section visible. A registry containing only native-represented processes, genuine children or terminal history leaves no extension node or spacing. While supplemental work continues, its completed results remain readable. Stable list/detail replies and unchanged clocks do not rewrite DOM.

- Process output/status comes from Grok's `x.ai/task/list`, scoped to the native parent Session, with native truncation preserved.
- Loop details use the native prompt, interval and next-run timestamp. Read-only `resources_state.json` supplies restoration because a scheduler-list ACP method is unavailable. Timestamps follow native `ScheduledTask.next_fire_at` and `pending_fire_at`; reaching the timestamp displays “Waiting for Harness.” Renderer countdowns never dispatch work.
- Live scheduler events and confirmed native deletions take precedence over persisted snapshots for the Session. Persistence refreshes restored schedules until their first live event; stale files cannot erase an observed schedule, replace its next-run state or restore a deleted one.
- **Stop task** calls native `x.ai/task/kill` with `clientUi`. **Delete schedule** calls native `x.ai/scheduler/delete`. Schedule deletion leaves genuine children with their own lifecycle; Desktop's native bulk terminal cleanup stops processes only.
- **Open latest run** resolves the actual related child through the current Host's activity list/read, then invokes the current parent conversation's native `onOpenBackgroundAgent` callback. The versioned binding requires an unambiguous committed React owner with matching parent conversation and Host IDs. Genuine external children are read-only, so Desktop opens its native Subagents panel and verifies descendant membership. Children need no main-sidebar row. Missing or conflicting ownership produces an explicit error; no URL, new-window or sidebar fallback is used. Generic child descriptors and activity list/read materialization stay available independently of custom child presentation and a mounted section; no parent Turn is fabricated.
- `/loop <interval and task>` uses the native slash-command handler. Grok interprets cadence and can ask for missing details. Host supplies no default interval.

## Public boundary

`HarnessSession.backgroundActivity` is an optional Session capability with `list`, `read`, `stop` and native child identities for Host materialization. Browser-safe schemas and `codexhost/thread/activity/{list,read,stop}` RPCs are shared across plugins. Host and Renderer contain no Grok-ID dispatch. Unsupported plugins return an explicit unsupported result; official Codex Threads keep their native behavior.

Activity reads and controls create no conversation Turns. Live scheduler children have session-level ownership and are never attached to an arbitrary subsequent parent Turn. Existing tool-spawn and goal-helper delegation Items keep their native owning prompt semantics. Background response history remains the existing autonomous-Turn mechanism with durable native identities and execution evidence.

Renderer responses are guarded by host, Thread, composer, route and request generation. Context switches remove the old surface immediately and can load the new context while an old request is pending. Controls and errors use text-only DOM rendering. Output and process-file reads are bounded; native clipped output retains `outputTruncated` even below the local limit.

## Validation and limits

Native reference: Grok `1.0.45` (`2bdd1d6a6369`), committed source plus local native patches. Background capability tests cover native ownership, schedules, child output, native stop/delete and explicit errors. Host integration covers idle child materialization, scoped metadata-only discovery, stable identity and completion without a synthetic parent Turn or extra child Session.

Static-derived browser fixtures exercise shared-panel rendering, no-Goal/no-terminal activity, ambiguous/missing/hidden targets, native section churn, layout changes, stale replies, conditional removal, process/schedule control separation, native-content preservation and steady-state mutations. The built public Renderer path exercises genuine child navigation with Host isolation. Fixture evidence is not installed Desktop evidence.

User screenshots after a manual reopen on 2026-11-02 accept the shown panel appearance, separated Loop heading, collapsed/readable instructions, live countdown, native completed-child counts and visible composer. The installed Renderer generation passed 31 browser checks and 13 focused Renderer unit tests. These counts qualify that generation, not all cross-package or native behavior.

| Surface / behavior | Automated or native evidence | Installed Desktop qualification |
| --- | --- | --- |
| Run/Monitor execution, recurring Loop children and cleanup | Isolated native trials and Host/Adapter regressions | Attended trials produce real process output and child results; final cleanup must be checked per trial |
| Shared-panel mounting, native fonts, heading and instructions | Default/dynamic-isle browser fixtures, polling and disclosure regressions | Appearance accepted in the shown mixed-activity state |
| Genuine child identity and active/done presentation | Host materialization and lifecycle regressions | Native done counts observed; full history remains native |
| Open latest run | Guarded native callback, Host isolation and stale child-read regressions | Successful installed click remains unconfirmed |
| Stop task / Delete schedule | Native Harness controls and process/schedule separation regressions | Actual Desktop control clicks remain unqualified |
| Loop-only initial access; Goal/Plan/slash coexistence | Static-derived browser fixtures and native source inspection | Full attended matrix remains unqualified |
| Chat switching and panel replacement | Context-generation, hidden/replaced panel and stale-response fixtures | Earlier flashing and missing composer have no established root cause; broader stability remains unqualified |

Further installed acceptance checks Loop-only access, native Goal/Plan/slash preservation, native process stopping, schedule deletion, child navigation, cleanup and visible stability. No automatic stop, restart, reload or focus is part of installation. Private panel structure can change between Desktop versions; a missing binding hides supplemental activity without cancelling native work. Native controls and schedule deletion through the Harness remain separate from presentation.

Cold process restoration depends on Grok retaining native task snapshots. Historical child transcript reads remain snapshots; continuous Desktop child streaming is unqualified. Native APIs that return unsupported, malformed output or owner mismatches fail explicitly.
