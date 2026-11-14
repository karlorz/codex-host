import { describe, expect, it, vi } from "vitest";

import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../../src/renderer-cpa-live-voice-config.js";
import { createVoiceSettingsPage } from "../../src/settings/voice-page.js";
import {
  hashedVoiceTestIdentity,
  isolatedVoiceQualificationFixture,
} from "../voice-evidence-fixture.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: (...tokens: string[]) => {
      const next = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const token of tokens) next.add(token);
      this.className = [...next].join(" ");
    },
  };
  className = "";
  textContent = "";
  type = "";
  value = "";
  disabled = false;
  checked = false;
  parent: FakeElement | undefined;
  readonly #listeners = new Map<string, (event?: { key?: string }) => void>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  set id(value: string) {
    this.setAttribute("id", value);
  }
  get htmlFor(): string {
    return this.getAttribute("for") ?? "";
  }
  set htmlFor(value: string) {
    this.setAttribute("for", value);
  }

  addEventListener(name: string, listener: () => void): void {
    this.#listeners.set(name, listener);
  }
  dispatch(name: string): void {
    this.#listeners.get(name)?.();
  }
  append(...children: unknown[]): void {
    for (const child of children) {
      if (typeof child === "string") {
        const text = new FakeElement("#text", this.ownerDocument);
        text.textContent = child;
        this.children.push(text);
        continue;
      }
      if (child instanceof FakeElement) child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: unknown[]): void {
    this.children.splice(0, this.children.length);
    this.append(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.textContent = this.textContent;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  getRootNode(): FakeDocument {
    return this.ownerDocument;
  }
  contains(node: unknown): boolean {
    return descendants(this).includes(node as FakeElement);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const all = descendants(this).filter((node) => node.tagName !== "#text");
    if (selector.startsWith("#")) return all.filter((node) => node.id === selector.slice(1));
    return all.filter((node) => node.tagName === selector);
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly defaultView: FakeWindow;
  constructor(hook: Record<string, unknown>) {
    this.defaultView = new FakeWindow(this, hook);
  }
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
  createTextNode(value: string): FakeElement {
    const text = new FakeElement("#text", this);
    text.textContent = value;
    return text;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
}

class FakeWindow {
  readonly timers = new Map<number, () => void>();
  #nextTimer = 1;
  constructor(
    readonly document: FakeDocument,
    hook: Record<string, unknown>,
  ) {
    Reflect.set(this, CPA_LIVE_VOICE_HOOK_GLOBAL, hook);
  }
  setInterval(handler: () => void): number {
    const id = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(id, handler);
    return id;
  }
  clearInterval(id: number): void {
    this.timers.delete(id);
  }
  async poll(): Promise<void> {
    for (const handler of [...this.timers.values()]) await handler();
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function visibleText(root: FakeElement): string {
  return descendants(root)
    .map(({ textContent }) => textContent)
    .filter(Boolean)
    .join(" ");
}

function selectValues(root: FakeElement): string[] {
  return descendants(root)
    .filter((node) => node.tagName === "select")
    .map((node) => node.value);
}

function voiceState() {
  return {
    settings: {
      chatExperience: "chatgpt" as const,
      chatConnection: "desktop" as const,
      workConnection: "gateway" as const,
      inject: true,
    },
    initialized: true,
    revision: "1",
    activeInject: true,
    envOverride: null,
    activeEnvOverride: null,
    routesActive: true,
    activeCall: false,
    gatewayReady: false,
    restartAvailable: true,
    restart: { phase: "idle" as const, error: null },
  };
}

function hookConfig(paths: Array<"chat" | "work-codex" | "work-grok">) {
  const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
  return {
    enabled: true,
    auditedDesktopVersion: "26.1007.30912",
    auditedAppInitialAsset: "app-initial-6350d04672d0.js",
    desktopVersion: "26.1106.51428",
    desktopPlatform: "darwin",
    desktopAppPath: appPath,
    ...hashedVoiceTestIdentity(),
    isolatedQualification: isolatedVoiceQualificationFixture({
      appPath,
      paths,
    }),
  };
}

describe("voice settings page availability poll", () => {
  it("updates selected-path status when qualification changes and the get payload is unchanged", async () => {
    const state = voiceState();
    const request = vi.fn(async (input?: { operation?: string }) => {
      void input;
      return state;
    });
    const hook = hookConfig(["chat"]);
    const document = new FakeDocument(hook);
    const content = document.createElement("main");
    let renders = 0;
    const replaceChildren = content.replaceChildren.bind(content);
    content.replaceChildren = (...children: unknown[]) => {
      renders += 1;
      replaceChildren(...children);
    };
    const page = createVoiceSettingsPage("en", request, { desktop: true });
    const dispose = page.mount({
      content: content as unknown as HTMLElement,
      signal: new AbortController().signal,
      runLatest: async () => {},
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("Work gateway"));
    expect(visibleText(content)).toContain("ChatGPT Chat: Allowed on this Desktop");
    expect(visibleText(content)).toContain("Work gateway: Not available on this Desktop.");
    expect(visibleText(content)).toContain("Preferences applied: Applied");
    expect(visibleText(content)).toContain("Gateway configuration: Needs setup");
    expect(selectValues(content)).toEqual(["chatgpt", "desktop", "gateway"]);
    const afterLoad = renders;
    await document.defaultView.poll();
    expect(renders).toBe(afterLoad);
    hook.isolatedQualification = isolatedVoiceQualificationFixture({
      appPath: hook.desktopAppPath,
      path: "chat",
      paths: ["chat", "work-codex", "work-grok"],
    });
    await document.defaultView.poll();
    expect(visibleText(content)).toContain("Work gateway: Allowed on this Desktop");
    expect(visibleText(content)).toContain("ChatGPT Chat: Allowed on this Desktop");
    expect(visibleText(content)).toContain("Preferences applied: Applied");
    expect(visibleText(content)).toContain("Gateway configuration: Needs setup");
    expect(visibleText(content)).not.toContain("Work voice is not available on this Desktop.");
    expect(selectValues(content)).toEqual(["chatgpt", "desktop", "gateway"]);
    expect(JSON.stringify(state.settings)).toBe(
      JSON.stringify({
        chatExperience: "chatgpt",
        chatConnection: "desktop",
        workConnection: "gateway",
        inject: true,
      }),
    );
    expect(request.mock.calls.every((call) => call[0]?.operation === "get")).toBe(true);
    expect(renders).toBeGreaterThan(afterLoad);
    dispose?.();
  });
});
