/** Product versions whose Renderer injection hangs Desktop. */

const SKIPPED_RENDERER_DESKTOP_PREFIXES = ["26.1106.", "26.1103."] as const;

export function rendererInjectionSkipReason(desktopVersion: string | undefined): string | null {
  const version = desktopVersion?.trim();
  if (!version) return null;
  if (!SKIPPED_RENDERER_DESKTOP_PREFIXES.some((prefix) => version.startsWith(prefix))) return null;
  return `Desktop ${version} is skipped; Renderer injection is disabled.`;
}
