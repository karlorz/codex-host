# Desktop voice procedure and support

CodexHost keeps native Chat Instant Connect and Work gateway voice on the official Desktop. It does not rewrite `app.asar` or replace `/Applications/ChatGPT.app`. Audited identities live in `packages/renderer-extension/src/renderer-voice-profiles.ts`. Discovery never activates a profile.

Historical export mappings and older incidents: [cpa-live-voice-desktop-hook-history.md](cpa-live-voice-desktop-hook-history.md).

## Current procedure

1. Confirm the launched Desktop **product version**, **platform**, **native build**, **asar digest**, and **app path**. Managed launch writes those from the discovered installation. Inherited `CODEXHOST_DESKTOP_*` values cannot impersonate a different install. Hashes name assets; they do not prove export meaning or a connected call.
2. Production startup checks reviewed identity, the build-time implementation revision, native artifact identity, and assets cheaply. The implementation revision is a hash of the voice implementation source graph, baked before compile; it is not a digest of profile metadata, and production does not scan source at runtime. Profile digest remains a separate pin of the selected owner table. Native Chat START is bounded; a timeout aborts the owned native signal, keeps ownership of the uncertain native write, and ignores late results. Installer and npm payloads copy `app/voice-profile-pins.json` and `app/voice-qualification.json` next to the Renderer and validate them against current source identity and that implementation graph before archive. A packaged Controller with a Desktop version set does not fall back to in-process pin lists when those files are missing or corrupt. Empty `reviewedEvidence` is honest; it does not fabricate attended qualification.
3. For a new Desktop, run maintainer discovery against an explicit candidate inventory (`npm run voice:discovery -- --inventory <json>`). Structural similarity is a candidate, not activation. When source bytes are present, the maintainer CLI derives AST facts and rejects a supplied role interpretation that contradicts those bytes. Replay descriptors without bytes keep caller structure as snapshot assertions, not fresh byte-verified role ownership. An overlay-scoped `voice-isolated-qualification.json` may enable one unqualified candidate path for gathering evidence; it expires, never writes `reviewedEvidence`, and does not match `/Applications/ChatGPT.app`.
4. Qualify Chat and Work independently. Work records Codex and Grok separately. A passing Chat path does not enable Work or the other platform.
5. Require automated lifecycle/identity checks **and** attended two-way speech before reviewed activation. START acknowledgment, a button, a gateway-route event or a live audio track alone is not a pass.
6. If a path is unqualified or binding fails, disable that entry with a short reason. Do not substitute another product, Harness or route.
7. Sanitize evidence: profile/build/platform, path/Harness, stage/outcome codes and assertion booleans. No conversation IDs, SDP, tokens, transcripts or raw native exceptions.

Voice settings remain on the Desktop/console Voice page. ChatGPT Chat uses native START. Work uses the configured CPA gateway when selected. Saved `lastAgent` is not the selected Harness; official Codex stays selected when no current matching external carrier exists.

## Support and evidence

Support claims come from scoped evidence, not from the existence of profile constants. This refactor has not completed the six required live cells.

| Platform | Desktop identity | ChatGPT Chat | Work/Codex | Work/Grok |
| --- | --- | --- | --- | --- |
| macOS | 26.1106.51428 hashed Chat / overlay wrap | Isolated LaunchServices scratch: attended existing-Chat two-way pass (Karl). `captureActive=false` stayed Instant Audio buffering and is not input failure. Clean end/mic-release, draft, and leave/return remain open. Not reviewed activation. Prior Chat pass at commit `2ddfb791` is a separate cell. | Open. Gateway route events are not speech. | Open |
| macOS | 26.1027.61615 named profiles | Retained historical profile. Do not expand it to 26.1106 or Windows. | Retained historical profile | Open / not expanded |
| Windows | Rediscover package identity. Historical Store observation was OpenAI.Codex **26.1106.6628.0**; docs also referred to OpenAI.ChatGPT. | Open. Production Controller still skips 26.1106/26.1103 injection. `isolated-runtime-enable` may call `Runtime.enable` only after a native listener lookup matches `--app-path` and `--user-data`, and only on a websocket whose loopback host and port are that listener. | Open | Open |

Required Chat checks: existing web-backed conversation, new draft, leave/return, native connected state, End Voice, attended speech both ways, microphone release.

Required Work checks: actual voice entry, selected Harness preserved (Codex despite saved Cursor), configured gateway owns the call, connected speech, End Voice and microphone release.

## Maintainer discovery

```bash
npm run voice:discovery -- --inventory candidate.json
npm run voice:discovery -- --replay candidate.json --fingerprint <hex>
```

The command reads an explicit inventory or source list. It never modifies the installed official app. Unchanged-input replay must keep the same fingerprint and descriptor. Failed live module objects are not clean evidence.

Compat Daily (`npm run compat:daily`) remains a cheap Sparkle pin alert, not voice qualification. The Desktop contract audit `voice` surface projects reviewed identity; `discoveryRun: 0` means startup did not scan candidate bundles.

## Live voice-hook debug on a running Desktop

Use documented developer diagnostics: `__codexhostChatVoiceDebug`, `localStorage` `codexhost.chat-voice-debug.v1` and console `[codexhost-chat-voice]`. Do not ask the operator to open DevTools.

For an already running Desktop, use the narrow live voice-hook refresh in the [historical debug steps](cpa-live-voice-desktop-hook-history.md#live-voice-hook-debug-on-a-running-desktop) only when the current document must be validated without a full restart. Keep a read-only probe first. Skip mutation during an active or unknown call. Rediscover Inspector endpoints; a historical macOS CDP port is not a current guarantee.

Native Chat: dispose `__codexhostNativeChatVoiceV1` only when `activeCall` is false. START acknowledgment is not a connected-call claim. Documented debug events:

- `native-chat-capture`: Instant Connect Instant Audio buffering flag (`isInstantAudioCapturing`) and user actor-speaking state (`isUserSpeaking`). `isInstantAudioCapturing` becomes true only after native `422391` worklet `firstBuffer` + `capture.start`. Failed buffering falls back to the live microphone and leaves the flag false, so false is not “no microphone” and not remote-response failure. User input evidence stays `unknown` on this store unless a live-mic track/transport getter is exposed. `hasSpoken` is not capture or user VAD.
- `native-chat-response`: allowlisted `server.remoteState`, `relayReady` as a processed remote message, and remote speaking updates (`hasSpoken` / `metrics.numSpeaking` when remote `new_state` is `speaking`). These are not generated-speech or user-input proof.
- `native-chat-output`: assistant actor-speaking state (`isAssistantSpeaking`) and ducking. Device output is `unknown` unless Instant Connect AudioContext/source/sample counters are observed. `voiceConnectionQuality` is connection quality on `native-chat-state`, not playback proof.

They are not attended speech.

Windows hashed Desktop still skips ordinary Controller injection. To probe `Runtime.enable` on an owned isolated candidate without dropping that guard, run `node tools/dev-desktop/isolated-runtime-enable.mjs http://127.0.0.1:PORT --app-path <abs> --user-data <abs> --timeout-ms 8000`. Default lookup uses `lsof`+`ps` on macOS/Linux and English `netstat -ano -p TCP` plus process CommandLine/ExecutablePath on Windows; a failed lookup returns `identity-unverified`. The websocket must be loopback on the same verified listener port. Environment strings alone do not unskip injection.

## Invariants

- Do not overwrite `/Applications/ChatGPT.app`.
- Do not quit production Desktop or casually run `npm start` / `npm stop` / `install:local`.
- Do not mount a second hashed cache controller; native app-root ownership remains authoritative.
- Chat failure must not fall back into Work or overlay voice.
- Do not put call IDs, SDP, tokens, credentials or user speech transcripts in docs, git or command output.
- Isolated macOS scratch Desktop must launch through LaunchServices so ChatGPT.app is the TCC responsible process. Do not spawn its Mach-O under `/Applications/codexhost.app`, and do not add microphone usage strings to the host launcher to hide that attribution.
