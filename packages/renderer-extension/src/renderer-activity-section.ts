const PANEL = "[data-summary-panel-variant]";
const OWNED = "[data-codexhost-background-activity]";

type ActivitySectionTarget =
  | { target: HTMLElement; reason: null }
  | {
      target: null;
      reason:
        | "missing-workspace"
        | "detached-composer"
        | "missing-panel"
        | "ambiguous-panel"
        | "missing-sections"
        | "ambiguous-sections";
    };

function visible(window: Window, node: HTMLElement): boolean {
  if (!node.isConnected || node.getClientRects().length === 0) return false;
  for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (ancestor.hidden || style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/** Versioned native summary structure; ambiguous ownership leaves no extension surface. */
export function activitySectionTarget(
  window: Window,
  composer: Element,
  previous: HTMLElement | null,
): ActivitySectionTarget {
  const viewport = composer.closest("[data-app-shell-main-content-layout]");
  const workspace = viewport?.parentElement;
  if (!composer.isConnected) return { target: null, reason: "detached-composer" };
  if (!workspace) return { target: null, reason: "missing-workspace" };
  const roots = Array.from(workspace.querySelectorAll<HTMLElement>(PANEL)).filter(
    (node) => node.classList.contains("group/summary-panel") && visible(window, node),
  );
  if (roots.length !== 1)
    return { target: null, reason: roots.length ? "ambiguous-panel" : "missing-panel" };
  const root = roots[0];
  if (!root) return { target: null, reason: "missing-panel" };
  const nativeSections = Array.from(root.querySelectorAll<HTMLElement>("section")).filter(
    (node) => {
      const parentSection = node.parentElement?.closest("section");
      return (
        !node.closest(OWNED) &&
        node.closest(PANEL) === root &&
        node.classList.contains("flex") &&
        node.classList.contains("flex-col") &&
        (!parentSection || parentSection === root || !root.contains(parentSection))
      );
    },
  );
  const containers = new Set(nativeSections.map((node) => node.parentElement));
  const target = nativeSections[0]?.parentElement;
  if (containers.size === 1 && target) return { target, reason: null };
  // A validated container can outlive its last native section while a Loop remains.
  if (containers.size === 0 && previous?.isConnected && previous.closest(PANEL) === root)
    return { target: previous, reason: null };
  if (containers.size === 0) {
    // Native Content retains its scroll/content wrappers before any Section exists.
    const emptyTargets = Array.from(
      root.querySelectorAll<HTMLElement>(
        ":scope > div.flex.flex-col.overflow-x-hidden.overflow-y-auto > div.flex.flex-col",
      ),
    ).filter(
      (node) => node.closest(PANEL) === root && !node.closest(OWNED) && visible(window, node),
    );
    if (emptyTargets.length === 1 && emptyTargets[0])
      return { target: emptyTargets[0], reason: null };
    if (emptyTargets.length > 1) return { target: null, reason: "ambiguous-sections" };
  }
  return { target: null, reason: containers.size ? "ambiguous-sections" : "missing-sections" };
}

export const ACTIVITY_SECTION_CLASS =
  "relative z-0 flex flex-col pb-2 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:py-2";
export const ACTIVITY_SECTION_CONTENT_CLASS =
  "flex flex-col gap-0.5 px-5 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:gap-0 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:px-4 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:group-data-[summary-panel-density=comfortable]/summary-panel:px-5";
export const ACTIVITY_SECTION_HEADING_CLASS =
  "activity-heading sticky top-2 z-10 flex h-7 w-full min-w-0 items-center justify-start gap-2 pb-0.5 text-sm font-normal text-secondary bg-surface-elevated-secondary before:bg-surface-elevated-secondary before:pointer-events-none before:absolute before:inset-x-0 before:-top-2 before:h-2 before:content-[''] ps-5 pe-3.5 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:h-6 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:group-data-[summary-panel-density=comfortable]/summary-panel:h-7 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:pb-0 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:text-dynamic-isle-row group-data-[summary-panel-variant=dynamic-isle]/summary-panel:ps-4 group-data-[summary-panel-variant=dynamic-isle]/summary-panel:group-data-[summary-panel-density=comfortable]/summary-panel:ps-5";
export const ACTIVITY_SECTION_TOGGLE_CLASS =
  "group/section-toggle -ms-[3.5px] inline-flex min-w-0 flex-1 cursor-interaction items-center gap-1 rounded-xl py-0.5 ps-[3.5px] pe-1 text-start focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring";
export const ACTIVITY_SECTION_LABEL_CLASS =
  "activity-title min-w-0 flex-1 text-sm group-data-[summary-panel-variant=dynamic-isle]/summary-panel:text-dynamic-isle-row";
