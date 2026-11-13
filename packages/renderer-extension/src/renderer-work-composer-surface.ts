/** Desktop Chat/Work toggle persistence. Missing means Chat. */
export const HOME_COMPOSER_MODE_STORAGE_KEY = "home-composer-mode-v1";

function visibleWorkComposer(owner: object): boolean {
  const document = (owner as { document?: Document }).document;
  if (!document?.querySelectorAll) return false;
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect?.() ?? { width: 0 };
    return box.width > 0 && !element.closest?.("[hidden], [inert]");
  };
  return (
    [...document.querySelectorAll("[data-codex-composer-root]")].some(visible) &&
    ![...document.querySelectorAll("[data-chatgpt-composer]")].some(visible)
  );
}

function selectedWorkTab(owner: object): boolean {
  const document = (owner as { document?: Document }).document;
  if (!document?.querySelectorAll) return false;
  const controls = document.querySelectorAll("button, [role='tab'], a");
  let workSelected = false;
  let chatSelected = false;
  for (const element of controls) {
    const name = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    if (name !== "Chat" && name !== "Work") continue;
    const selected =
      element.getAttribute("aria-selected") === "true" ||
      element.getAttribute("aria-pressed") === "true" ||
      element.getAttribute("data-state") === "active" ||
      element.getAttribute("data-state") === "on";
    if (!selected) continue;
    if (name === "Work") workSelected = true;
    if (name === "Chat") chatSelected = true;
  }
  return workSelected && !chatSelected;
}

export function isWorkComposerSurface(owner: object = globalThis): boolean {
  const storage = (owner as { localStorage?: Storage }).localStorage;
  try {
    const raw = storage?.getItem(HOME_COMPOSER_MODE_STORAGE_KEY);
    if (raw != null && raw !== "") {
      let value: unknown = raw;
      if (raw.startsWith("{") || raw.startsWith('"') || raw.startsWith("[")) {
        try {
          value = JSON.parse(raw) as unknown;
        } catch {
          value = raw;
        }
      }
      if (value === "work") return true;
      if (value === "chat") return false;
    }
  } catch {
    /* Fall through to the visible Work/Chat control. */
  }
  return selectedWorkTab(owner) || visibleWorkComposer(owner);
}
