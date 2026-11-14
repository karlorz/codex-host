import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { readLiveVoiceInjectFile } from "./live-voice-inject.js";

export const CPA_LIVE_VOICE_ENV = "CODEXHOST_CPA_LIVE_VOICE";
export const CPA_LIVE_VOICE_HOOK_GLOBAL = "__codexhostCpaLiveVoiceHookV1";
export const AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION = "26.1007.30912";
export const AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET = "app-initial-6350d04672d0.js";
export const DESKTOP_VERSION_ENV = "CODEXHOST_DESKTOP_VERSION";
export const DESKTOP_BUILD_ENV = "CODEXHOST_DESKTOP_BUILD";
export const DESKTOP_ASAR_DIGEST_ENV = "CODEXHOST_DESKTOP_ASAR_DIGEST";
export const DESKTOP_APP_PATH_ENV = "CODEXHOST_DESKTOP_APP_PATH";
export const VOICE_ISOLATED_QUALIFICATION_FILE = "voice-isolated-qualification.json";

/** Overlay CDP injection is for Work/Chat pins plus macOS 26.1106.51428 hashed
 * webpack voice wrap. Unqualified Desktops keep native avatar-overlay voice.
 * Overlay `Runtime.enable` runs once per overlay target; later ticks reuse
 * that CDP session so they do not race Desktop's compact Voice Chat starter.
 * 26.1106.51428 current-document injection uses overlay-voice-bootstrap.js,
 * not the full overlay hook IIFE.
 */
export const HASHED_WEBPACK_OVERLAY_VOICE_DESKTOP_VERSION = "26.1106.51428";
export const OVERLAY_VOICE_HOOK_DESKTOP_VERSIONS = [
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  "26.1016.61520",
  "26.1016.62342",
  "26.1021.31345",
  "26.1023.51421",
  "26.1027.30824",
  "26.1027.61615",
  HASHED_WEBPACK_OVERLAY_VOICE_DESKTOP_VERSION,
] as const;

export type VoiceProfilePinsFile = {
  hashedVersion: string;
  overlayHookDesktopVersions: readonly string[];
};

export type VoiceQualificationFile = {
  implementationRevision: string;
  reviewedEvidence: unknown[];
};

export type IsolatedVoiceQualificationFile = {
  path: "chat" | "work-codex" | "work-grok";
  run: string;
  expiresAt: string;
  desktopVersion: string;
  desktopBuild: string;
  asarDigest: string;
  appPath: string;
  implementationRevision: string;
  label: "unqualified-isolated";
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function envNonEmpty(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[key]?.trim();
  return value ? value : undefined;
}

function isIsolatedVoiceQualificationFile(value: unknown): value is IsolatedVoiceQualificationFile {
  if (value === null || typeof value !== "object") return false;
  const parsed = value as IsolatedVoiceQualificationFile;
  return (
    (parsed.path === "chat" || parsed.path === "work-codex" || parsed.path === "work-grok") &&
    isNonEmptyString(parsed.run) &&
    isNonEmptyString(parsed.expiresAt) &&
    isNonEmptyString(parsed.desktopVersion) &&
    isNonEmptyString(parsed.desktopBuild) &&
    isNonEmptyString(parsed.asarDigest) &&
    isNonEmptyString(parsed.appPath) &&
    isNonEmptyString(parsed.implementationRevision) &&
    parsed.label === "unqualified-isolated"
  );
}

export function readVoiceProfilePins(overlayDir: string): VoiceProfilePinsFile | undefined {
  const file = path.join(overlayDir, "voice-profile-pins.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as VoiceProfilePinsFile;
    if (
      !isNonEmptyString(parsed.hashedVersion) ||
      !Array.isArray(parsed.overlayHookDesktopVersions) ||
      parsed.overlayHookDesktopVersions.some((version) => !isNonEmptyString(version))
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function readVoiceQualification(overlayDir: string): VoiceQualificationFile | undefined {
  const file = path.join(overlayDir, "voice-qualification.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as VoiceQualificationFile;
    if (
      !isNonEmptyString(parsed.implementationRevision) ||
      !Array.isArray(parsed.reviewedEvidence)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function readVoiceIsolatedQualification(
  overlayDir: string,
  now: number = Date.now(),
): IsolatedVoiceQualificationFile | undefined {
  const file = path.join(overlayDir, VOICE_ISOLATED_QUALIFICATION_FILE);
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isIsolatedVoiceQualificationFile(parsed)) return undefined;
    if (Date.parse(parsed.expiresAt) <= now) {
      try {
        unlinkSync(file);
      } catch {
        // Expired isolated files are best-effort cleanup.
      }
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Overlay-scoped isolated run marker. Never packaged and never writes reviewedEvidence. */
export function isolatedQualificationMatchesRuntime(
  isolated: IsolatedVoiceQualificationFile,
  identity: {
    desktopVersion?: string;
    desktopBuild?: string;
    asarDigest?: string;
    appPath?: string;
    implementationRevision?: string;
  },
): boolean {
  return (
    isolated.desktopVersion === identity.desktopVersion &&
    isolated.desktopBuild === identity.desktopBuild &&
    isolated.asarDigest === identity.asarDigest &&
    isolated.appPath === identity.appPath &&
    isolated.implementationRevision === identity.implementationRevision
  );
}

function overlayHookDesktopVersions(overlayDir?: string): readonly string[] {
  if (!overlayDir) return OVERLAY_VOICE_HOOK_DESKTOP_VERSIONS;
  return readVoiceProfilePins(overlayDir)?.overlayHookDesktopVersions ?? [];
}

function hashedOverlayDesktopVersion(overlayDir?: string): string {
  if (!overlayDir) return HASHED_WEBPACK_OVERLAY_VOICE_DESKTOP_VERSION;
  return readVoiceProfilePins(overlayDir)?.hashedVersion ?? "";
}

/** Compact Voice Chat on this Desktop evaluates the small overlay bootstrap. */
export function overlayVoiceBootstrapPreferred(
  environment: NodeJS.ProcessEnv = process.env,
  overlayDir?: string,
): boolean {
  return environment[DESKTOP_VERSION_ENV]?.trim() === hashedOverlayDesktopVersion(overlayDir);
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

/** Native build from launcher env, or CFBundleVersion of the launched app path only. */
export function detectInstalledDesktopBuild(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = envNonEmpty(environment, DESKTOP_BUILD_ENV);
  if (fromEnv) return fromEnv;
  const appPath = envNonEmpty(environment, DESKTOP_APP_PATH_ENV);
  if (!appPath || process.platform !== "darwin") return undefined;
  const plist = path.join(appPath, "Contents/Info.plist");
  if (!existsSync(plist)) return undefined;
  try {
    const build = execFileSync("/usr/bin/defaults", ["read", plist, "CFBundleVersion"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return build || undefined;
  } catch {
    return undefined;
  }
}

export function detectInstalledDesktopAsarDigest(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return envNonEmpty(environment, DESKTOP_ASAR_DIGEST_ENV);
}

export function detectLaunchedDesktopAppPath(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return envNonEmpty(environment, DESKTOP_APP_PATH_ENV);
}

/** Overlay hook CDP is skipped when the launcher supplied an unqualified Desktop. */
export function cpaLiveVoiceOverlayHookAllowed(
  environment: NodeJS.ProcessEnv = process.env,
  overlayDir?: string,
): boolean {
  if (!cpaLiveVoiceHookEnabled(environment)) return false;
  const version = environment[DESKTOP_VERSION_ENV]?.trim();
  if (!version) return true;
  return overlayHookDesktopVersions(overlayDir).some((pin) => pin === version);
}

export function cpaLiveVoiceHookBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
  desktopVersion?: string,
  overlayDir?: string,
): string {
  if (!cpaLiveVoiceHookEnabled(environment)) return "";
  const version =
    environment[DESKTOP_VERSION_ENV]?.trim() ||
    desktopVersion ||
    detectInstalledDesktopVersion(environment);
  const desktopBuild = detectInstalledDesktopBuild(environment);
  const asarDigest = detectInstalledDesktopAsarDigest(environment);
  const desktopAppPath = detectLaunchedDesktopAppPath(environment);
  const qualification = overlayDir ? readVoiceQualification(overlayDir) : undefined;
  const isolated = overlayDir ? readVoiceIsolatedQualification(overlayDir) : undefined;
  const isolatedQualification =
    isolated &&
    isolatedQualificationMatchesRuntime(isolated, {
      ...(version === undefined ? {} : { desktopVersion: version }),
      ...(desktopBuild === undefined ? {} : { desktopBuild }),
      ...(asarDigest === undefined ? {} : { asarDigest }),
      ...(desktopAppPath === undefined ? {} : { appPath: desktopAppPath }),
      ...(qualification === undefined
        ? {}
        : { implementationRevision: qualification.implementationRevision }),
    })
      ? isolated
      : undefined;
  return `globalThis.${CPA_LIVE_VOICE_HOOK_GLOBAL} = Object.freeze(${JSON.stringify({
    enabled: true,
    desktopPlatform: process.platform,
    auditedDesktopVersion: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
    auditedAppInitialAsset: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
    ...(version ? { desktopVersion: version } : {}),
    ...(desktopBuild ? { desktopBuild } : {}),
    ...(asarDigest ? { asarDigest } : {}),
    ...(desktopAppPath ? { desktopAppPath } : {}),
    ...(qualification
      ? {
          implementationRevision: qualification.implementationRevision,
          voiceEvidence: qualification.reviewedEvidence,
        }
      : {}),
    ...(isolatedQualification ? { isolatedQualification } : {}),
  })});\n`;
}
