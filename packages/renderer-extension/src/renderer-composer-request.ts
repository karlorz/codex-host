// Adapted from karlorz/codex-host@07d8f010ae2e969007c611e035e49f3310b73a9d,
// packages/renderer-extension/src/renderer-composer-request.ts (LGPL-3.0-only).
/** Native question/approval inputs and actions are not chat submission controls. */
export const NATIVE_COMPOSER_REQUEST_ATTRIBUTES = [
  "data-codex-composer-request-navigation",
  "data-codex-composer-request",
] as const;
const NATIVE_REQUEST_SELECTOR = NATIVE_COMPOSER_REQUEST_ATTRIBUTES.map(
  (attribute) => `[${attribute}]`,
).join(", ");
const COMPOSER_ROOT_SELECTOR = "[data-codex-composer-root]";
export const SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE = "data-codexhost-shared-question-cover";
const COVER_STYLE_ID = "codexhost-shared-question-cover-style";
const COVER_CSS = `[${SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE}]{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important;opacity:0!important;pointer-events:none!important}`;

export function isNativeComposerRequest(element: Element): boolean {
  return element.closest(NATIVE_REQUEST_SELECTOR) !== null;
}

/** Suspend chat controls for the whole root until the native request surface closes. */
export function hasNativeComposerRequest(composer: Element): boolean {
  return (
    isNativeComposerRequest(composer) || composer.querySelector(NATIVE_REQUEST_SELECTOR) !== null
  );
}

function nativeRequestElements(composer: Element): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const add = (node: Element | null | undefined) => {
    if (!(node instanceof HTMLElement) || seen.has(node)) return;
    if (!node.matches(NATIVE_REQUEST_SELECTOR)) return;
    // Clipping the Composer shell collapses the input bar on every cover.
    if (node.matches(COMPOSER_ROOT_SELECTOR)) return;
    seen.add(node);
    nodes.push(node);
  };
  const addTree = (root: Element) => {
    add(root);
    for (const node of root.querySelectorAll(NATIVE_REQUEST_SELECTOR)) add(node);
  };
  addTree(composer);
  let sibling = composer.previousElementSibling;
  while (sibling) {
    if (sibling.matches(COMPOSER_ROOT_SELECTOR)) break;
    addTree(sibling);
    sibling = sibling.previousElementSibling;
  }
  const parent = composer.parentElement;
  if (parent) {
    for (const node of parent.querySelectorAll(NATIVE_REQUEST_SELECTOR)) {
      if (!(node instanceof HTMLElement) || node.contains(composer)) continue;
      const other = node.closest(COMPOSER_ROOT_SELECTOR);
      if (other && other !== composer) continue;
      add(node);
    }
  }
  return nodes;
}

/** Desktop may park the native card beside the Composer, not only inside it. */
export function hasNearbyNativeComposerRequest(composer: Element): boolean {
  return hasNativeComposerRequest(composer) || nativeRequestElements(composer).length > 0;
}

function ensureCoverStyle(document: Document): void {
  if (document.getElementById(COVER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = COVER_STYLE_ID;
  style.textContent = COVER_CSS;
  (document.head ?? document.documentElement).append(style);
}

/** Cover Desktop's native question card so the shared in-chat card stays the answer UI. */
export function coverNativeComposerRequest(composer: Element): void {
  ensureCoverStyle(composer.ownerDocument);
  const wanted = new Set(nativeRequestElements(composer));
  for (const node of composer.ownerDocument.querySelectorAll(
    `[${SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE}]`,
  )) {
    if (!(node instanceof HTMLElement)) continue;
    if (!wanted.has(node)) node.removeAttribute(SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE);
  }
  for (const node of wanted) {
    if (!node.hasAttribute(SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE)) {
      node.setAttribute(SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE, "");
    }
  }
}

export function uncoverNativeComposerRequest(root: ParentNode): void {
  for (const node of root.querySelectorAll(`[${SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE}]`)) {
    if (!(node instanceof HTMLElement)) continue;
    node.removeAttribute(SHARED_QUESTION_NATIVE_COVER_ATTRIBUTE);
  }
}
