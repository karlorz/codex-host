# macOS daily Desktop vs voice pin drift

Use this when Sparkle offers a newer ChatGPT.app than the Work/Chat voice pins,
or when Compat Daily opens `compat-broken` issues. It is the operator split
between the qualified daily driver and an unaudited public release.

This page does not re-pin Desktop, download ChatGPT.app, or prove a live call.
Voice bindings and acceptance limits stay in
[cpa-live-voice-desktop-hook.md](cpa-live-voice-desktop-hook.md).
Re-pin steps stay in [tools/compat-daily/README.md](../../tools/compat-daily/README.md).
Renderer/bridge diagnosis after an *installed* update stays in
[codex-desktop-upgrade-diagnosis-playbook.md](codex-desktop-upgrade-diagnosis-playbook.md).

## Policy

Prefer qualifying toward the public Sparkle latest so Work/Chat pins can catch
up. Do not interrupt the daily driver or in-progress production chats to do
that. A pin-behind public-feed alert does not authorize replacing
`/Applications/ChatGPT.app`. Unknown or mixed Desktop assets fail closed;
re-audit before enabling an unknown build.

The default step toward latest is a scratch download plus static ASAR/export
inspection, with the daily driver left running. Store that bundle under the
ignored `.codexhost/update-impact/<version>/` tree, never on a discovery
candidate. A scratch Desktop may run in parallel with production; it must not
replace `/Applications/ChatGPT.app` or share that user profile. Agents still
must not quit production.

Compat Daily derives monitoring baselines from validated reviewed macOS voice
evidence, with the retained named Work/Chat profiles as fallback. Chat advances
independently; Work requires accepted Codex and Grok evidence on the same Desktop
version and build. The source qualification loader validates evidence and its
implementation fingerprint before comparison. Invalid or stale evidence fails
the check without mutating issues. Named profile constants and exact assets in
`packages/renderer-extension/src/renderer-voice-profiles.ts` remain historical
runtime identities. Shipping a codexhost tag does not qualify a newer Desktop.
A matching monitoring baseline clears release drift; it does not establish a new
live test. Accepted production activation survives builds and releases.

## Daily driver

The accepted daily driver is `/Applications/ChatGPT.app` at
**26.1106.51428**, build **26605**. Chat, Work/Codex and Work/Grok have reviewed
activation on implementation **496ea96312a2e7b6**, preserving their original
attended evidence. Karl reported the installed full build passed after a normal
restart on 2026-11-17. Preserve this activation across builds and releases;
package version changes and incomplete later runs do not revoke acceptance.
The detailed provenance is in the [voice procedure](cpa-live-voice-desktop-hook.md#reviewed-macos-activation).
The retained named Work/Chat profile remains **26.1027.61615**.
The Controller supports Renderer installation on the accepted hashed build:
its isolated signed-out startup supports
`Runtime.enable`, `Debugger.enable`, the loaded-module catalog and production
Renderer bundle evaluation without the Windows Store splash hang. Those startup
observations are separate from the attended acceptance above. Voice retains its
exact asset/version gates. Avatar-overlay voice-hook CDP is installed once on
this build so compact Voice Chat Work calls can use the configured gateway
without a 500ms overlay `Runtime.enable` race. Current-document overlay
injection uses the small hashed webpack voice bootstrap instead of evaluating
the full overlay hook IIFE during Voice start. Other
**26.1106.*** builds and **26.1103.*** remain skipped; the Windows Store skip is
unchanged.

An earlier signed-in inspection of **26.1106.51428** reached a visible Agent control and a
ready local RPC route, then encountered recurring `Runtime.enable` timeouts and
a busy Renderer. A focused regression reproduces recursion when submission
preparation and steering independently wrap the native registry's `forHost`.
The source uses shared hook ownership to preserve both wrappers across refreshes;
timed-out CDP connections close before accepting further commands. Signed-in
runtime acceptance for unrelated submission behavior remains independent of voice. A transient Controller
`installed` status does not establish external submission readiness, and the
numeric-chunk native Remote Control discovery path remains unqualified.
Windows Store uses a separate pin in
[windows-desktop-pin-daily-driver.md](windows-desktop-pin-daily-driver.md).
Open `compat-broken` pin-drift issues ([#43](https://github.com/karlorz/codex-host/issues/43),
[#44](https://github.com/karlorz/codex-host/issues/44)) are live alerts, not a
queue to install the public feed. Upstream `v0.18.0` Desktop 26.1106 support is
the 24/25-slot draft Model memo layout, not a Live Voice qualification. A
newer public Desktop opens a new issue per surface and closes the previous
tracker as superseded. Operator production use of that bundle is the
acceptance for ordinary Work/Chat voice on this pin. Open `compat-broken`
issues and [#4](https://github.com/karlorz/codex-host/issues/4) dogfood items
do not withhold that baseline. Live voice, Composer, and hook debug attach to that
already-running Desktop. Leave `app.asar` unchanged.

Only the operator may quit or restart `/Applications/ChatGPT.app`. Agents must
not quit, relaunch, or run `npm start` / `npm run install:local` against that
production Desktop. Current-document voice-hook refresh uses the live
`Runtime.evaluate` attach in
[cpa-live-voice-desktop-hook.md](cpa-live-voice-desktop-hook.md#live-voice-hook-debug-on-a-running-desktop).
That is an attended debug path for the open page, not a generic Renderer
hot-reload. Skip mutation during an active or unknown call. New document-start
source still waits for the operator's later manual restart. Scratch inspection
and pin-drift alerts do not justify a relaunch.

Sparkle **Install Update** replaces that bundle. Use **Skip this version** or
**Remind me later**, and leave automatic future installs off, until the offered
build is qualified. The public Sparkle feed
(`https://persistent.oaistatic.com/codex-app-prod/appcast.xml`) can be newer
than this Mac's Check for Updates offer
(`https://updates.oaistatic.com/codex/app/appcast`).

`npm start` quits running Codex Desktop before launch. Do not use it against
the production daily driver. The disposable scratch Desktop is
`npm run scratch:candidate -- --print` or `--launch`
(`tools/dev-desktop/scratch-candidate.mjs`). It opens a bundle under
`.codexhost/update-impact/<version>/bundle/ChatGPT.app` with LaunchServices
(`/usr/bin/open -n -F`, plus `--env` / `--args`), matching Gate A
`launch-services` rather than spawning `Contents/MacOS/ChatGPT` under the
codexhost GUI. Direct spawn keeps macOS TCC `responsibleProc` on
`com.codexhost.app`, which has no `NSMicrophoneUsageDescription` and aborts
on microphone access. LaunchServices makes the official ChatGPT bundle
responsible. Isolated `CODEX_ELECTRON_USER_DATA_PATH` / `--user-data-dir`
still apply. It refuses discovery-path apps, aborts if production Desktop
PIDs disappear, and aborts if the new process is still attributed to the
host launcher or production Desktop.

## Compat Daily

`npm run compat:daily` and `.github/workflows/compat-daily.yml` compare the
public macOS feed to validated monitoring baselines. The accepted Chat and
Work baseline is **26.1106.51428 build 26605**, while retained named profiles stay
at **26.1027.61615**. They do not download ChatGPT.app, query the
per-installation updater, or test microphone/conversation behavior. Local runs
print JSON and do not open issues. On non-PR default-branch runs, pin-drift
findings open or comment `compat-broken` issues; operational errors skip issue
updates. Each surface keeps one open issue. A later Sparkle version opens a
new issue and closes the previous tracker as superseded. The same Sparkle
version refreshes the existing issue title/body when acceptance advances, or
comments on it when the baseline is unchanged. Matching baselines add a recovery comment
but leave issues open for live acceptance review.

Microphone-release, interruption/mute, and spontaneous-close checks stay
opportunistic dogfood on [#4](https://github.com/karlorz/codex-host/issues/4);
they are not a release gate. Grok's accepted voice path uses Host → configured
gateway. Cursor remains unverified; Grok acceptance does not qualify every
external Harness. A matching alert pin does not establish attended acceptance.

## Work that keeps the daily driver open

These do not require quitting `/Applications/ChatGPT.app`:

- Repository tests, typecheck, and source edits
- Downloading the public Sparkle package into a scratch directory
- Static ASAR / export / CSP inspection of that exact build
- Read-only or live-hook attach to the running daily driver
- Staging Renderer assets into `/Applications/codexhost.app`

Do not place an unaudited latest bundle on a Desktop discovery candidate:

- `/Applications/ChatGPT.app`
- `/Applications/Codex.app`
- `~/Applications/ChatGPT.app`
- `~/Applications/Codex.app`

`CODEXHOST_INSTALL_ROOT` names an explicit installation root for that
inspect or launch. It overrides discovery for that invocation and does not
replace the daily-driver bundle. Clear it before returning to normal operation.

## Live qualification of a newer Desktop

Static bundle inspection does not establish microphone capture, audible
playback, Start/Stop, or Renderer behavior. Those need the candidate build
running.

Isolated probes reject an already-running process of the **selected**
installation. A probe pointed at a scratch bundle may not detect
`/Applications/ChatGPT.app`. Two ChatGPT GUIs must not share one user profile.

The disposable scratch Desktop is the default way to run a candidate while
production stays up: isolated user data, never `/Applications/ChatGPT.app`,
never `npm start`. Concurrent Desktops are not a qualified product mode. If
Electron single-instance activates production instead of the scratch copy, abort
and do not fight that lock.

Preserve the qualified daily bundle. A gateway `POST /v1/realtime/calls` 201
establishes call creation only. Do not overwrite `/Applications/ChatGPT.app`
(Developer ID `2DC432GLL2`). An attended live-qualify that must own the machine
still waits for the operator to quit production; agents do not perform that quit.

Live-qualify a newer build from scratch storage:

1. Keep production chats on `/Applications/ChatGPT.app`.
2. `npm run scratch:candidate -- --print`, then `--launch` if production PIDs
   are listed and the bundle is not a discovery path.
3. Audit that exact build's assets, live Renderer contracts, and attended
   voice behavior on the scratch copy. Work and Chat stay separate.
4. Quit only the scratch PID in `.codexhost/update-impact/<version>/scratch-desktop.pid`.
   Leave production running. Clear `CODEXHOST_INSTALL_ROOT` in later shells.

After qualification, update only that surface's version and exact
asset/export mappings, then rerun `compat:daily`. Record remaining drift
explicitly.
