import { isAvatarOverlayHref, notificationThreadId } from "./renderer-overlay-thread-isolation.js";

const GLOBAL = "__codexhostOverlayVoiceChromeV1";
const MASCOT_SELECTOR = "[data-avatar-mascot], [data-testid='avatar-mascot-button']";
const TRANSCRIPT_SELECTOR = '[data-avatar-overlay-material-variant="transcript-message"]';
const QUICK_CHAT_ORB_SELECTOR = '[data-avatar-overlay-material-variant="quick-chat-orb"]';
const VOICE_REGION_SELECTOR = '[data-avatar-overlay-hit-region="realtime-voice"]';
const HIDE_SELECTOR = `${MASCOT_SELECTOR}, ${TRANSCRIPT_SELECTOR}, ${QUICK_CHAT_ORB_SELECTOR}`;
const OVERLAY_VOICE_MIN_EDGE = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overlayOwnsVoiceControls(document: Document | undefined): boolean {
  const region = document?.querySelector(VOICE_REGION_SELECTOR);
  if (!region) return false;
  const rect = region.getBoundingClientRect();
  return rect.width > OVERLAY_VOICE_MIN_EDGE && rect.height > OVERLAY_VOICE_MIN_EDGE;
}

export function overlayHidesWorkVoiceChrome(
  activeCalls: number,
  overlayOwnsVoice: boolean,
): boolean {
  return activeCalls > 0 && !overlayOwnsVoice;
}

export interface OverlayVoiceChromeTarget {
  [GLOBAL]?: OverlayVoiceChromeHandle;
  location?: { href: string };
  document?: Document;
  addEventListener(
    type: "message",
    listener: (event: OverlayVoiceChromeMessageEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: OverlayVoiceChromeMessageEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  MutationObserver?: typeof MutationObserver;
}

export interface OverlayVoiceChromeMessageEvent {
  data?: unknown;
}

export interface OverlayVoiceChromeHandle {
  status: "disabled" | "active";
  dispose(): void;
}

/**
 * Work voice places the orb on the main Thread. The leftover overlay pet and
 * transcript chrome are a second copy of that call. Quick Chat that owns its
 * own expanded voice controls keeps the overlay mascot.
 */
export function installOverlayVoiceChromeDedup(
  target: OverlayVoiceChromeTarget | null = typeof globalThis === "undefined"
    ? null
    : (globalThis as unknown as OverlayVoiceChromeTarget),
): OverlayVoiceChromeHandle {
  const href = target?.location?.href;
  if (target?.[GLOBAL]) return target[GLOBAL];
  if (
    !target ||
    typeof href !== "string" ||
    !isAvatarOverlayHref(href) ||
    typeof target.addEventListener !== "function"
  ) {
    return { status: "disabled", dispose() {} };
  }
  const hidden = new Map<HTMLElement, [string, string]>();
  const activeCalls = new Set<string>();
  let observer: MutationObserver | undefined;
  const hide = (element: HTMLElement): void => {
    if (!hidden.has(element)) {
      hidden.set(element, [
        element.style.getPropertyValue("visibility"),
        element.style.getPropertyPriority("visibility"),
      ]);
    }
    element.style.setProperty("visibility", "hidden", "important");
  };
  const reveal = (): void => {
    for (const [element, [value, priority]] of hidden) {
      if (
        element.style.getPropertyValue("visibility") === "hidden" &&
        element.style.getPropertyPriority("visibility") === "important"
      ) {
        element.style.setProperty("visibility", value, priority);
      }
    }
    hidden.clear();
  };
  const sync = (): void => {
    if (!overlayHidesWorkVoiceChrome(activeCalls.size, overlayOwnsVoiceControls(target.document))) {
      reveal();
      return;
    }
    const root = target.document;
    if (!root?.querySelectorAll) return;
    for (const node of root.querySelectorAll(HIDE_SELECTOR)) {
      const element = node as HTMLElement;
      if (typeof element.style?.setProperty === "function") hide(element);
    }
  };
  const listener = (event: OverlayVoiceChromeMessageEvent): void => {
    const message = event.data;
    if (!isRecord(message) || message.type !== "mcp-notification") return;
    if (typeof message.method !== "string") return;
    const threadId = notificationThreadId(message.params);
    if (!threadId) return;
    if (message.method === "thread/realtime/started") activeCalls.add(threadId);
    else if (
      message.method === "thread/realtime/closed" ||
      message.method === "thread/realtime/error" ||
      message.method === "thread/deleted"
    ) {
      activeCalls.delete(threadId);
    } else return;
    sync();
  };
  target.addEventListener("message", listener, true);
  const Observer = target.MutationObserver ?? globalThis.MutationObserver;
  if (typeof Observer === "function" && target.document) {
    observer = new Observer(sync);
    const root = target.document.body ?? target.document.documentElement ?? target.document;
    try {
      observer.observe(root, { childList: true, subtree: true, attributes: true });
    } catch {
      observer.disconnect();
      observer = undefined;
    }
  }
  const handle: OverlayVoiceChromeHandle = {
    status: "active",
    dispose() {
      target.removeEventListener("message", listener, true);
      observer?.disconnect();
      reveal();
      if (target[GLOBAL] === handle) delete target[GLOBAL];
    },
  };
  target[GLOBAL] = handle;
  return handle;
}
