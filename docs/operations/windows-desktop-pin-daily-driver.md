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
