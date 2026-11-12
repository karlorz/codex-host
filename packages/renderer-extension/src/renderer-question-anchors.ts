import {
  TRANSCRIPT_ITEM_IDS_ATTRIBUTE,
  TRANSCRIPT_ITEM_SELECTOR,
  TRANSCRIPT_TURN_KEY_ATTRIBUTE,
} from "./renderer-transcript-dom.js";

/** Holds answered cards in the transcript: working column while the turn is open, then the visible reply. */
export const QUESTION_HISTORY_SLOT_ATTRIBUTE = "data-codexhost-question-history";

export function transcriptItemContractPresent(root: ParentNode): boolean {
  return root.querySelector(TRANSCRIPT_ITEM_SELECTOR) !== null;
}

export function elementIsDisplayed(node: Element): boolean {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function itemIds(node: Element): string[] {
  return (node.getAttribute(TRANSCRIPT_ITEM_IDS_ATTRIBUTE) ?? "")
    .split(/\s+/)
    .filter((entry) => entry.length > 0);
}

export function findTranscriptItem(root: ParentNode, itemId: string): Element | null {
  for (const node of root.querySelectorAll(TRANSCRIPT_ITEM_SELECTOR)) {
    if (itemIds(node).includes(itemId)) return node;
  }
  return null;
}

export function findDisplayedTranscriptItem(root: ParentNode, itemId: string): Element | null {
  const row = findTranscriptItem(root, itemId);
  return row && elementIsDisplayed(row) ? row : null;
}

export function findTranscriptTurn(root: ParentNode, turnId: string): Element | null {
  for (const node of root.querySelectorAll(`[${TRANSCRIPT_TURN_KEY_ATTRIBUTE}]`)) {
    if (node.getAttribute(TRANSCRIPT_TURN_KEY_ATTRIBUTE) === turnId) return node;
  }
  return null;
}

function nonemptyText(node: Element): boolean {
  return (node.textContent ?? "").trim().length > 0;
}

function isFoldControl(node: Element): boolean {
  return node.getAttribute("aria-expanded") !== null;
}

function firstDisplayedChildAwayFrom(container: Element, hiddenRow: Element): Element | null {
  for (const child of container.children) {
    if (!elementIsDisplayed(child) || !nonemptyText(child) || isFoldControl(child)) continue;
    if (child === hiddenRow || child.contains(hiddenRow)) continue;
    return child;
  }
  return null;
}

function nextDisplayedSibling(
  parent: Element,
  node: Element,
  hiddenRow: Element | null,
): Element | null {
  let passed = false;
  for (const child of parent.children) {
    if (child === node) {
      passed = true;
      continue;
    }
    if (!passed) continue;
    if (!elementIsDisplayed(child) || !nonemptyText(child) || isFoldControl(child)) continue;
    if (hiddenRow && (child === hiddenRow || child.contains(hiddenRow))) {
      const nested = firstDisplayedChildAwayFrom(child, hiddenRow);
      if (nested) return nested;
      continue;
    }
    return child;
  }
  return null;
}

function walkForward(start: Element, turn: Element, hiddenRow: Element | null): Element | null {
  let node: Element | null = start;
  while (node && node !== turn && node.parentElement) {
    const parent: Element = node.parentElement;
    const found = nextDisplayedSibling(parent, node, hiddenRow);
    if (found) return found;
    node = parent;
  }
  return null;
}

function isTurnProgressControl(node: Element): boolean {
  if (node.getAttribute("aria-expanded") !== null) return true;
  const text = (node.textContent ?? "").trim();
  return /^(Working for|Worked for|Thinking)\b/i.test(text);
}

/** Visible working/fold column so a record can stay on screen before any reply exists. */
export function findWorkingColumn(turn: Element): Element | null {
  for (const control of turn.querySelectorAll("button")) {
    if (!elementIsDisplayed(control) || !isTurnProgressControl(control)) continue;
    let node: Element = control;
    while (node.parentElement && node.parentElement !== turn) {
      const parent: Element = node.parentElement;
      let hasEarlier = false;
      for (const child of parent.children) {
        if (child === node) break;
        if (elementIsDisplayed(child) && nonemptyText(child) && !isFoldControl(child)) {
          hasEarlier = true;
          break;
        }
      }
      if (hasEarlier && elementIsDisplayed(node)) return node;
      node = parent;
    }
    if (elementIsDisplayed(node)) return node;
  }
  return elementIsDisplayed(turn) ? turn : null;
}

/** Visible reply that remains after Desktop folds thinking and tool rows. */
export function findVisibleReplyColumn(turn: Element, hiddenRow: Element | null): Element | null {
  if (hiddenRow) {
    const beside = walkForward(hiddenRow, turn, hiddenRow);
    if (beside) return beside;
  }
  for (const fold of turn.querySelectorAll("button[aria-expanded]")) {
    if (!elementIsDisplayed(fold)) continue;
    const found = walkForward(fold, turn, hiddenRow);
    if (found) return found;
  }
  const items = [...turn.querySelectorAll(TRANSCRIPT_ITEM_SELECTOR)].filter(
    (el) => el !== hiddenRow && elementIsDisplayed(el),
  );
  return items.at(-1) ?? null;
}

export function findVisibleHistoryMount(
  root: ParentNode,
  itemId: string,
  turnId: string,
): Element | null {
  const row = findTranscriptItem(root, itemId);
  const turn =
    findTranscriptTurn(root, turnId) ?? row?.closest(`[${TRANSCRIPT_TURN_KEY_ATTRIBUTE}]`);
  const reply = turn ? findVisibleReplyColumn(turn, row) : null;
  if (reply) return reply;
  if (row && elementIsDisplayed(row)) return row;
  return turn ? findWorkingColumn(turn) : null;
}

export function historyMountIsItemRow(mount: Element, itemId: string): boolean {
  return itemIds(mount).includes(itemId);
}

function isFlexRow(node: Element): boolean {
  const style = getComputedStyle(node);
  return (
    (style.display === "flex" || style.display === "inline-flex") &&
    (style.flexDirection === "row" || style.flexDirection === "row-reverse")
  );
}

function childrenLaidOutInRow(parent: Element): boolean {
  const kids = [...parent.children].filter((el) => elementIsDisplayed(el));
  for (let i = 0; i < kids.length; i++) {
    for (let j = i + 1; j < kids.length; j++) {
      const left = kids[i];
      const right = kids[j];
      if (!left || !right) continue;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      const separateX = a.right <= b.left + 1 || b.right <= a.left + 1;
      const overlapY = a.top < b.bottom - 4 && b.top < a.bottom - 4;
      if (separateX && overlapY) return true;
    }
  }
  return false;
}

function containingBlockWidth(mount: Element): number {
  let node = mount.parentElement;
  while (node) {
    const width = node.getBoundingClientRect().width;
    if (width > 0 && getComputedStyle(node).display !== "contents") return width;
    node = node.parentElement;
  }
  return 0;
}

function isHorizontalLayout(node: Element): boolean {
  const style = getComputedStyle(node);
  if (style.display === "contents") return false;
  return isFlexRow(node) || childrenLaidOutInRow(node);
}

/** Highest node a history slot may join: the turn, or the item row when no turn is present. */
export function questionHistorySlotCeiling(mount: Element): Element {
  return (
    mount.closest(`[${TRANSCRIPT_TURN_KEY_ATTRIBUTE}]`) ??
    mount.closest(TRANSCRIPT_ITEM_SELECTOR) ??
    mount
  );
}

function insertBeforeSafe(parent: Element, node: Node, before: Element | null): void {
  try {
    if (before && before.parentNode === parent) parent.insertBefore(node, before);
    else parent.append(node);
  } catch {
    try {
      parent.append(node);
    } catch {
      return;
    }
  }
}

/** Full-width stack host when the reply sits in a row beside a still-open tool column. */
function rowStackInsert(mount: Element): { parent: Element; before: Element } | null {
  const ceiling = questionHistorySlotCeiling(mount);
  if (mount === ceiling) return null;
  const full = containingBlockWidth(mount);
  const mountWidth = mount.getBoundingClientRect().width;
  const parent = mount.parentElement;
  if (!parent || !ceiling.contains(parent)) return null;
  const needsLift =
    isFlexRow(mount) ||
    Boolean(isHorizontalLayout(parent)) ||
    (full > 0 && mountWidth < full * 0.7);
  if (!needsLift) return null;

  let before: Element = mount;
  let host: Element | null = parent;
  while (host && ceiling.contains(host)) {
    if (host === ceiling) return { parent: host, before };
    const style = getComputedStyle(host);
    const contents = style.display === "contents";
    const row = !contents && isHorizontalLayout(host);
    const width = host.getBoundingClientRect().width;
    if (!contents && !row && width >= full * 0.9) return { parent: host, before };
    before = host;
    host = host.parentElement;
  }
  return null;
}

function applyHistorySlotLayout(slot: HTMLElement): void {
  slot.style.display = "block";
  slot.style.width = "100%";
  slot.style.minWidth = "0";
  slot.style.flex = "none";
  slot.style.alignSelf = "stretch";
}

export function ensureQuestionHistorySlot(document: Document, mount: Element): Element {
  const insert = rowStackInsert(mount);
  const host = insert?.parent ?? mount;
  for (const child of host.children) {
    if (!child.hasAttribute(QUESTION_HISTORY_SLOT_ATTRIBUTE)) continue;
    applyHistorySlotLayout(child as HTMLElement);
    return child;
  }
  const ceiling = questionHistorySlotCeiling(mount);
  const parked = ceiling.querySelector(`[${QUESTION_HISTORY_SLOT_ATTRIBUTE}]`);
  if (parked) {
    if (insert && parked.parentElement !== insert.parent) {
      insertBeforeSafe(insert.parent, parked, insert.before);
    }
    applyHistorySlotLayout(parked as HTMLElement);
    return parked;
  }
  const slot = document.createElement("div");
  slot.setAttribute(QUESTION_HISTORY_SLOT_ATTRIBUTE, "");
  applyHistorySlotLayout(slot);
  if (insert) insertBeforeSafe(insert.parent, slot, insert.before);
  else mount.prepend(slot);
  return slot;
}
