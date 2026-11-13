import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { readLiveVoiceInjectFile } from "./live-voice-inject.js";

export const CPA_LIVE_VOICE_ENV = "CODEXHOST_CPA_LIVE_VOICE";
export const CPA_LIVE_VOICE_HOOK_GLOBAL = "__codexhostCpaLiveVoiceHookV1";
export const AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION = "26.1007.30912";
export const AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET = "app-initial-6350d04672d0.js";
export const DESKTOP_VERSION_ENV = "CODEXHOST_DESKTOP_VERSION";

/** Overlay CDP injection is for Work/Chat pins plus macOS 26.1106.51428 hashed
 * webpack voice wrap. Unqualified Desktops keep native avatar-overlay voice.
 * Overlay `Runtime.enable` runs once per overlay target; later ticks reuse
 * that CDP session so they do not race Desktop's compact Voice Chat starter.
 * 26.1106.51428 current-document injection uses overlay-voice-bootstrap.js,
 * not the full overlay hook IIFE.
 */
export const HASHED_WEBPACK_OVERLAY_VOICE_DESKTOP_VERSION = "26.1106.51428";
const OVERLAY_VOICE_HOOK_DESKTOP_VERSIONS = [
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  "26.1016.61520",
  "26.1016.62342",
  "26.1021.31345",
  "26.1023.51421",
  "26.1027.30824",
  "26.1027.61615",
  HASHED_WEBPACK_OVERLAY_VOICE_DESKTOP_VERSION,
] as const;

/** Compact Voice Chat on this Desktop evaluates the small overlay bootstrap. */
export function overlayVoiceBootstrapPreferred(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[DESKTOP_VERSION_ENV]?.trim() === HASHED_WEBPACK_OVERLAY_VOICE_DESKTOP_VERSION;
}

/** Process env wins for one launch. Otherwise the ~/.codexhost inject file (default on). */
export function cpaLiveVoiceHookEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[CPA_LIVE_VOICE_ENV];
  if (value === "0") return false;
  if (value === "1") return true;
  return readLiveVoiceInjectFile(environment);
}

/** Sparkle/CFBundle short version, e.g. 26.1021.31345. Env wins. */
export function detectInstalledDesktopVersion(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = environment[DESKTOP_VERSION_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== "darwin") return undefined;
  const home = environment.HOME?.trim() || os.homedir();
  const apps = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    path.join(home, "Applications/ChatGPT.app"),
    path.join(home, "Applications/Codex.app"),
  ];
  for (const app of apps) {
    const plist = path.join(app, "Contents/Info.plist");
    if (!existsSync(plist)) continue;
    try {
      const version = execFileSync(
        "/usr/bin/defaults",
        ["read", plist, "CFBundleShortVersionString"],
        {
          encoding: "utf8",
          timeout: 2000,
        },
      ).trim();
      if (version) return version;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Overlay hook CDP is skipped when the launcher supplied an unqualified Desktop. */
export function cpaLiveVoiceOverlayHookAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!cpaLiveVoiceHookEnabled(environment)) return false;
  const version = environment[DESKTOP_VERSION_ENV]?.trim();
  if (!version) return true;
  return OVERLAY_VOICE_HOOK_DESKTOP_VERSIONS.some((pin) => pin === version);
}

export function cpaLiveVoiceHookBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
  desktopVersion?: string,
): string {
  if (!cpaLiveVoiceHookEnabled(environment)) return "";
  const version =
    environment[DESKTOP_VERSION_ENV]?.trim() ||
    desktopVersion ||
    detectInstalledDesktopVersion(environment);
  return `globalThis.${CPA_LIVE_VOICE_HOOK_GLOBAL} = Object.freeze(${JSON.stringify({
    enabled: true,
    desktopPlatform: process.platform,
    auditedDesktopVersion: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
    auditedAppInitialAsset: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
    ...(version ? { desktopVersion: version } : {}),
  })});\n`;
}
