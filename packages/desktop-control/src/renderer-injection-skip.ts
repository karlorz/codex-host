/** Desktop builds guarded against Renderer injection hangs. */

const SKIPPED_RENDERER_DESKTOP_PREFIXES = ["26.1106.", "26.1103."] as const;

export function rendererInjectionSkipReason(
  desktopVersion: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const version = desktopVersion?.trim();
  if (!version) return null;
  if (platform === "darwin" && version === "26.1106.51428") return null;
  if (!SKIPPED_RENDERER_DESKTOP_PREFIXES.some((prefix) => version.startsWith(prefix))) return null;
  return `Desktop ${version} is skipped; Renderer injection is disabled.`;
}
