# Windows daily Desktop pin

Windows Store ChatGPT/Codex is a separate product from macOS Sparkle
`/Applications/ChatGPT.app`. Keep the Windows daily driver on Store
**26.1106**; do not take a later Store build until it is separately pinned.

## Daily driver

Verified 2026-11-14 over the `msi-1` SSH developer route (session 0):

- Appx identity is **OpenAI.Codex**
  `OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0`.
- `Get-AppxPackage OpenAI.ChatGPT` and `Get-AppxPackage *ChatGPT*` returned no
  package for that user or `-AllUsers`.
- `winget list --id OpenAI.ChatGPT` and `winget list --id OpenAI.Codex` both
  printed catalog row **ChatGPT / OpenAI.ChatGPT / 26.1106.6628.0**. That is the
  winget catalog id, not the Appx family name.

Product **26.1106.51428** (MSIX **26.1106.6628.0**) remains the retained Windows
pin. It is not a voice qualification. Do not treat **OpenAI.ChatGPT** as the
current Appx identity.

Observed 2026-11-15 on `msi-1` after Store auto-apply: current-user
`Get-AppxPackage OpenAI.Codex` is **26.1111.2228.0** (product
**26.1111.21308**). Package **26.1106.6628.0** is no longer installed for that
user. That Store move is not a new pin and not a voice qualification. Do not
DISM-rollback unless Karl asks. Production Renderer skip prefixes remain
`26.1103.` and `26.1106.`; **26.1111** is not on that skip list.

Installer:

`https://persistent.oaistatic.com/codex-app-prod/releases/26.1106.6628.0/ChatGPT-x64.msix`

Historical, unverified as a pin of the Appx family name:

`winget pin add --id OpenAI.ChatGPT --version 26.1106.6628.0`

That command gates later winget upgrades only if the catalog id still matches.
It does not stop Microsoft Store, and it is not proof that the installed
package family is `OpenAI.ChatGPT`.

Store **does auto-apply** after the payload finishes. ChatGPT has no in-window
download banner for this path; Windows Update Client pulls the MSIX from the
Microsoft CDN in the background (`PredefinedCallerApplication: WU Client
Download`). Registration often waits while the current package is in use, then
switches on ChatGPT exit or the next launch.

Keep Store auto app updates off on the daily driver:

```
HKLM\SOFTWARE\Policies\Microsoft\WindowsStore AutoDownload=2
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsStore\WindowsUpdate AutoDownload=2
```

`2` means never auto-download Store apps. An in-flight WU Client job can still
finish unless it is paused or its Delivery Optimization cache is deleted.

Install the pinned MSIX with DISM while Codex Desktop is stopped:

```
dism.exe /Online /Add-ProvisionedAppxPackage /PackagePath:<msix> /SkipLicense
```

Session-0 SSH `Add-AppxPackage` is access-denied; interactive unelevated
install can fail with `0x80073D28`.

## Renderer injection skip on 26.1106

Product **26.1106.51428** (MSIX **26.1106.6628.0**, Chromium 157) loads as
stock ChatGPT. CodexHost Renderer injection on that build leaves the window on
the splash and times out `Runtime.enable`. The Desktop Controller skips
injection on **26.1106.*** and **26.1103.*** product versions so Desktop stays
usable. Host and Web are independent of that skip.

The exact-version allow attempt on `msi-1` in interactive session **4**
reproduces Controller injection during splash: the Controller can briefly
report `installed` before recovery records `CDP command 'Runtime.enable' timed
out`; the visible window remains on the splash. That initial status is not a
successful attachment. Keep the Windows production skip.

An owned isolated copy of the current-user pin
(`Local\.codexhost\update-impact\26.1106.51428\bundle`, asar digest distinct
from the macOS scratch asar) launched in interactive session **1** with a
separate Electron user-data directory is a different route. After
`app://-/index.html` exists, `isolated-runtime-enable` `Runtime.enable` can
succeed without overlay injection. That does not unskip production Controller
injection and does not qualify Chat or Work voice.

The three hashed 26.1106 voice webpack files
(`webview/assets/348410.1a97dde15f.js`,
`webview/assets/async/530142.1e51e7f4b2.js`,
`webview/assets/async/586788.c871bb9b7d.js`) plus the imported scope/runtime
owners (`484232.729c583cfe.js` `cY1t`, `514766.2d2f1ddc86.js` `OWtl`,
`57334.3f72d1ac06.js` `cY1t`, `739301.37a39f26d6.js` `Oj9r`/`Sd8U`/`GDNt`/`bgok`)
are byte-identical to the macOS scratch asar. Matching filenames and bytes are
not a Windows hashed profile. Factory-bounded discovery against that extended
inventory with `platform: win32` is bytes-verified `hashed-chat` **rejected**,
fingerprint `9ddb828e56832a34`: the only issue is `wrong-platform`
`["26.1106.51428"]` (expected reviewed-support rejection;
`hashedVoiceProfileSupported` remains darwin-only). Duplicate `oWM3` copies
digest `d899da24efbef7c5` and collapse; darwin candidate fingerprint
`6b8b598d03a2fb43` is structural only. `OWtl`/`Oj9r`/`Sd8U` own `AppScope`/`RouteScope`/
`ComposerScope`. Idle CDP peek on PID **22472** / CDP **18765**: `pageCount=1`
is not Chat compositor ready (Chat composer 0, Work composer 1); hashed runtime
script is loaded; `req.e`/`m`/`c` are not window globals. Do not `import()`
those chunks during splash. Do not drop the production skip.

Launch isolated Desktop through the interactive session; a session-0 Host
using production data can lock the Mapping Store. Isolated Host `--data` must
not be `~\.codexhost`. The macOS exact-version exception does not qualify the
Windows Store build.

This is not a Live Voice qualification of 26.1106. Voice pins stay in
[cpa-live-voice-desktop-hook.md](cpa-live-voice-desktop-hook.md).
macOS production remains [26.1027.61615](macos-desktop-pin-daily-driver.md).

## Windows delivery acceptance

Windows delivery acceptance is automated build, launch, and shortcut smoke on
the daily driver. Attended Windows Chat, Codex, and Grok speech, microphone,
and task checks are deferred at Karl's request. They are not blockers for this
delivery and stay **UNVERIFIED**. Isolated `Runtime.enable` is attachment-only
and does not qualify voice.

The installed native identity is product **0.18.0-0** under
`%LOCALAPPDATA%\Programs\codexhost`. Desktop and Start Menu `codexhost.lnk`
shortcuts target `bin\codexhost-start.exe` with working directory the install
root (`{app}`). Console uses the same stub with `--console`. Interactive
session-1 Start Menu launch is the smoke path; session-0 SSH is not.

2026-11-15 `msi-1` delivery keeps original verified Desktop process ownership
and the Windows **90s** Host-chain wait. Speculative unique-root adoption is
removed. AppX `DisableDebugging` not-found is already-cleared; a persistent
cleanup failure logs `codexhost: AppX debug registration remained after
Desktop start (0x…)` and does not terminate Desktop.

- Native checks (cached deps/toolchain): rustc **1.97.1**, MSVC `link.exe`
  **14.44.35207**, platform `treats_missing_debug_registration` and
  `debug_cleanup_warning_is_sanitized` passed, launcher `host_chain` 2 passed
  on Windows (`host_chain_ready_timeout_is_longer_on_windows`,
  `host_chain_stays_on_the_launched_process_snapshot`; macOS also ran
  `host_chain_does_not_adopt_another_live_root`),
  `production_launcher_uses_the_three_state_running_desktop_flow` passed,
  `npm run release:package -- --target windows-x64` Successful compile.
  Frozen macOS renderer dist was not rebuilt.
- Installer
  `C:\build\src\build\release\0.18.0-0\windows-x64\codexhost-0.18.0-0-windows-x64.exe`
  sha256 `14291805022a0f3054dfb529393de84b69d9fbb761a349b59d06ab9b2b1c5870`
  (36756043 bytes). First replace aborted on in-use `codexhost.exe` (Inno
  `/NOCLOSEAPPLICATIONS`). After stopping owned install + previous Store
  smoke processes, Inno logged `Installation process succeeded`.
- Backup before that replace:
  `%LOCALAPPDATA%\.codexhost\install-backups\local-app-build-20261115T002600Z`.
- Installed fingerprints equal payload: launcher
  `45eac9d38e4311fae22cbb04dc0ab6dac09695e8684b3bc8d93fecfdcd721dac`, start
  `16620bcd46637c4df97ae6f9f579dc04012b5a3bb86987a02b17e704637603e9`, shim
  `bd2b04cb4ed2046f279122b7abc65d2a14153f8c0a6fde0673de9a7689e76b82`.
- Session-1 Start Menu smoke **ready**: launcher **4724**, unique Store root
  **24152** (parent **4724**) title ChatGPT, Shim **5500** under that root,
  Host chain ready at 6786 ms, `codexhost inspect --json`
  `runtime.running=true` (stable ~20 s later, 9 Desktop process IDs). Desktop
  identity is OpenAI.Codex **26.1111.21308 / 26.1111.2228.0**.
- zzapi-mes node **6672** was left running. Isolated 26.1106 leftovers remain
  stopped. User `.codex` credentials were not copied or rewritten.

Shortcut startup is ready when Store **OpenAI.Codex** is the unique
installation root, the Host chain is Shim plus bundled Node under the install
root, and `codexhost inspect --json` reports `runtime.running`. Production
injection skip on 26.1106 remains in source; 26.1111 is not skipped. Missing
`experimental_realtime_*` is recorded, not rewritten. `reviewedEvidence` stays
empty.

Voice dist identity is not part of `test:typescript`. Linux CI and
`npm run test:voice-dist-artifacts` use `tests/vitest.voice-dist.config.js`
after a Renderer build. The shared Vitest config excludes
`tests/release/**/*.dist.test.mjs` even when that file is named on the CLI.
macOS live dist was not rebuilt for this entry-point fix. Owned `C:\build`
scheduled build/smoke tasks are removed after identity checks; the daily
driver and unrelated zzapi-mes remain.
