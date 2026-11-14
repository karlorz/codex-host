const SKIPPED_DESKTOP_VERSION_PREFIXES = ["26.1103.", "26.1106."] as const;
const HASHED_MACOS_RENDERER_EXCEPTION = "26.1106.51428";

export function rendererInjectionSkipReason(
  desktopVersion: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const version = desktopVersion?.trim();
  if (!version) return null;
  if (platform === "darwin" && version === HASHED_MACOS_RENDERER_EXCEPTION) return null;
  if (SKIPPED_DESKTOP_VERSION_PREFIXES.some((prefix) => version.startsWith(prefix))) {
    return `Desktop ${version} is skipped until hashed Renderer bindings are requalified`;
  }
  return null;
}
