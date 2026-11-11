import { elementIsDisplayed, findTranscriptItem } from "./renderer-question-anchors.js";

const SIDEBAR_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
const SIDEBAR_THREAD_ID_ATTRIBUTE = "data-app-action-sidebar-thread-id";

function sidebarRowForThread(
  root: ParentNode,
  hostId: string,
  threadId: string,
): HTMLElement | null {
  for (const node of root.querySelectorAll(SIDEBAR_THREAD_ROW_SELECTOR)) {
    if (!(node instanceof HTMLElement)) continue;
    const raw = node.getAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE) ?? "";
    if (raw === threadId || raw === `${hostId}:${threadId}` || raw.endsWith(`:${threadId}`)) {
      return node;
    }
  }
  return null;
}

function threadTitleHint(row: Element | null, fallback: string): string {
  return (row?.textContent ?? "").replace(/\s+/g, " ").trim() || fallback.trim();
}

function tabLabel(tab: Element): string {
  return (tab.getAttribute("aria-label") ?? tab.textContent ?? "").replace(/\s+/g, " ").trim();
}

function titleMatchesTab(titleHint: string, label: string): boolean {
  return (
    label.length > 0 &&
    (titleHint === label || titleHint.endsWith(label) || titleHint.includes(label))
  );
}

/** Select this conversation's window tab when another Chat tab is active. */
export function selectOwningChatTab(root: ParentNode, titleHint: string): boolean {
  if (!titleHint) return false;
  for (const tab of root.querySelectorAll('[role="tab"]')) {
    if (!(tab instanceof HTMLElement)) continue;
    const label = tabLabel(tab);
    if (!titleMatchesTab(titleHint, label)) continue;
    if (tab.getAttribute("aria-selected") !== "true") tab.click();
    return true;
  }
  return false;
}

export function revealOwningConversation(
  document: Document,
  hostId: string,
  threadId: string,
): void {
  const row = sidebarRowForThread(document, hostId, threadId);
  selectOwningChatTab(document, threadTitleHint(row, document.title));
  row?.click();
}

export function jumpRevealsQuestionRow(
  document: Document,
  hostId: string,
  threadId: string,
  itemId: string,
): boolean {
  revealOwningConversation(document, hostId, threadId);
  const row = findTranscriptItem(document, itemId);
  row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  return Boolean(row && elementIsDisplayed(row));
}
