# CPA live-voice Desktop hook

Gated CodexHost Renderer hook that forces durable-only `clientOwnsCall` on official Codex Desktop **26.1007.30912**, so CPA can create the realtime call (`POST /v1/realtime/calls`) without rewriting `app.asar` or replacing `/Applications/ChatGPT.app`.

## Default

**Off.** Production injection does not enable the hook unless `CODEXHOST_CPA_LIVE_VOICE=1` is set in the Desktop Controller environment.

## What it changes

Desktop’s voice-start path sets `clientOwnsCall` when the `hostId` argument is `durable` **or** both of these hold: the host's app-server version supports the `threadRealtimeExistingCall` capability (a version comparison, not a stored flag), and Statsig gate `206132468` passes. That second branch POSTs to ChatGPT `/wham/realtime/calls` and then starts `thread/realtime/start` as `ExistingCall`. CPA never sees creation, so the sideband websocket 404s.

The hook forces Statsig `checkGate("206132468")` to false on every client registered on `__STATSIG__`. In the audited build that gate has no other reader, so the result is durable-only ownership: a local host gets `clientOwnsCall=false` and `transport=webrtc`, and CPA can `POST /v1/realtime/calls`. Other gates pass through unchanged. Official app-server traffic is not rewritten. Host still passes official `thread/realtime/*` through.

## How it is installed

1. When enabled, the Controller prefixes the production Renderer source with a frozen `globalThis.__codexhostCpaLiveVoiceHookV1` record (audited Desktop version and `app-initial` asset name only).
2. `Page.addScriptToEvaluateOnNewDocument` plus immediate `Runtime.evaluate` inject the Host Renderer into the primary `app://-/index.html` page.
3. Voice starts on the avatar overlay (`app://-/index.html?initialRoute=/avatar-overlay`). That page gets a **hook-only** bundle (`cpa-live-voice-hook.js`), not the Host Renderer binding. The overlay loads the same audited `app-initial` asset in its own JavaScript realm with its own Statsig client.
4. The Renderer hook no-ops unless the audited `app-initial-6350d04672d0.js` asset is present (performance entries, script src, or link href). Unknown builds fail closed.
5. On a matching page it polls for up to 60 seconds until a Statsig client is registered, then wraps that client's `checkGate`. The gate is read when voice starts, so the wrap only has to land before the first voice click.

Verify before a trial: on the overlay, `__STATSIG__.firstInstance.checkGate("206132468")` returns `false`.

The hook does not copy OpenAI frontend JavaScript into git. Tests keep a fixture of the known expression.

## Version gate

Audited only for Desktop **26.1007.30912** (primary bundle `app-initial-6350d04672d0.js`). Re-audit before enabling on a newer build. Fail closed: no wrap, no ASAR patch, keep `~/Applications/ChatGPT-Voice.app` if that copy is still the working path.

## Invariants

- Do not overwrite `/Applications/ChatGPT.app` (Developer ID `2DC432GLL2`).
- Do not reuse `install_voice_patch.py`.
- Do not quit or replace the working Voice copy until the CodexHost path proves `POST /v1/realtime/calls` 201.
- Do not put call IDs, SDP, or auth material in docs, git, or command output.
- Do not `git push` this branch or open an upstream PR unless explicitly requested.
