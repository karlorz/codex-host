export const CPA_LIVE_VOICE_HOOK_GLOBAL = "__codexhostCpaLiveVoiceHookV1";

type RecordValue = Record<string, unknown>;

export interface CpaLiveVoiceHookConfig {
  enabled: boolean;
  auditedDesktopVersion: string;
  auditedAppInitialAsset: string;
  desktopVersion?: string;
  desktopPlatform?: string;
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
  };
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
