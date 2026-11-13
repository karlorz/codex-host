# Windows daily Desktop pin

Windows Store ChatGPT/Codex is a separate product from macOS Sparkle
`/Applications/ChatGPT.app`. Keep the Windows daily driver on Store
**26.1106**; do not take a later Store build until it is separately pinned.

## Daily driver

The Windows daily driver is Store package **OpenAI.ChatGPT** MSIX
**26.1106.6628.0**, product **26.1106.51428**. Installer:

`https://persistent.oaistatic.com/codex-app-prod/releases/26.1106.6628.0/ChatGPT-x64.msix`

`winget pin add --id OpenAI.ChatGPT --version 26.1106.6628.0` gates later
winget upgrades only. It does not stop Microsoft Store.

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

This is not a Live Voice qualification of 26.1106. Voice pins stay in
[cpa-live-voice-desktop-hook.md](cpa-live-voice-desktop-hook.md).
macOS production remains [26.1027.61615](macos-desktop-pin-daily-driver.md).
