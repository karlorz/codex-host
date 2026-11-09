import { assert, describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ classList: { add() {} } }),
  isRendererSettingsIconName: () => true,
}));

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { createEnrollmentSettingsPage } from "../../src/settings/enrollment-page.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { createDefaultRendererSettingsPages } from "../../src/settings/pages.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  parent: FakeElement | undefined;
  readonly #listeners = new Map<string, () => void>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  addEventListener(name: string, listener: () => void): void {
    this.#listeners.set(name, listener);
  }

  dispatch(name: string): void {
    this.#listeners.get(name)?.();
  }

  append(...children: unknown[]): void {
    for (const child of children) if (child instanceof FakeElement) child.parent = this;
    this.children.push(...children);
  }

  replaceChildren(...children: unknown[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  readonly defaultView = {
    navigator: { platform: "MacIntel", userAgent: "Macintosh" },
  } as unknown as Window;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
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

describe("Enrollment settings page", () => {
  it("is registered next to Remote connections", () => {
    const ids = createDefaultRendererSettingsPages().map(({ id }) => id);
    expect(ids.indexOf("enrollment")).toBe(ids.indexOf("remote-connections") + 1);
  });

  it("lists pairings without tokens and revokes from the table", async () => {
    const view = {
      enrollmentId: "enroll-1",
      threadId: "thread-1",
      clientId: "cursor-box-grok",
      executablePath: "/synthetic/grok",
      endpoint: "http://127.0.0.1:9",
      issuedAt: "2026-11-07T00:00:00.000Z",
      expiresAt: "2036-11-07T00:00:00.000Z",
      pairing: "machine" as const,
      allowlist: [{ threadId: "thread-1", verbs: ["read", "send"] as const }],
    };
    const listEnrollments = vi
      .fn()
      .mockResolvedValueOnce({ enrollments: [view] })
      .mockResolvedValueOnce({ enrollments: [] });
    const revokeEnrollment = vi.fn(async () => ({
      enrollmentId: "enroll-1",
      revoked: true as const,
    }));
    const page = createEnrollmentSettingsPage(rendererSettingsMessages("en"), () => ({
      listEnrollments,
      revokeEnrollment,
    }));
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("cursor-box-grok"));
    expect(visibleText(content)).toContain("Until revoked");
    expect(visibleText(content)).not.toContain("token");
    const refresh = descendants(content).find(
      (element) => element.tagName === "button" && element.getAttribute("aria-label") === "Refresh",
    );
    assert(refresh);
    const revoke = descendants(content).find(
      (element) => element.tagName === "button" && visibleText(element).includes("Revoke"),
    );
    assert(revoke);
    revoke.dispatch("click");
    expect(revokeEnrollment).not.toHaveBeenCalled();
    expect(visibleText(revoke)).toContain("Confirm revoke");
    revoke.dispatch("click");
    await vi.waitFor(() => expect(revokeEnrollment).toHaveBeenCalledWith("enroll-1"));
    await vi.waitFor(() =>
      expect(visibleText(content)).toContain(
        "No active enrollments. Run codexhost enroll from an authorized Host session.",
      ),
    );
    scope.dispose();
  });

  it("shows Host required when no enrollment client is bound", () => {
    const page = createEnrollmentSettingsPage(rendererSettingsMessages("en"), () => null);
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    expect(visibleText(content)).toContain("Client enrollment requires the local Host.");
    expect(visibleText(content)).toContain("not a Desktop service");
    scope.dispose();
  });
});
