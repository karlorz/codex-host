import { assert, describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ classList: { add() {} } }),
  isRendererSettingsIconName: () => true,
}));

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { createMcpClientsSettingsPage } from "../../src/settings/mcp-clients-page.js";
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
  value = "";
  id = "";
  htmlFor = "";
  hidden = false;
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

describe("MCP clients settings page", () => {
  it("is registered next to Enrollment", () => {
    const ids = createDefaultRendererSettingsPages().map(({ id }) => id);
    expect(ids.indexOf("mcp-clients")).toBe(ids.indexOf("enrollment") + 1);
  });

  it("lists clients without tokens and revokes from the table", async () => {
    const view = {
      name: "grok-bot",
      createdAt: "2026-11-14T00:00:00.000Z",
      access: "all-threads" as const,
      workspaces: [],
      connectionMode: "public-relay" as const,
      dispatchGrant: "full-dispatch" as const,
      mcpUrl: "https://codexhost.karldigi.dev/mcp",
    };
    const listClients = vi
      .fn()
      .mockResolvedValueOnce({ clients: [view] })
      .mockResolvedValueOnce({ clients: [] });
    const revokeClient = vi.fn(async () => ({ name: "grok-bot", revoked: true as const }));
    const page = createMcpClientsSettingsPage(rendererSettingsMessages("en"), () => ({
      listClients,
      createClient: vi.fn(),
      updateClient: vi.fn(),
      revokeClient,
    }));
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("grok-bot"));
    expect(visibleText(content)).toContain("https://codexhost.karldigi.dev/mcp");
    expect(JSON.stringify(visibleText(content))).not.toContain("chc_");
    const revoke = descendants(content).find(
      (element) => element.tagName === "button" && visibleText(element).includes("Revoke"),
    );
    assert(revoke);
    revoke.dispatch("click");
    expect(revokeClient).not.toHaveBeenCalled();
    revoke.dispatch("click");
    await vi.waitFor(() => expect(revokeClient).toHaveBeenCalledWith("grok-bot"));
    await vi.waitFor(() =>
      expect(visibleText(content)).toContain(
        "No MCP clients. Add muse or grok-bot here before connecting OAuth.",
      ),
    );
    scope.dispose();
  });

  it("lays out labeled fields and reveals workspace and direct-url rows on demand", async () => {
    const page = createMcpClientsSettingsPage(rendererSettingsMessages("en"), () => ({
      listClients: vi.fn().mockResolvedValue({ clients: [] }),
      createClient: vi.fn(),
      updateClient: vi.fn(),
      revokeClient: vi.fn(),
    }));
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    const form = descendants(content).find((element) => element.tagName === "form");
    assert(form);
    expect(form.className).toBe("settings-mcp-clients-form");
    expect(visibleText(form)).toContain("Client name");
    expect(visibleText(form)).toContain("Thread access");
    expect(visibleText(form)).toContain("Add client");
    const workspaces = descendants(form).find((element) => element.tagName === "textarea");
    const directUrl = descendants(form).find(
      (element) => element.getAttribute("aria-label") === "Direct MCP URL",
    );
    const access = descendants(form).find(
      (element) =>
        element.tagName === "select" && element.getAttribute("aria-label") === "Thread access",
    );
    const connection = descendants(form).find(
      (element) =>
        element.tagName === "select" && element.getAttribute("aria-label") === "Connection",
    );
    assert(workspaces?.parent);
    assert(directUrl?.parent);
    assert(access);
    assert(connection);
    expect(workspaces.parent.className).toContain("settings-mcp-clients-field--wide");
    expect(workspaces.parent.hidden).toBe(true);
    expect(directUrl.parent.hidden).toBe(true);
    access.value = "selected-workspaces";
    access.dispatch("change");
    expect(workspaces.parent.hidden).toBe(false);
    expect(visibleText(workspaces.parent)).toContain(
      "One absolute path per line. Symlinks are resolved. Unresolved paths are denied.",
    );
    connection.value = "direct";
    connection.dispatch("change");
    expect(directUrl.parent.hidden).toBe(false);
    expect(visibleText(directUrl.parent)).toContain("Host does not open a listener.");
    scope.dispose();
  });
});
