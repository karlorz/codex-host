export const CPA_LIVE_VOICE_HOOK_GLOBAL = "__codexhostCpaLiveVoiceHookV1";
export const ISOLATED_VOICE_PATHS = ["chat", "work-codex", "work-grok"] as const;
export const ISOLATED_DESKTOP_PLATFORMS = ["darwin", "win32", "linux"] as const;
export const PRODUCTION_DESKTOP_APP_PATH = "/Applications/ChatGPT.app";
const PRODUCTION_WINDOWS_APPX_PATH = /(?:^|[\\/])WindowsApps[\\/]OpenAI\.(?:Codex|ChatGPT)_/i;

export function isProductionDesktopAppPath(appPath: string | undefined): boolean {
  if (typeof appPath !== "string" || appPath.length === 0) return false;
  if (appPath === PRODUCTION_DESKTOP_APP_PATH) return true;
  return PRODUCTION_WINDOWS_APPX_PATH.test(appPath);
}

type RecordValue = Record<string, unknown>;
export type IsolatedVoicePath = (typeof ISOLATED_VOICE_PATHS)[number];
export type IsolatedDesktopPlatform = (typeof ISOLATED_DESKTOP_PLATFORMS)[number];

export interface IsolatedVoiceQualification {
  path?: IsolatedVoicePath;
  paths?: IsolatedVoicePath[];
  run: string;
  expiresAt: string;
  desktopVersion: string;
  desktopBuild: string;
  desktopPlatform: IsolatedDesktopPlatform;
  asarDigest: string;
  appPath: string;
  implementationRevision: string;
  label: "unqualified-isolated";
}

export interface CpaLiveVoiceHookConfig {
  enabled: boolean;
  auditedDesktopVersion: string;
  auditedAppInitialAsset: string;
  desktopVersion?: string;
  desktopPlatform?: string;
  desktopBuild?: string;
  asarDigest?: string;
  desktopAppPath?: string;
  implementationRevision?: string;
  voiceEvidence?: unknown[];
  isolatedQualification?: IsolatedVoiceQualification;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

export function readCpaLiveVoiceHookConfig(globalObject: object): CpaLiveVoiceHookConfig | null {
  const value = (globalObject as Record<string, unknown>)[CPA_LIVE_VOICE_HOOK_GLOBAL];
  if (!isRecord(value) || value.enabled !== true) return null;
  if (
    typeof value.auditedDesktopVersion !== "string" ||
    typeof value.auditedAppInitialAsset !== "string"
  ) {
    return null;
  }
  return {
    enabled: true,
    auditedDesktopVersion: value.auditedDesktopVersion,
    auditedAppInitialAsset: value.auditedAppInitialAsset,
    ...(typeof value.desktopPlatform === "string"
      ? { desktopPlatform: value.desktopPlatform }
      : {}),
    ...(typeof value.desktopVersion === "string" ? { desktopVersion: value.desktopVersion } : {}),
    ...(typeof value.desktopBuild === "string" ? { desktopBuild: value.desktopBuild } : {}),
    ...(typeof value.asarDigest === "string" ? { asarDigest: value.asarDigest } : {}),
    ...(typeof value.implementationRevision === "string"
      ? { implementationRevision: value.implementationRevision }
      : {}),
    ...(typeof value.desktopAppPath === "string" ? { desktopAppPath: value.desktopAppPath } : {}),
    ...(Array.isArray(value.voiceEvidence) ? { voiceEvidence: value.voiceEvidence } : {}),
    ...(isIsolatedVoiceQualification(value.isolatedQualification)
      ? { isolatedQualification: value.isolatedQualification }
      : {}),
  };
}

export function isIsolatedVoicePath(value: unknown): value is IsolatedVoicePath {
  return value === "chat" || value === "work-codex" || value === "work-grok";
}

export function isIsolatedDesktopPlatform(value: unknown): value is IsolatedDesktopPlatform {
  return value === "darwin" || value === "win32" || value === "linux";
}

/** Finite parseable expiry. Unparseable strings are not treated as future dates. */
export function isolatedQualificationExpiresAtMs(expiresAt: unknown): number | undefined {
  if (typeof expiresAt !== "string" || expiresAt.length === 0) return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Explicit `paths` must be a nonempty array of distinct known paths.
 * Malformed `paths` does not fall back to legacy `path`. Keep in sync with
 * `packages/desktop-control/src/cpa-live-voice-hook.ts`.
 */
export function isolatedQualificationPathSet(value: unknown): IsolatedVoicePath[] | undefined {
  if (!isRecord(value)) return undefined;
  const pathsPresent = value.paths !== undefined;
  const pathPresent = value.path !== undefined;
  let listed: IsolatedVoicePath[] | undefined;
  if (pathsPresent) {
    if (!Array.isArray(value.paths) || value.paths.length === 0) return undefined;
    if (value.paths.some((path) => !isIsolatedVoicePath(path))) return undefined;
    if (new Set(value.paths).size !== value.paths.length) return undefined;
    listed = ISOLATED_VOICE_PATHS.filter((path) => (value.paths as unknown[]).includes(path));
    if (listed.length !== value.paths.length) return undefined;
  } else if (pathPresent) {
    if (!isIsolatedVoicePath(value.path)) return undefined;
    listed = [value.path];
  } else {
    return undefined;
  }
  if (pathPresent) {
    if (!isIsolatedVoicePath(value.path) || !listed.includes(value.path)) return undefined;
  }
  return listed;
}

/** Explicit candidate paths for one isolated run. Single `path` stays valid. */
export function isolatedQualificationPaths(
  isolated: Pick<IsolatedVoiceQualification, "path" | "paths">,
): IsolatedVoicePath[] {
  return isolatedQualificationPathSet(isolated) ?? [];
}

export function isIsolatedVoiceQualification(
  value: unknown,
  now: number = Date.now(),
): value is IsolatedVoiceQualification {
  if (!isRecord(value)) return false;
  const paths = isolatedQualificationPathSet(value);
  if (!paths || paths.length === 0) return false;
  if (typeof value.appPath === "string" && isProductionDesktopAppPath(value.appPath)) return false;
  const expiresAtMs = isolatedQualificationExpiresAtMs(value.expiresAt);
  if (expiresAtMs === undefined || expiresAtMs <= now) return false;
  return (
    typeof value.run === "string" &&
    value.run.length > 0 &&
    isIsolatedDesktopPlatform(value.desktopPlatform) &&
    typeof value.desktopVersion === "string" &&
    typeof value.desktopBuild === "string" &&
    typeof value.asarDigest === "string" &&
    typeof value.appPath === "string" &&
    typeof value.implementationRevision === "string" &&
    value.label === "unqualified-isolated"
  );
}

export function auditedAppInitialAssetPresent(
  resourceNames: readonly string[],
  asset: string,
): boolean {
  return resourceNames.some((name) => {
    try {
      const url = new URL(name, "app://-/");
      return url.protocol === "app:" && url.hostname === "-" && url.pathname === `/assets/${asset}`;
    } catch {
      return false;
    }
  });
}

function resourceNamesFromPerformance(
  source:
    (Pick<Performance, "getEntriesByType"> & { getEntries?(): PerformanceEntry[] }) | undefined,
): string[] {
  const target = source ?? (typeof performance === "undefined" ? undefined : performance);
  if (!target) return [];
  const names: string[] = [];
  const push = (name: unknown) => {
    if (typeof name === "string" && name) names.push(name);
  };
  if (typeof target.getEntries === "function") {
    for (const entry of target.getEntries()) push(entry.name);
  } else if (typeof target.getEntriesByType === "function") {
    for (const entry of target.getEntriesByType("resource")) push(entry.name);
  }
  return names;
}

/** Every loaded asset name this page exposes: resource timing plus script/link tags. */
export function loadedAssetNames(
  root: ParentNode | undefined,
  performanceSource?: Pick<Performance, "getEntriesByType"> & { getEntries?(): PerformanceEntry[] },
): string[] {
  const names = resourceNamesFromPerformance(performanceSource);
  if (!root || !("querySelectorAll" in root)) return names;
  for (const element of root.querySelectorAll(
    'script[src], link[href], link[rel="modulepreload"], link[rel="preload"]',
  )) {
    const value = element.getAttribute("src") ?? element.getAttribute("href");
    if (value) names.push(value);
  }
  return names;
}
