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
candidate. Live launch of the candidate waits for an explicit pause of
production Desktop.

Work and Chat pins are the source constants
`CLIENT_OWNED_VOICE_VERSION` and `NATIVE_CHAT_VOICE_VERSION`. Shipping a
codexhost tag does not re-pin or qualify a newer Desktop.

## Daily driver

The daily driver is `/Applications/ChatGPT.app` at the pinned Work/Chat
version. Operator production use of that bundle is the acceptance for ordinary
Work/Chat voice on this pin. Open `compat-broken` issues and remaining
[#4](https://github.com/karlorz/codex-host/issues/4) edge items do not withhold
that baseline. Live voice, Composer, and hook debug attach to that
already-running Desktop. Leave `app.asar` unchanged. Do not quit or relaunch
it for pin-drift alerts or scratch inspection.

Sparkle **Install Update** replaces that bundle. Use **Skip this version** or
**Remind me later**, and leave automatic future installs off, until the offered
build is qualified. The public Sparkle feed
(`https://persistent.oaistatic.com/codex-app-prod/appcast.xml`) can be newer
than this Mac's Check for Updates offer
(`https://updates.oaistatic.com/codex/app/appcast`).

`npm start` quits running Codex Desktop before launch. Use it only when a
controlled relaunch is intended.

## Compat Daily

`npm run compat:daily` and `.github/workflows/compat-daily.yml` compare the
public macOS feed to the pins. They do not download ChatGPT.app, query the
per-installation updater, or test microphone/conversation behavior. Local runs
print JSON and do not open issues. On non-PR default-branch runs, pin-drift
findings open or comment `compat-broken` issues; operational errors skip issue
updates. New feed versions produce distinct issue titles. Matching pins add a
recovery comment but leave issues open for live acceptance review.

Microphone, playback, interruption, and spontaneous-close acceptance remain
[#4](https://github.com/karlorz/codex-host/issues/4). Grok stays ◐ and Cursor
stays unverified (`?`) on the README Live voice chat row; those Harnesses use
the generic external path (Host → configured gateway) on this daily driver.
Installed Start-button acceptance is still required. A matching pin does not
establish that work.

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
`/Applications/ChatGPT.app`. Before launching a candidate, independently
confirm that the daily driver has fully exited. Two ChatGPT GUIs must not share
one user profile. A separate `CODEX_ELECTRON_USER_DATA_PATH` / `--user-data-dir`
isolates Chromium profile data for one launch; it does not authorize concurrent
Desktops.

Preserve the qualified daily bundle. A gateway `POST /v1/realtime/calls` 201
establishes call creation only. Temporarily quit the daily driver for sequential
candidate qualification, then quit the candidate and reopen the daily driver.
Do not overwrite `/Applications/ChatGPT.app` (Developer ID `2DC432GLL2`).

Live-qualify a newer build in a dedicated window:

1. Finish or pause chats on the daily driver.
2. Confirm the daily driver has fully exited.
3. Launch the scratch bundle (set `CODEXHOST_INSTALL_ROOT` when it is not the
   discovered app).
4. Audit that exact build's assets, live Renderer contracts, and attended
   voice behavior. Work and Chat stay separate.
5. Quit the candidate. Reopen `/Applications/ChatGPT.app` at the pinned
   version. Clear `CODEXHOST_INSTALL_ROOT`.

After qualification, update only that surface's version and exact
asset/export mappings, then rerun `compat:daily`. Record remaining drift
explicitly.
