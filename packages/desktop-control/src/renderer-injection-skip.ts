import {
  isolatedQualificationMatchesRuntime,
  isIsolatedVoiceQualification,
  isProductionDesktopAppPath,
  type IsolatedVoiceQualificationFile,
} from "./cpa-live-voice-hook.js";

const SKIPPED_DESKTOP_VERSION_PREFIXES = ["26.1103.", "26.1106."] as const;
const HASHED_RENDERER_CANDIDATE_VERSION = "26.1106.51428";

export type RendererInjectionSkipIdentity = {
  desktopPlatform?: string;
  desktopVersion?: string;
  desktopBuild?: string;
  asarDigest?: string;
  appPath?: string;
  implementationRevision?: string;
};

export type RendererInjectionSkipOptions = {
  isolated?: IsolatedVoiceQualificationFile;
  identity?: RendererInjectionSkipIdentity;
};

export function rendererInjectionSkipReason(
  desktopVersion: string | undefined,
  platform: NodeJS.Platform = process.platform,
  options?: RendererInjectionSkipOptions,
): string | null {
  const version = desktopVersion?.trim();
  if (!version) return null;
  if (platform === "darwin" && version === HASHED_RENDERER_CANDIDATE_VERSION) return null;
  if (SKIPPED_DESKTOP_VERSION_PREFIXES.some((prefix) => version.startsWith(prefix))) {
    if (allowsIsolatedHashedInjection(version, platform, options)) return null;
    return `Desktop ${version} is skipped until hashed Renderer bindings are requalified`;
  }
  return null;
}

function suppliedIdentityConflicts(
  version: string,
  platform: NodeJS.Platform,
  identity: RendererInjectionSkipIdentity | undefined,
): boolean {
  if (!identity) return false;
  if (identity.desktopPlatform !== undefined && identity.desktopPlatform !== platform) return true;
  if (identity.desktopVersion !== undefined && identity.desktopVersion.trim() !== version) {
    return true;
  }
  return false;
}

function allowsIsolatedHashedInjection(
  version: string,
  platform: NodeJS.Platform,
  options: RendererInjectionSkipOptions | undefined,
): boolean {
  if (!options?.isolated || !options.identity) return false;
  if (suppliedIdentityConflicts(version, platform, options.identity)) return false;
  if (version !== HASHED_RENDERER_CANDIDATE_VERSION) return false;
  if (platform !== "win32") return false;
  if (!isIsolatedVoiceQualification(options.isolated)) return false;
  if (
    isProductionDesktopAppPath(options.identity.appPath) ||
    isProductionDesktopAppPath(options.isolated.appPath)
  ) {
    return false;
  }
  return isolatedQualificationMatchesRuntime(options.isolated, {
    desktopPlatform: platform,
    desktopVersion: version,
    ...(options.identity.desktopBuild ? { desktopBuild: options.identity.desktopBuild } : {}),
    ...(options.identity.asarDigest ? { asarDigest: options.identity.asarDigest } : {}),
    ...(options.identity.appPath ? { appPath: options.identity.appPath } : {}),
    ...(options.identity.implementationRevision
      ? { implementationRevision: options.identity.implementationRevision }
      : {}),
  });
}
