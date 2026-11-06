import { describe, expect, it, vi } from "vitest";
import { createRendererCdpControlSession } from "../src/renderer-cdp-control-session.js";
import { BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE } from "../src/browser-annotation-style-compat.js";
import type { CdpTarget } from "../src/cdp-client.js";

function target(id: string, url: string, type = "page"): CdpTarget {
  return { id, url, type, title: id, webSocketDebuggerUrl: `ws://localhost/${id}` };
}

function client(browser = false) {
  let installed = false;
  return {
    command: vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.expression === BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE) installed = true;
      return {};
    }),
    async evaluate<T>(): Promise<T> {
      return (
        browser
          ? installed
          : {
              version: 2,
              enabledAgents: ["codex"],
              adapter: { state: "ready", reason: "ready" },
            }
      ) as T;
    },
    on: vi.fn(() => () => {}),
    close: vi.fn(),
    reload: () => {
      installed = false;
    },
  };
}

describe("browser annotation style installation", () => {
  it("installs only the dedicated shim, discovers new pages, and restores reloads without duplicate registrations", async () => {
    const primary = client();
    const browser = client(true);
    const later = client(true);
    let inventory = [
      target("primary", "app://-/index.html"),
      target("browser", "https://orca.termolo.com/"),
      target("frame", "https://other.test/", "iframe"),
      target("worker", "https://other.test/worker.js", "worker"),
      target("overlay", "app://-/avatar-overlay.html"),
      target("blank", "about:blank"),
      target("file", "file:///tmp/page.html"),
    ];
    const connect = vi.fn(async (url: string) =>
      url.endsWith("/browser") ? browser : url.endsWith("/later") ? later : primary,
    );
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://localhost:43123",
      rendererSource: "chat renderer only",
      operations: {
        listTargets: async () => inventory,
        connect,
        installDraftPrewarmPolicy: async () => ({ state: "ready", reason: "owned-request-bridge" }),
      },
    });
    try {
      expect(connect.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
        "primary",
        "browser",
      ]);
      const register = { source: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE };
      const evaluate = { expression: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE, awaitPromise: true };
      expect(browser.command.mock.calls).toEqual([
        ["Page.enable"],
        ["Page.addScriptToEvaluateOnNewDocument", register],
        ["Runtime.evaluate", evaluate],
      ]);
      await session.ensureInstalled();
      browser.reload();
      await session.ensureInstalled();
      expect(
        browser.command.mock.calls.filter(
          ([method]) => method === "Page.addScriptToEvaluateOnNewDocument",
        ),
      ).toHaveLength(1);
      expect(
        browser.command.mock.calls.filter(([method]) => method === "Runtime.evaluate"),
      ).toHaveLength(2);
      expect(
        browser.command.mock.calls.some(([, params]) => params?.source === "chat renderer only"),
      ).toBe(false);
      inventory = [...inventory, target("later", "http://localhost:18099/")];
      await session.ensureInstalled();
      expect(later.command).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", register);
      expect(browser.close).not.toHaveBeenCalled();
      inventory = inventory.filter((item) => item.id !== "browser");
      await session.ensureInstalled();
      expect(browser.close).toHaveBeenCalledOnce();
      expect(later.close).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
    expect(later.close).toHaveBeenCalledOnce();
  });

  it("keeps the primary session ready when a browser page disappears", async () => {
    const primary = client();
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://localhost:43123",
      rendererSource: "chat renderer only",
      timeoutMs: 100,
      operations: {
        listTargets: async () => [
          target("primary", "app://-/index.html"),
          target("gone", "https://example.test/"),
        ],
        connect: async (url) => {
          if (url.endsWith("/gone")) throw new Error("closed");
          return primary;
        },
        installDraftPrewarmPolicy: async () => ({ state: "ready", reason: "owned-request-bridge" }),
      },
    });
    try {
      expect(session.snapshot.binding.adapter.state).toBe("ready");
      expect(primary.close).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });
});
