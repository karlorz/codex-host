/** Codex Desktop Renderer documents that may own the Host voice binding. */

export function parseCodexAppUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "app:" && url.hostname === "-" ? url : null;
  } catch {
    return null;
  }
}

export function isPrimaryRendererUrl(value: string): boolean {
  const url = parseCodexAppUrl(value);
  return url !== null && url.pathname === "/index.html" && url.search === "" && url.hash === "";
}

export function isAvatarOverlayRendererUrl(value: string): boolean {
  const url = parseCodexAppUrl(value);
  if (!url) return false;
  if (url.pathname === "/avatar-overlay.html") return true;
  return (
    url.pathname === "/index.html" && url.searchParams.get("initialRoute") === "/avatar-overlay"
  );
}

/** Primary `app://-/index.html` or Compact Voice overlay. Foreign app hosts/paths are not eligible. */
export function isEligibleVoiceHostUrl(value: string): boolean {
  return isPrimaryRendererUrl(value) || isAvatarOverlayRendererUrl(value);
}

/** Browser expression matching {@link isEligibleVoiceHostUrl} plus top-level frame. */
export function rendererVoiceHostDocumentGuardExpression(): string {
  return `(function(){try{
    if (window.top !== window) return false;
    var url = new URL(location.href);
    if (url.protocol !== "app:" || url.hostname !== "-") return false;
    if (url.pathname === "/avatar-overlay.html") return true;
    if (url.pathname !== "/index.html") return false;
    if (url.search === "" && url.hash === "") return true;
    return url.searchParams.get("initialRoute") === "/avatar-overlay";
  }catch(e){return false;}})()`;
}
