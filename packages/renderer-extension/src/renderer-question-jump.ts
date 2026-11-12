import {
  elementIsDisplayed,
  findDisplayedTranscriptItem,
  findTranscriptItem,
} from "./renderer-question-anchors.js";

const SIDEBAR_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
const SIDEBAR_THREAD_ID_ATTRIBUTE = "data-app-action-sidebar-thread-id";
const NATIVE_MESSAGE_JUMP = /^Jump to user message (\d+)$/;
const JUMP_WAIT_MS = 2000;

let jumpWait: { cancel: () => void } | undefined;

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

function selectOwningChatTab(root: ParentNode, titleHint: string): void {
  if (!titleHint) return;
  for (const tab of root.querySelectorAll('[role="tab"]')) {
    if (!(tab instanceof HTMLElement)) continue;
    const label = tabLabel(tab);
    if (!titleMatchesTab(titleHint, label)) continue;
    if (tab.getAttribute("aria-selected") !== "true") tab.click();
    return;
  }
}

function clickThreadTitleControl(root: ParentNode, titleHint: string): void {
  if (!titleHint) return;
  for (const node of root.querySelectorAll("button, a")) {
    if (!(node instanceof HTMLElement) || !elementIsDisplayed(node)) continue;
    if (node.getAttribute("role") === "tab") continue;
    if (node.closest(SIDEBAR_THREAD_ROW_SELECTOR)) continue;
    if (node.dataset.codexhostQuestionJump !== undefined) continue;
    const label = tabLabel(node);
    if (!titleMatchesTab(titleHint, label)) continue;
    node.click();
    return;
  }
}

function clickLatestNativeMessageJump(root: ParentNode): void {
  let best: { button: HTMLElement; n: number } | undefined;
  for (const node of root.querySelectorAll("button")) {
    if (!(node instanceof HTMLElement) || !elementIsDisplayed(node)) continue;
    const match = NATIVE_MESSAGE_JUMP.exec(node.getAttribute("aria-label") ?? "");
    if (!match) continue;
    const n = Number(match[1]);
    if (!best || n > best.n) best = { button: node, n };
  }
  best?.button.click();
}

function revealOwningConversation(document: Document, hostId: string, threadId: string): void {
  const row = sidebarRowForThread(document, hostId, threadId);
  const hint = threadTitleHint(row, document.title);
  selectOwningChatTab(document, hint);
  clickThreadTitleControl(document, hint);
  row?.click();
  clickLatestNativeMessageJump(document);
}

function waitForDisplayedRow(
  document: Document,
  itemId: string,
  timeoutMs: number,
): Promise<boolean> {
  jumpWait?.cancel();
  jumpWait = undefined;
  if (findDisplayedTranscriptItem(document, itemId)) return Promise.resolve(true);
  const ownerWindow = document.defaultView;
  if (!ownerWindow) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let frame = 0;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      jumpWait = undefined;
      ownerWindow.cancelAnimationFrame(frame);
      ownerWindow.clearTimeout(timer);
      resolve(ok);
    };
    const tick = () => {
      if (settled) return;
      if (findDisplayedTranscriptItem(document, itemId)) {
        finish(true);
        return;
      }
      frame = ownerWindow.requestAnimationFrame(tick);
    };
    frame = ownerWindow.requestAnimationFrame(tick);
    const timer = ownerWindow.setTimeout(() => finish(false), timeoutMs);
    jumpWait = { cancel: () => finish(false) };
  });
}

export async function jumpRevealsQuestionRow(
  document: Document,
  hostId: string,
  threadId: string,
  itemId: string | undefined,
): Promise<boolean> {
  revealOwningConversation(document, hostId, threadId);
  if (!itemId) return false;
  findTranscriptItem(document, itemId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  return waitForDisplayedRow(document, itemId, JUMP_WAIT_MS);
}
