import { describe, expect, it } from "vitest";

import {
  installOverlayVoiceChromeDedup,
  overlayHidesWorkVoiceChrome,
  type OverlayVoiceChromeMessageEvent,
  type OverlayVoiceChromeTarget,
} from "../src/renderer-overlay-voice-chrome.js";

const overlayHref = "app://-/index.html?initialRoute=%2Favatar-overlay";

class FakeStyle {
  private value = "";
  private priority = "";
  getPropertyValue(name: string): string {
    return name === "visibility" ? this.value : "";
  }
  getPropertyPriority(name: string): string {
    return name === "visibility" ? this.priority : "";
  }
  setProperty(name: string, value: string, priority = ""): void {
    if (name !== "visibility") return;
    this.value = value;
    this.priority = priority;
  }
}

function element(kind: "mascot" | "transcript" | "voice", size: number): HTMLElement {
  const style = new FakeStyle();
  const matches =
    kind === "mascot"
      ? ["[data-avatar-mascot]", "[data-testid='avatar-mascot-button']"]
      : kind === "transcript"
        ? ['[data-avatar-overlay-material-variant="transcript-message"]']
        : ['[data-avatar-overlay-hit-region="realtime-voice"]'];
  return {
    style,
    getBoundingClientRect: () => ({ width: size, height: size }),
    matches: (selector: string) => matches.includes(selector),
  } as unknown as HTMLElement;
}

class FakeOverlay implements OverlayVoiceChromeTarget {
  readonly listeners = new Set<(event: OverlayVoiceChromeMessageEvent) => void>();
  constructor(
    readonly location: { href: string },
    readonly mascot: HTMLElement,
    readonly voice: HTMLElement,
    readonly transcript?: HTMLElement,
  ) {}

  get document(): Document {
    const nodes = [this.mascot, this.voice, ...(this.transcript ? [this.transcript] : [])];
    return {
      querySelector: (selector: string) =>
        nodes.find((node) =>
          (node as unknown as { matches(s: string): boolean }).matches(selector),
        ),
      querySelectorAll: (selector: string) =>
        nodes.filter((node) =>
          selector
            .split(",")
            .map((part) => part.trim())
            .some((part) => (node as unknown as { matches(s: string): boolean }).matches(part)),
        ),
    } as unknown as Document;
  }

  addEventListener(
    type: "message",
    listener: (event: OverlayVoiceChromeMessageEvent) => void,
  ): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(
    type: "message",
    listener: (event: OverlayVoiceChromeMessageEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }

  dispatch(method: string, params: Record<string, unknown>): void {
    const event = { data: { type: "mcp-notification", method, params } };
    for (const listener of this.listeners) listener(event);
  }
}

describe("overlay Work voice chrome", () => {
  it("hides leftover overlay chrome only when Work voice owns the main Thread", () => {
    expect(overlayHidesWorkVoiceChrome(1, false)).toBe(true);
    expect(overlayHidesWorkVoiceChrome(1, true)).toBe(false);
    expect(overlayHidesWorkVoiceChrome(0, false)).toBe(false);
  });

  it("does not install on the primary window", () => {
    const mascot = element("mascot", 113);
    const voice = element("voice", 6);
    const primary = new FakeOverlay({ href: "app://-/index.html" }, mascot, voice);
    const hook = installOverlayVoiceChromeDedup(primary);
    expect(hook.status).toBe("disabled");
    primary.dispatch("thread/realtime/started", { threadId: "voice" });
    expect(mascot.style.getPropertyValue("visibility")).toBe("");
    hook.dispose();
  });

  it("hides the overlay pet and transcript while Work voice is on the main Thread", () => {
    const mascot = element("mascot", 113);
    const voice = element("voice", 6);
    const transcript = element("transcript", 200);
    const overlay = new FakeOverlay({ href: overlayHref }, mascot, voice, transcript);
    const hook = installOverlayVoiceChromeDedup(overlay);
    expect(hook.status).toBe("active");
    overlay.dispatch("thread/realtime/started", { threadId: "voice" });
    expect(mascot.style.getPropertyValue("visibility")).toBe("hidden");
    expect(mascot.style.getPropertyPriority("visibility")).toBe("important");
    expect(transcript.style.getPropertyValue("visibility")).toBe("hidden");
    overlay.dispatch("thread/realtime/closed", { threadId: "voice" });
    expect(mascot.style.getPropertyValue("visibility")).toBe("");
    expect(transcript.style.getPropertyValue("visibility")).toBe("");
    hook.dispose();
  });

  it("keeps the overlay mascot when Quick Chat owns expanded voice controls", () => {
    const mascot = element("mascot", 113);
    const voice = element("voice", 80);
    const overlay = new FakeOverlay({ href: overlayHref }, mascot, voice);
    const hook = installOverlayVoiceChromeDedup(overlay);
    overlay.dispatch("thread/realtime/started", { threadId: "voice" });
    expect(mascot.style.getPropertyValue("visibility")).toBe("");
    hook.dispose();
  });

  it("reuses the overlay handle instead of installing twice", () => {
    const mascot = element("mascot", 113);
    const voice = element("voice", 6);
    const overlay = new FakeOverlay({ href: overlayHref }, mascot, voice);
    const first = installOverlayVoiceChromeDedup(overlay);
    const second = installOverlayVoiceChromeDedup(overlay);
    expect(second).toBe(first);
    first.dispose();
  });

  it("restores leftover chrome on dispose during an active call", () => {
    const mascot = element("mascot", 113);
    const voice = element("voice", 6);
    const overlay = new FakeOverlay({ href: overlayHref }, mascot, voice);
    const hook = installOverlayVoiceChromeDedup(overlay);
    overlay.dispatch("thread/realtime/started", { threadId: "voice" });
    expect(mascot.style.getPropertyValue("visibility")).toBe("hidden");
    hook.dispose();
    expect(mascot.style.getPropertyValue("visibility")).toBe("");
  });
});
