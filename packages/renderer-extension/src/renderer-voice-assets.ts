import { auditedAppInitialAssetPresent } from "./renderer-cpa-live-voice-hook.js";

interface VoiceAssets {
  version: string;
  platform: string;
  initial: string;
  shared: string;
}

export function supportsVoiceVersion(profiles: readonly VoiceAssets[], version?: string): boolean {
  return version === undefined || profiles.some((profile) => profile.version === version);
}

/** Select an audited pair, or import its pinned initial module when Desktop
 * exposes only the shared preload. Conflicting assets remain authoritative.
 */
export function selectVoiceAssets<T extends VoiceAssets>(
  profiles: readonly T[],
  names: readonly string[],
  version?: string,
  platform?: string,
): T | undefined {
  const present = profiles.filter((profile) =>
    [profile.initial, profile.shared].some((asset) => auditedAppInitialAssetPresent(names, asset)),
  );
  const matchesMetadata = (profile: T) =>
    (version === undefined || profile.version === version) &&
    (platform === undefined || profile.platform === platform);
  if (present.length > 0) {
    const profile = present.length === 1 ? present[0] : undefined;
    if (!profile || !matchesMetadata(profile)) return undefined;
    const initialPresent = auditedAppInitialAssetPresent(names, profile.initial);
    const sharedPresent = auditedAppInitialAssetPresent(names, profile.shared);
    return sharedPresent && (initialPresent || (version !== undefined && platform !== undefined))
      ? profile
      : undefined;
  }
  if (version === undefined) return undefined;
  const candidates = profiles.filter(matchesMetadata);
  return candidates.length === 1 ? candidates[0] : undefined;
}
