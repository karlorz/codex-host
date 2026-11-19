import { setImmediate } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { VOICE_SETTINGS_METHOD } from "@codexhost/shared-contracts";
import {
  createRendererCdpControlSession,
  selectAvatarOverlayRendererTargets,
  selectPrimaryRendererTarget,
  VOICE_HOST_LIVENESS_TIMEOUT_MS,
} from "../src/renderer-cdp-control-session.js";
import { RENDERER_VOICE_HOST_BINDING_NAME } from "../src/renderer-voice-host-binding.js";
import { CdpConnectionClosedError, type CdpTarget } from "../src/cdp-client.js";

function target(id: string, url = "app://-/index.html"): CdpTarget {
  return {
    id,
    type: "page",
    title: "Codex",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:43123/devtools/page/${id}`,
  };
}

function readyBinding() {
  return {
    version: 2,
    enabledAgents: ["codex", "pi"],
    adapter: { state: "ready", reason: "ready" },
  };
}

function overlayFreezeSource(input: {
  revision: string;
  path?: string;
  paths?: string[];
  run?: string;
  expiresAt?: string;
  desktopPlatform?: string;
  appPath?: string;
  wrapper?: string;
}): string {
  const expiresAt = input.expiresAt ?? "2026-11-15T07:40:00.000Z";
  const run = input.run ?? "run-1";
  const appPath = input.appPath ?? "/scratch/ChatGPT.app";
  const path = input.path ?? input.paths?.[0] ?? "chat";
  return `globalThis.__codexhostCpaLiveVoiceHookV1 = Object.freeze(${JSON.stringify({
    enabled: true,
    implementationRevision: input.revision,
    desktopAppPath: appPath,
    isolatedQualification: {
      path,
      ...(input.paths ? { paths: input.paths } : {}),
      run,
      expiresAt,
      ...(input.desktopPlatform ? { desktopPlatform: input.desktopPlatform } : {}),
    },
  })});\n${input.wrapper ?? "wrapper"}`;
}

function overlayLiveSnapshot(input: {
  revision: string;
  path: string;
  call: "idle" | "active" | "unknown";
  run?: string;
  expiresAt?: string;
  desktopPlatform?: string;
  appPath?: string;
}) {
  return {
    enabled: true,
    revision: input.revision,
    isolatedPath: input.path,
    isolatedRun: input.run ?? "run-1",
    isolatedExpiresAt: input.expiresAt ?? "2026-11-15T07:40:00.000Z",
    ...(input.desktopPlatform ? { isolatedPlatform: input.desktopPlatform } : {}),
    appPath: input.appPath ?? "/scratch/ChatGPT.app",
    call: input.call,
  };
}

async function overlayControlSession(overlay: ReturnType<typeof rendererClient>, source: string) {
  const primary = rendererClient();
  const session = await createRendererCdpControlSession({
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    rendererSource: "production renderer",
    overlayHookSource: "full overlay hook IIFE",
    overlayVoiceBootstrapSource: source,
    pollIntervalMs: 1,
    timeoutMs: 100,
    operations: {
      listTargets: vi.fn(async () => [
        target("page-1"),
        target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
      ]),
      connect: vi.fn(async (webSocketDebuggerUrl: string) =>
        webSocketDebuggerUrl.includes("overlay") ? overlay : primary,
      ),
      installDraftPrewarmPolicy: vi.fn(async () => ({
        state: "ready" as const,
        reason: "owned-request-bridge" as const,
      })),
    },
  });
  return { session, primary };
}

function rendererClient(binding = readyBinding()) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const listeners = new Map<string, (params: unknown) => void>();
  const evaluateSpy = vi.fn(async (expression: string, timeoutMs?: number) => {
    void expression;
    void timeoutMs;
    return binding as unknown;
  });
  return {
    commands,
    evaluateSpy,
    on: vi.fn((method: string, listener: (params: unknown) => void) => {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    }),
    emit(method: string, params: unknown) {
      listeners.get(method)?.(params);
    },
    command: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.evaluate")
        return typeof params?.contextId === "number"
          ? { result: { value: { href: "app://-/index.html", top: true } } }
          : { result: { type: "undefined" } };
      // Chromium returns the identifier of the registered new-document script.
      if (method === "Page.addScriptToEvaluateOnNewDocument")
        return { identifier: `script-${commands.length}` };
      return {};
    }),
    async evaluate<T>(expression: string, timeoutMs?: number): Promise<T> {
      return (await evaluateSpy(expression, timeoutMs)) as T;
    },
    listenerCount: () => listeners.size,
    close: vi.fn(() => listeners.clear()),
  };
}

describe("Renderer CDP Control Session", () => {
  function lateVoiceHostSession(input: {
    inventory: () => CdpTarget[];
    connect: (webSocketDebuggerUrl: string) => Promise<ReturnType<typeof rendererClient>>;
    timeoutMs?: number;
    /** `null` models a build without an installed overlay hook. */
    overlayHookSource?: string | null;
  }) {
    return createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      ...(input.overlayHookSource === null
        ? {}
        : { overlayHookSource: input.overlayHookSource ?? "overlay hook only" }),
      pollIntervalMs: 1,
      timeoutMs: input.timeoutMs ?? 100,
      operations: {
        listTargets: vi.fn(async () => input.inventory()),
        connect: vi.fn(input.connect),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
  }

  it("installs local-route chat windows and discovers them after startup", async () => {
    const primary = rendererClient();
    const local = rendererClient();
    local.evaluateSpy.mockResolvedValue(null);
    local.command.mockImplementation(async (method, params) => {
      local.commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.evaluate") local.evaluateSpy.mockResolvedValue(readyBinding());
      return {};
    });
    let inventory = [target("page-1")];
    const connect = vi.fn(async (url: string) => (url.endsWith("/local-chat") ? local : primary));
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: async () => inventory,
        connect,
        installDraftPrewarmPolicy: async () => ({ state: "ready", reason: "owned-request-bridge" }),
      },
    });
    try {
      inventory = [
        target("page-1"),
        target("local-chat", "app://-/index.html?initialRoute=%2Flocal%2Fthread"),
        target("spotlight", "app://-/index.html?initialRoute=%2Fspotlight"),
        target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
      ];
      await session.ensureInstalled();
      expect(local.commands).toContainEqual({
        method: "Runtime.evaluate",
        params: { expression: "production renderer", awaitPromise: true },
      });
      expect(connect.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
        "page-1",
        "local-chat",
      ]);
      const installedCount = local.commands.filter((c) => c.method === "Runtime.evaluate").length;
      await session.ensureInstalled();
      expect(local.commands.filter((c) => c.method === "Runtime.evaluate")).toHaveLength(
        installedCount,
      );
      expect(primary.close).not.toHaveBeenCalled();
      expect(local.close).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }
  });

  it("stops checking local chat readiness after the shared timeout", async () => {
    const primary = rendererClient();
    const stalled = rendererClient();
    const healthy = rendererClient();
    stalled.evaluateSpy.mockResolvedValue({
      ...readyBinding(),
      adapter: { state: "installing", reason: "request-manager-unavailable" },
    });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      timeoutMs: 40,
      operations: {
        listTargets: async () => [
          target("page-1"),
          target("stalled", "app://-/index.html?initialRoute=%2Flocal%2Fstalled"),
          target("healthy", "app://-/index.html?initialRoute=%2Flocal%2Fhealthy"),
        ],
        connect: async (url) =>
          url.endsWith("/stalled") ? stalled : url.endsWith("/healthy") ? healthy : primary,
        installDraftPrewarmPolicy: async () => ({
          state: "ready",
          reason: "owned-request-bridge",
        }),
      },
    });
    try {
      expect(stalled.close).toHaveBeenCalledOnce();
      expect(healthy.close).toHaveBeenCalledOnce();
      expect(primary.close).not.toHaveBeenCalled();
      expect(session.snapshot.binding).toEqual(readyBinding());
      const checksAtClose = stalled.evaluateSpy.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(stalled.evaluateSpy).toHaveBeenCalledTimes(checksAtClose);
    } finally {
      // Finish any pending readiness check before releasing the fixture.
      stalled.evaluateSpy.mockResolvedValue({
        ...readyBinding(),
        adapter: { state: "unsupported", reason: "test-finished" },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      session.close();
    }
  });

  it("selects only the exact primary app surface and preserves an owned target", () => {
    const first = target("page-1");
    const owned = target("page-2");
    expect(
      selectPrimaryRendererTarget([
        target("overlay", "app://-/avatar-overlay.html"),
        { ...target("worker"), type: "worker" },
        first,
        target("query", "app://-/index.html?window=second"),
        owned,
      ]),
    ).toBe(first);
    expect(selectPrimaryRendererTarget([first, owned], "page-2")).toBe(owned);
    expect(
      selectPrimaryRendererTarget([target("overlay", "app://-/avatar-overlay.html")]),
    ).toBeNull();
    expect(
      selectAvatarOverlayRendererTargets([
        target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        target("legacy", "app://-/avatar-overlay.html"),
        first,
        target("query", "app://-/index.html?window=second"),
      ]).map((item) => item.id),
    ).toEqual(["overlay", "legacy"]);
  });

  it("registers future-document injection before evaluating the current document", async () => {
    const client = rendererClient();
    const source = "globalThis.__codexhostInstalled = true";
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: source,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(client.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Debugger.enable", params: { maxScriptsCacheSize: 0 } },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
      {
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      },
    ]);
    expect(session.snapshot.binding).toEqual(readyBinding());
    session.close();
  });

  it("injects the hook-only source into the avatar overlay page", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) =>
          webSocketDebuggerUrl.includes("overlay") ? overlay : primary,
        ),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(primary.commands).toEqual(
      expect.arrayContaining([
        {
          method: "Page.addScriptToEvaluateOnNewDocument",
          params: { source: "production renderer" },
        },
      ]),
    );
    expect(overlay.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "overlay hook only" } },
      {
        method: "Runtime.evaluate",
        params: { expression: "overlay hook only", awaitPromise: true },
      },
    ]);
    session.close();
  });

  it("evaluates the overlay voice bootstrap on the current document instead of the full hook IIFE", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "full overlay hook IIFE",
      overlayVoiceBootstrapSource: "overlay voice bootstrap",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) =>
          webSocketDebuggerUrl.includes("overlay") ? overlay : primary,
        ),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(overlay.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      {
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: "overlay voice bootstrap" },
      },
      {
        method: "Runtime.evaluate",
        params: { expression: "overlay voice bootstrap", awaitPromise: true },
      },
    ]);
    expect(
      overlay.commands.some(
        ({ params }) =>
          params?.source === "full overlay hook IIFE" ||
          params?.expression === "full overlay hook IIFE",
      ),
    ).toBe(false);
    overlay.commands.length = 0;
    await session.ensureInstalled();
    expect(overlay.commands).toEqual([
      {
        method: "Runtime.evaluate",
        params: { expression: "overlay voice bootstrap", awaitPromise: true },
      },
    ]);
    expect(overlay.commands.some(({ method }) => method === "Runtime.enable")).toBe(false);
    session.close();
  });

  it("keeps the primary session when overlay CDP connect fails", async () => {
    const primary = rendererClient();
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) => {
          if (webSocketDebuggerUrl.includes("overlay")) {
            throw new Error("overlay closed between list and connect");
          }
          return primary;
        }),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(session.snapshot.binding).toEqual(readyBinding());
    expect(primary.close).not.toHaveBeenCalled();
    session.close();
  });

  it("re-injects the hook-only overlay bundle when a reload drops the hook", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) =>
          webSocketDebuggerUrl.includes("overlay") ? overlay : primary,
        ),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    overlay.commands.length = 0;
    await session.ensureInstalled();

    expect(overlay.commands).toEqual([
      {
        method: "Runtime.evaluate",
        params: { expression: "overlay hook only", awaitPromise: true },
      },
    ]);
    expect(
      overlay.commands.some(
        ({ params }) =>
          params?.source === "production renderer" || params?.expression === "production renderer",
      ),
    ).toBe(false);
    session.close();
  });

  it("evaluates an idle overlay once, then skips while identity and source digest match", async () => {
    const overlay = rendererClient();
    const source = overlayFreezeSource({ revision: "rev-a", path: "chat" });
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    const { session } = await overlayControlSession(overlay, source);
    expect(
      overlay.evaluateSpy.mock.calls.some(([expression]) =>
        String(expression).includes("__codexhostOverlayHookSnapshot"),
      ),
    ).toBe(true);
    expect(overlay.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
      {
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      },
    ]);
    overlay.commands.length = 0;
    await session.ensureInstalled();
    expect(overlay.commands).toEqual([]);
    session.close();
  });

  it("binds the voice Host before each session's first Runtime.enable and does not disable Runtime", async () => {
    const overlay = rendererClient();
    const source = overlayFreezeSource({ revision: "rev-a", path: "work-codex" });
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "work-codex", call: "idle" }),
    );
    const primary = rendererClient();
    const voiceHost = {
      owner: "owner-1",
      generation: 1,
      request: vi.fn(async () => ({ ok: true })),
    };
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "full overlay hook IIFE",
      overlayVoiceBootstrapSource: source,
      pollIntervalMs: 1,
      timeoutMs: 100,
      voiceHost,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=/avatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) =>
          webSocketDebuggerUrl.includes("overlay") ? overlay : primary,
        ),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    for (const client of [primary, overlay]) {
      const enableAt = client.commands.findIndex((item) => item.method === "Runtime.enable");
      const bindAt = client.commands.findIndex((item) => item.method === "Runtime.addBinding");
      expect(bindAt).toBeGreaterThanOrEqual(0);
      expect(enableAt).toBeGreaterThan(bindAt);
      expect(client.commands.some((item) => item.method === "Runtime.disable")).toBe(false);
    }
    session.close();
  });

  it("binds a late Voice Host on fresh connections that replay execution contexts", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
    const latePrimary = rendererClient();
    const lateOverlay = rendererClient();
    let primaryConnections = 0;
    let overlayConnections = 0;
    const connect = vi.fn(async (webSocketDebuggerUrl: string) => {
      if (webSocketDebuggerUrl.endsWith("/page-1"))
        return primaryConnections++ === 0 ? primary : latePrimary;
      if (webSocketDebuggerUrl.endsWith("/overlay"))
        return overlayConnections++ === 0 ? overlay : lateOverlay;
      throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
    });
    const voiceHost = {
      owner: "owner-1",
      generation: 1,
      request: vi.fn(async () => ({ settings: "ok" })),
    };
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    const installedPrimary = [...primary.commands];
    const installedOverlay = [...overlay.commands];

    await session.attachVoiceHost(voiceHost);

    // Installed connections keep their hooks, listeners, and Runtime state.
    expect(primary.commands).toEqual(installedPrimary);
    expect(overlay.commands).toEqual(installedOverlay);
    // The late binding runs on its own connection and enables Runtime there, so
    // it never depends on replay from the installed connection.
    for (const client of [latePrimary, lateOverlay]) {
      expect(client.commands[0]?.method).toBe("Runtime.enable");
      expect(client.commands.map((item) => item.method)).toContain("Runtime.addBinding");
    }

    latePrimary.emit("Runtime.executionContextCreated", {
      context: { id: 5, uniqueId: "ctx-5", auxData: { isDefault: true } },
    });
    latePrimary.emit("Runtime.bindingCalled", {
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 5,
      payload: JSON.stringify({
        v: 1,
        id: "req-1",
        owner: "owner-1",
        generation: 1,
        method: VOICE_SETTINGS_METHOD,
        params: { operation: "get" },
      }),
    });
    await vi.waitFor(() =>
      expect(voiceHost.request).toHaveBeenCalledWith(VOICE_SETTINGS_METHOD, { operation: "get" }),
    );
    await vi.waitFor(() =>
      expect(latePrimary.commands).toContainEqual({
        method: "Runtime.evaluate",
        params: expect.objectContaining({ contextId: 5 }),
      }),
    );

    await session.attachVoiceHost(voiceHost);
    expect(connect).toHaveBeenCalledTimes(4);

    session.close();
    expect(latePrimary.close).toHaveBeenCalledOnce();
    expect(lateOverlay.close).toHaveBeenCalledOnce();
    expect(latePrimary.commands.map((item) => item.method)).toContain("Runtime.removeBinding");
  });

  it("keeps the install-time Voice Host binding instead of opening a late connection", async () => {
    const primary = rendererClient();
    const connect = vi.fn(async () => primary);
    const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      voiceHost,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await session.attachVoiceHost(voiceHost);

    expect(connect).toHaveBeenCalledOnce();
    expect(primary.commands.filter((item) => item.method === "Runtime.addBinding")).toHaveLength(1);
    session.close();
  });

  it("releases a late Voice Host connection that cannot bind without disturbing the session", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    latePrimary.command.mockImplementation(async (method, params) => {
      latePrimary.commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.addBinding") throw new Error("Runtime.addBinding failed");
      return {};
    });
    let primaryConnections = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => (primaryConnections++ === 0 ? primary : latePrimary)),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await expect(
      session.attachVoiceHost({ owner: "owner-1", generation: 1, request: vi.fn() }),
    ).rejects.toThrow("Runtime.addBinding failed");

    expect(latePrimary.close).toHaveBeenCalledOnce();
    await expect(session.executeRenderer("1 + 1")).resolves.toEqual(readyBinding());
    session.close();
    expect(primary.close).toHaveBeenCalledOnce();
  });

  it("closes a late Voice Host binding whose target is gone", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
    const latePrimary = rendererClient();
    const lateOverlay = rendererClient();
    let inventory = [
      target("page-1"),
      target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
    ];
    let primaryConnections = 0;
    let overlayConnections = 0;
    const connect = vi.fn(async (webSocketDebuggerUrl: string) => {
      if (webSocketDebuggerUrl.endsWith("/page-1"))
        return primaryConnections++ === 0 ? primary : latePrimary;
      if (webSocketDebuggerUrl.endsWith("/overlay"))
        return overlayConnections++ === 0 ? overlay : lateOverlay;
      throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
    });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    await session.attachVoiceHost({ owner: "owner-1", generation: 1, request: vi.fn() });

    inventory = [target("page-1")];
    await session.ensureInstalled();

    expect(lateOverlay.close).toHaveBeenCalledOnce();
    expect(latePrimary.close).not.toHaveBeenCalled();
    session.close();
  });

  it("binds an avatar overlay that appears after the late Voice Host attach", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    const lateOverlay = rendererClient();
    let inventory = [target("page-1")];
    let primaryConnections = 0;
    const session = await lateVoiceHostSession({
      inventory: () => inventory,
      connect: async (webSocketDebuggerUrl) => {
        if (webSocketDebuggerUrl.endsWith("/page-1"))
          return primaryConnections++ === 0 ? primary : latePrimary;
        if (webSocketDebuggerUrl.endsWith("/overlay")) return lateOverlay;
        throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
      },
    });
    const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };

    await session.attachVoiceHost(voiceHost);
    expect(lateOverlay.commands).toEqual([]);

    inventory = [
      target("page-1"),
      target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
    ];
    await session.attachVoiceHost(voiceHost);

    expect(lateOverlay.commands.map((item) => item.method)).toContain("Runtime.addBinding");
    expect(primaryConnections).toBe(2);
    session.close();
  });

  it("retries a failed overlay Voice Host binding without rebinding the primary", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      let now = 1_000_000;
      clock.mockImplementation(() => now);
      const primary = rendererClient();
      const latePrimary = rendererClient();
      const overlay = rendererClient();
      overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
      const failingOverlay = rendererClient();
      failingOverlay.command.mockImplementation(async (method, params) => {
        failingOverlay.commands.push({ method, ...(params ? { params } : {}) });
        if (method === "Runtime.addBinding") throw new Error("overlay binding failed");
        return {};
      });
      const healthyOverlay = rendererClient();
      const inventory = [
        target("page-1"),
        target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
      ];
      let primaryConnections = 0;
      let overlayConnections = 0;
      const session = await lateVoiceHostSession({
        inventory: () => inventory,
        connect: async (webSocketDebuggerUrl) => {
          if (webSocketDebuggerUrl.endsWith("/page-1"))
            return primaryConnections++ === 0 ? primary : latePrimary;
          if (webSocketDebuggerUrl.endsWith("/overlay")) {
            overlayConnections += 1;
            if (overlayConnections === 1) return overlay;
            return overlayConnections === 2 ? failingOverlay : healthyOverlay;
          }
          throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
        },
      });
      const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };

      await session.attachVoiceHost(voiceHost);
      await setImmediate();
      expect(failingOverlay.close).toHaveBeenCalledOnce();
      const primaryCommands = latePrimary.commands.length;

      // Inside the retry interval the overlay attempt is skipped; the primary stays bound.
      await session.attachVoiceHost(voiceHost);
      expect(overlayConnections).toBe(2);

      now += 6_000;
      await session.attachVoiceHost(voiceHost);

      expect(overlayConnections).toBe(3);
      expect(healthyOverlay.commands.map((item) => item.method)).toContain("Runtime.addBinding");
      expect(latePrimary.commands).toHaveLength(primaryCommands);
      expect(primaryConnections).toBe(2);
      session.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("rebinds an avatar overlay that disappears and reappears", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
    const firstOverlay = rendererClient();
    const secondOverlay = rendererClient();
    let inventory = [
      target("page-1"),
      target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
    ];
    let primaryConnections = 0;
    let overlayConnections = 0;
    const session = await lateVoiceHostSession({
      inventory: () => inventory,
      connect: async (webSocketDebuggerUrl) => {
        if (webSocketDebuggerUrl.endsWith("/page-1"))
          return primaryConnections++ === 0 ? primary : latePrimary;
        if (webSocketDebuggerUrl.includes("/overlay")) {
          overlayConnections += 1;
          if (overlayConnections === 1) return overlay;
          return overlayConnections === 2 ? firstOverlay : secondOverlay;
        }
        throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
      },
    });
    const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };

    await session.attachVoiceHost(voiceHost);
    expect(firstOverlay.commands.map((item) => item.method)).toContain("Runtime.addBinding");

    inventory = [target("page-1")];
    await session.attachVoiceHost(voiceHost);
    expect(firstOverlay.close).toHaveBeenCalledOnce();

    inventory = [
      target("page-1"),
      target("overlay-2", "app://-/index.html?initialRoute=%2Favatar-overlay"),
    ];
    await session.attachVoiceHost(voiceHost);

    expect(secondOverlay.commands.map((item) => item.method)).toContain("Runtime.addBinding");
    expect(overlayConnections).toBe(3);
    expect(primaryConnections).toBe(2);
    session.close();
  });

  it("replaces only the primary Voice Host binding when the Renderer target changes", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
    const lateOverlay = rendererClient();
    const replacementPrimary = rendererClient();
    const overlayTarget = target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay");
    let inventory = [target("page-1"), overlayTarget];
    let primaryConnections = 0;
    let overlayConnections = 0;
    const session = await lateVoiceHostSession({
      inventory: () => inventory,
      connect: async (webSocketDebuggerUrl) => {
        if (webSocketDebuggerUrl.endsWith("/page-1"))
          return primaryConnections++ === 0 ? primary : latePrimary;
        if (webSocketDebuggerUrl.endsWith("/page-2")) return replacementPrimary;
        if (webSocketDebuggerUrl.endsWith("/overlay"))
          return overlayConnections++ === 0 ? overlay : lateOverlay;
        throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
      },
    });
    const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };

    await session.attachVoiceHost(voiceHost);
    expect(lateOverlay.commands.map((item) => item.method)).toContain("Runtime.addBinding");
    const overlayConnectionsBefore = overlayConnections;

    inventory = [target("page-2"), overlayTarget];
    await session.ensureInstalled();

    expect(latePrimary.close).toHaveBeenCalledOnce();
    expect(lateOverlay.close).not.toHaveBeenCalled();

    await session.attachVoiceHost(voiceHost);

    expect(replacementPrimary.commands.map((item) => item.method)).toContain("Runtime.addBinding");
    expect(overlayConnections).toBe(overlayConnectionsBefore);
    expect(lateOverlay.close).not.toHaveBeenCalled();
    session.close();
  });

  it("binds a late avatar overlay only when an overlay hook source is installed", async () => {
    const overlayTarget = target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay");
    async function bindLateOverlay(overlayHookSource: string | null) {
      const primary = rendererClient();
      const latePrimary = rendererClient();
      const overlay = rendererClient();
      const lateOverlay = rendererClient();
      const connections: string[] = [];
      let primaryConnections = 0;
      let overlayConnections = 0;
      const session = await lateVoiceHostSession({
        inventory: () => [target("page-1"), overlayTarget],
        overlayHookSource,
        connect: async (webSocketDebuggerUrl) => {
          connections.push(webSocketDebuggerUrl.split("/").at(-1) ?? "");
          if (webSocketDebuggerUrl.endsWith("/page-1"))
            return primaryConnections++ === 0 ? primary : latePrimary;
          if (webSocketDebuggerUrl.endsWith("/overlay"))
            return overlayConnections++ === 0 ? overlay : lateOverlay;
          throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
        },
      });
      await session.attachVoiceHost({
        owner: "owner-1",
        generation: 1,
        request: vi.fn(async () => ({})),
      });
      return { session, connections, overlay, lateOverlay };
    }

    const disabled = await bindLateOverlay(null);
    try {
      expect(disabled.connections).toEqual(["page-1", "page-1"]);
      expect(disabled.overlay.commands).toEqual([]);
      expect(disabled.lateOverlay.commands).toEqual([]);
    } finally {
      disabled.session.close();
    }

    const allowed = await bindLateOverlay("overlay hook only");
    try {
      expect(allowed.connections).toEqual(["page-1", "overlay", "page-1", "overlay"]);
      expect(allowed.overlay.commands.map((item) => item.method)).not.toContain(
        "Runtime.addBinding",
      );
      expect(allowed.lateOverlay.commands.map((item) => item.method)).toContain(
        "Runtime.addBinding",
      );
    } finally {
      allowed.session.close();
    }
  });

  it("rebinds a late Voice Host whose target stays listed after its connection dies", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      let now = 1_000_000;
      clock.mockImplementation(() => now);
      const primary = rendererClient();
      const deadPrimary = rendererClient();
      const replacementPrimary = rendererClient();
      const connections = [primary, deadPrimary, replacementPrimary];
      let connected = 0;
      const session = await lateVoiceHostSession({
        inventory: () => [target("page-1")],
        connect: async (webSocketDebuggerUrl) => {
          if (!webSocketDebuggerUrl.endsWith("/page-1"))
            throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
          const client = connections[connected];
          if (!client) throw new Error("unexpected Renderer connection");
          connected += 1;
          return client;
        },
      });
      const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };
      try {
        await session.attachVoiceHost(voiceHost);
        expect(deadPrimary.commands.map((item) => item.method)).toContain("Runtime.addBinding");

        deadPrimary.evaluateSpy.mockRejectedValue(
          new CdpConnectionClosedError("CDP WebSocket closed"),
        );
        now += 6_000;
        await session.attachVoiceHost(voiceHost);

        // The dead connection is closed before the replacement publishes.
        expect(deadPrimary.close).toHaveBeenCalledOnce();
        expect(replacementPrimary.commands.map((item) => item.method)).toContain(
          "Runtime.addBinding",
        );
        expect(connected).toBe(3);
        // Recovery re-publishes the binding and never replays a page request.
        expect(voiceHost.request).not.toHaveBeenCalled();
      } finally {
        session.close();
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("retires a late Voice Host connection that stops answering", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      let now = 1_000_000;
      clock.mockImplementation(() => now);
      const primary = rendererClient();
      const stalledPrimary = rendererClient();
      const replacementPrimary = rendererClient();
      const connections = [primary, stalledPrimary, replacementPrimary];
      let connected = 0;
      const session = await lateVoiceHostSession({
        inventory: () => [target("page-1")],
        connect: async (webSocketDebuggerUrl) => {
          if (!webSocketDebuggerUrl.endsWith("/page-1"))
            throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
          const client = connections[connected];
          if (!client) throw new Error("unexpected Renderer connection");
          connected += 1;
          return client;
        },
      });
      const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };
      try {
        await session.attachVoiceHost(voiceHost);
        stalledPrimary.evaluateSpy.mockImplementation(() => new Promise<never>(() => {}));
        now += 6_000;
        await session.attachVoiceHost(voiceHost);

        expect(stalledPrimary.close).toHaveBeenCalledOnce();
        expect(stalledPrimary.evaluateSpy).toHaveBeenCalledWith(
          "1",
          VOICE_HOST_LIVENESS_TIMEOUT_MS,
        );
        expect(replacementPrimary.commands.map((item) => item.method)).toContain(
          "Runtime.addBinding",
        );
        expect(connected).toBe(3);
      } finally {
        session.close();
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a late Voice Host connection whose probe answers while the Renderer is busy", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      let now = 1_000_000;
      clock.mockImplementation(() => now);
      const primary = rendererClient();
      const latePrimary = rendererClient();
      let connected = 0;
      const session = await lateVoiceHostSession({
        inventory: () => [target("page-1")],
        connect: async () => {
          const client = connected === 0 ? primary : latePrimary;
          connected += 1;
          return client;
        },
      });
      const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };
      try {
        await session.attachVoiceHost(voiceHost);
        // An active call keeps the Renderer busy past a normal round trip. The
        // connection still answers inside the probe bound, so its binding must
        // survive instead of being retired and cancelling the call.
        latePrimary.evaluateSpy.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(1), VOICE_HOST_LIVENESS_TIMEOUT_MS / 2),
            ),
        );
        now += 6_000;
        await session.attachVoiceHost(voiceHost);

        expect(latePrimary.close).not.toHaveBeenCalled();
        expect(connected).toBe(2);
        expect(
          latePrimary.commands.filter((item) => item.method === "Runtime.addBinding"),
        ).toHaveLength(1);
      } finally {
        session.close();
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a live late Voice Host binding across monitor passes", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      let now = 1_000_000;
      clock.mockImplementation(() => now);
      const primary = rendererClient();
      const latePrimary = rendererClient();
      let connected = 0;
      const session = await lateVoiceHostSession({
        inventory: () => [target("page-1")],
        connect: async (webSocketDebuggerUrl) => {
          if (!webSocketDebuggerUrl.endsWith("/page-1"))
            throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
          const client = connected === 0 ? primary : connected === 1 ? latePrimary : undefined;
          if (!client) throw new Error("unexpected Renderer connection");
          connected += 1;
          return client;
        },
      });
      const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };
      try {
        await session.attachVoiceHost(voiceHost);
        now += 6_000;
        await session.attachVoiceHost(voiceHost);

        expect(connected).toBe(2);
        expect(latePrimary.close).not.toHaveBeenCalled();
        expect(latePrimary.evaluateSpy).toHaveBeenCalledWith("1", VOICE_HOST_LIVENESS_TIMEOUT_MS);
        expect(
          latePrimary.commands.filter((item) => item.method === "Runtime.addBinding"),
        ).toHaveLength(1);
      } finally {
        session.close();
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("rebinds a dead avatar overlay binding without disturbing the primary", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      let now = 1_000_000;
      clock.mockImplementation(() => now);
      const primary = rendererClient();
      const latePrimary = rendererClient();
      const overlay = rendererClient();
      const deadOverlay = rendererClient();
      const reboundOverlay = rendererClient();
      let primaryConnections = 0;
      let overlayConnections = 0;
      const session = await lateVoiceHostSession({
        inventory: () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ],
        connect: async (webSocketDebuggerUrl) => {
          if (webSocketDebuggerUrl.endsWith("/page-1"))
            return primaryConnections++ === 0 ? primary : latePrimary;
          if (webSocketDebuggerUrl.endsWith("/overlay")) {
            overlayConnections += 1;
            if (overlayConnections === 1) return overlay;
            return overlayConnections === 2 ? deadOverlay : reboundOverlay;
          }
          throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
        },
      });
      const voiceHost = { owner: "owner-1", generation: 1, request: vi.fn(async () => ({})) };
      try {
        await session.attachVoiceHost(voiceHost);
        expect(deadOverlay.commands.map((item) => item.method)).toContain("Runtime.addBinding");
        const primaryCommands = latePrimary.commands.length;

        deadOverlay.evaluateSpy.mockRejectedValue(
          new CdpConnectionClosedError("CDP WebSocket closed"),
        );
        now += 6_000;
        await session.attachVoiceHost(voiceHost);

        expect(deadOverlay.close).toHaveBeenCalledOnce();
        expect(reboundOverlay.commands.map((item) => item.method)).toContain("Runtime.addBinding");
        expect(latePrimary.commands).toHaveLength(primaryCommands);
        expect(latePrimary.close).not.toHaveBeenCalled();
        expect(primaryConnections).toBe(2);
        expect(overlayConnections).toBe(3);
      } finally {
        session.close();
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("stops late overlay discovery when the session closes", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    const overlay = rendererClient();
    const pendingDiscovery: Array<(targets: CdpTarget[]) => void> = [];
    let listCalls = 0;
    let primaryConnections = 0;
    const connect = vi.fn(async (webSocketDebuggerUrl: string) => {
      if (webSocketDebuggerUrl.endsWith("/page-1"))
        return primaryConnections++ === 0 ? primary : latePrimary;
      if (webSocketDebuggerUrl.endsWith("/overlay")) return overlay;
      throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
    });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 2_000,
      operations: {
        listTargets: vi.fn(async () => {
          listCalls += 1;
          if (listCalls <= 2) return [target("page-1")];
          return new Promise<CdpTarget[]>((resolve) => pendingDiscovery.push(resolve));
        }),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    const attaching = session.attachVoiceHost({
      owner: "owner-1",
      generation: 1,
      request: vi.fn(async () => ({})),
    });
    await vi.waitFor(() => expect(listCalls).toBe(3));

    session.close();
    await expect(attaching).rejects.toThrow("closed");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(overlay.commands).toEqual([]);

    for (const resolve of pendingDiscovery)
      resolve([
        target("page-1"),
        target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
      ]);
    await setImmediate();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("closes a late overlay connection that opens after the session closes", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    const overlay = rendererClient();
    let releaseOverlay!: (client: ReturnType<typeof rendererClient>) => void;
    const opening = new Promise<ReturnType<typeof rendererClient>>((resolve) => {
      releaseOverlay = resolve;
    });
    let inventory = [target("page-1")];
    let primaryConnections = 0;
    let overlayConnections = 0;
    const session = await lateVoiceHostSession({
      timeoutMs: 2_000,
      inventory: () => inventory,
      connect: async (webSocketDebuggerUrl) => {
        if (webSocketDebuggerUrl.endsWith("/page-1"))
          return primaryConnections++ === 0 ? primary : latePrimary;
        if (webSocketDebuggerUrl.endsWith("/overlay")) {
          overlayConnections += 1;
          return opening;
        }
        throw new Error(`unexpected Renderer target: ${webSocketDebuggerUrl}`);
      },
    });
    inventory = [
      target("page-1"),
      target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
    ];
    const attaching = session.attachVoiceHost({
      owner: "owner-1",
      generation: 1,
      request: vi.fn(async () => ({})),
    });
    await vi.waitFor(() => expect(overlayConnections).toBe(1));

    session.close();
    await expect(attaching).rejects.toThrow("closed");

    releaseOverlay(overlay);
    await setImmediate();
    expect(overlay.close).toHaveBeenCalledOnce();
    expect(overlay.commands).toEqual([]);
  });

  it("releases a late Voice Host connection that completes after the session closes", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    let releaseBinding!: () => void;
    const bindingStarted = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    latePrimary.command.mockImplementation(async (method, params) => {
      latePrimary.commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.addBinding") await bindingStarted;
      return {};
    });
    let primaryConnections = 0;
    const session = await lateVoiceHostSession({
      timeoutMs: 2_000,
      inventory: () => [target("page-1")],
      connect: async () => (primaryConnections++ === 0 ? primary : latePrimary),
    });
    const attaching = session.attachVoiceHost({
      owner: "owner-1",
      generation: 1,
      request: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(latePrimary.commands.map((item) => item.method)).toContain("Runtime.addBinding"),
    );

    session.close();
    releaseBinding();

    await expect(attaching).rejects.toThrow("closed");
    expect(latePrimary.close).toHaveBeenCalledOnce();
  });

  it("stops a late Voice Host binding that is still installing at its deadline", async () => {
    const primary = rendererClient();
    const latePrimary = rendererClient();
    let releaseEnable!: () => void;
    const enableStarted = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    latePrimary.command.mockImplementation(async (method, params) => {
      if (latePrimary.close.mock.calls.length > 0) throw new Error("CDP client is closed");
      latePrimary.commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.enable") await enableStarted;
      return {};
    });
    let primaryConnections = 0;
    const session = await lateVoiceHostSession({
      inventory: () => [target("page-1")],
      connect: async () => (primaryConnections++ === 0 ? primary : latePrimary),
    });

    await expect(
      session.attachVoiceHost({ owner: "owner-1", generation: 1, request: vi.fn() }),
    ).rejects.toThrow(/timed out|timeout/i);
    // The deadline closes the connection, which drops the binding's listeners.
    expect(latePrimary.close).toHaveBeenCalledOnce();

    releaseEnable();
    await setImmediate();
    await setImmediate();
    // Nothing publishes after the deadline, so no capability can outlive the attempt.
    expect(latePrimary.commands.map((item) => item.method)).not.toContain("Runtime.addBinding");
    expect(latePrimary.listenerCount()).toBe(0);
    session.close();
  });

  it("re-evaluates an idle overlay when source digest changes with a stable identity", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "work-codex", call: "idle" }),
    );
    const firstSource = overlayFreezeSource({
      revision: "rev-a",
      path: "work-codex",
      wrapper: "wrap-a",
    });
    const first = await overlayControlSession(overlay, firstSource);
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: firstSource, awaitPromise: true },
    });
    first.session.close();
    overlay.commands.length = 0;
    const secondSource = overlayFreezeSource({
      revision: "rev-a",
      path: "work-codex",
      wrapper: "wrap-b",
    });
    const second = await overlayControlSession(overlay, secondSource);
    expect(overlay.commands).toContainEqual({
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: secondSource },
    });
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: secondSource, awaitPromise: true },
    });
    second.session.close();
  });

  it.each(["active", "unknown"] as const)(
    "retries a staged overlay refresh once an %s call becomes idle",
    async (call) => {
      const overlay = rendererClient();
      overlay.evaluateSpy.mockResolvedValue(
        overlayLiveSnapshot({ revision: "rev-a", path: "chat", call }),
      );
      const source = overlayFreezeSource({ revision: "rev-b", path: "work-codex" });
      const { session } = await overlayControlSession(overlay, source);
      expect(
        overlay.commands.some(
          ({ method, params }) => method === "Runtime.evaluate" && params?.expression === source,
        ),
      ).toBe(false);
      overlay.commands.length = 0;
      overlay.evaluateSpy.mockResolvedValue(
        overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
      );
      await session.ensureInstalled();
      expect(overlay.commands).toContainEqual({
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      });
      session.close();
    },
  );

  it.each(["active", "unknown"] as const)(
    "retries a digest-only overlay refresh once an %s call becomes idle",
    async (call) => {
      const overlay = rendererClient();
      overlay.evaluateSpy.mockResolvedValue(
        overlayLiveSnapshot({ revision: "rev-a", path: "work-codex", call }),
      );
      const source = overlayFreezeSource({
        revision: "rev-a",
        path: "work-codex",
        wrapper: "wrap-b",
      });
      const { session } = await overlayControlSession(overlay, source);
      expect(
        overlay.commands.some(
          ({ method, params }) => method === "Runtime.evaluate" && params?.expression === source,
        ),
      ).toBe(false);
      overlay.commands.length = 0;
      overlay.evaluateSpy.mockResolvedValue(
        overlayLiveSnapshot({ revision: "rev-a", path: "work-codex", call: "idle" }),
      );
      await session.ensureInstalled();
      expect(overlay.commands).toContainEqual({
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      });
      session.close();
    },
  );

  it("defers current overlay eval when snapshot inspection fails, then retries once idle", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockRejectedValue(new Error("snapshot inspection failed"));
    const source = overlayFreezeSource({ revision: "rev-b", path: "work-codex" });
    const { session } = await overlayControlSession(overlay, source);
    expect(
      overlay.commands.some(
        ({ method, params }) => method === "Runtime.evaluate" && params?.expression === source,
      ),
    ).toBe(false);
    expect(overlay.commands).toContainEqual({
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source },
    });
    overlay.commands.length = 0;
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    await session.ensureInstalled();
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: source, awaitPromise: true },
    });
    session.close();
  });

  it("does not treat a boolean overlay snapshot as idle", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(false);
    const source = overlayFreezeSource({ revision: "rev-b", path: "work-codex" });
    const { session } = await overlayControlSession(overlay, source);
    expect(
      overlay.commands.some(
        ({ method, params }) => method === "Runtime.evaluate" && params?.expression === source,
      ),
    ).toBe(false);
    overlay.commands.length = 0;
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    await session.ensureInstalled();
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: source, awaitPromise: true },
    });
    session.close();
  });

  it("re-evaluates an enabled overlay when isolated identity changes and the call is idle", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    const source = overlayFreezeSource({
      revision: "rev-b",
      path: "work-codex",
      wrapper: "work-wrap",
    });
    const { session } = await overlayControlSession(overlay, source);
    expect(overlay.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
      {
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      },
    ]);
    session.close();
  });

  it("stages later-document overlay identity and does not eval an active call", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "active" }),
    );
    const source = overlayFreezeSource({ revision: "rev-b", path: "work-codex" });
    const { session } = await overlayControlSession(overlay, source);
    expect(overlay.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
    ]);
    expect(overlay.commands.some(({ params }) => params?.expression === source)).toBe(false);
    session.close();
  });

  it("does not treat a missing native Chat handle as idle when overlay identity differs", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue({
      enabled: true,
      revision: "rev-a",
      isolatedPath: "chat",
      isolatedRun: "run-1",
      isolatedExpiresAt: "2026-11-15T07:40:00.000Z",
      appPath: "/scratch/ChatGPT.app",
    });
    const source = overlayFreezeSource({ revision: "rev-b", path: "work-codex" });
    const { session } = await overlayControlSession(overlay, source);
    expect(
      overlay.commands.some(
        ({ method, params }) => method === "Runtime.evaluate" && params?.expression === source,
      ),
    ).toBe(false);
    expect(overlay.commands).toContainEqual({
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source },
    });
    session.close();
  });

  it("refreshes an idle overlay when isolated candidate paths change", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    const chat = overlayFreezeSource({ revision: "rev-a", path: "chat", wrapper: "chat-wrap" });
    const first = await overlayControlSession(overlay, chat);
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: chat, awaitPromise: true },
    });
    first.session.close();
    overlay.commands.length = 0;
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    const both = overlayFreezeSource({
      revision: "rev-a",
      path: "chat",
      paths: ["chat", "work-codex"],
      wrapper: "both-wrap",
    });
    const second = await overlayControlSession(overlay, both);
    expect(overlay.commands).toContainEqual({
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: both },
    });
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: both, awaitPromise: true },
    });
    second.session.close();
  });

  it("defers an isolated path-set refresh while the overlay call is active", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "active" }),
    );
    const both = overlayFreezeSource({
      revision: "rev-a",
      path: "chat",
      paths: ["chat", "work-codex"],
      wrapper: "both-wrap",
    });
    const { session } = await overlayControlSession(overlay, both);
    expect(
      overlay.commands.some(
        ({ method, params }) => method === "Runtime.evaluate" && params?.expression === both,
      ),
    ).toBe(false);
    overlay.commands.length = 0;
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    await session.ensureInstalled();
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: both, awaitPromise: true },
    });
    session.close();
  });

  it("refreshes an idle overlay when isolated desktopPlatform changes", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({
        revision: "rev-a",
        path: "chat",
        call: "idle",
        desktopPlatform: "darwin",
      }),
    );
    const next = overlayFreezeSource({
      revision: "rev-a",
      path: "chat",
      desktopPlatform: "win32",
      wrapper: "platform-wrap",
    });
    const { session } = await overlayControlSession(overlay, next);
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: next, awaitPromise: true },
    });
    session.close();
  });

  it("defers an isolated platform refresh while the overlay call is active", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({
        revision: "rev-a",
        path: "chat",
        call: "active",
        desktopPlatform: "darwin",
      }),
    );
    const next = overlayFreezeSource({
      revision: "rev-a",
      path: "chat",
      desktopPlatform: "win32",
      wrapper: "platform-wrap",
    });
    const { session } = await overlayControlSession(overlay, next);
    expect(
      overlay.commands.some(
        ({ method, params }) => method === "Runtime.evaluate" && params?.expression === next,
      ),
    ).toBe(false);
    session.close();
  });

  it("refreshes an existing enabled overlay after a later controller source with a new marker", async () => {
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(
      overlayLiveSnapshot({ revision: "rev-a", path: "chat", call: "idle" }),
    );
    const chat = overlayFreezeSource({ revision: "rev-a", path: "chat", wrapper: "chat-wrap" });
    const first = await overlayControlSession(overlay, chat);
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: chat, awaitPromise: true },
    });
    first.session.close();
    overlay.commands.length = 0;
    const work = overlayFreezeSource({
      revision: "rev-b",
      path: "work-codex",
      wrapper: "work-wrap",
    });
    const second = await overlayControlSession(overlay, work);
    expect(overlay.commands).toContainEqual({
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: work },
    });
    expect(overlay.commands).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: work, awaitPromise: true },
    });
    second.session.close();
  });

  it.each(["connect", "command", "evaluate"] as const)(
    "bounds stalled overlay %s operations without blocking other overlays",
    async (stage) => {
      const primary = rendererClient();
      const stalled = rendererClient();
      const healthy = rendererClient();
      healthy.evaluateSpy.mockResolvedValue({ enabled: false, call: "idle" });
      let finishConnect: ((client: typeof stalled) => void) | undefined;
      const pendingConnect = new Promise<typeof stalled>((resolve) => {
        finishConnect = resolve;
      });
      if (stage === "command") {
        stalled.command.mockImplementation(() => new Promise(() => {}));
      }
      if (stage === "evaluate") {
        stalled.evaluateSpy.mockImplementation(() => new Promise(() => {}));
      }
      const session = await createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        overlayHookSource: "overlay hook only",
        timeoutMs: 40,
        operations: {
          listTargets: async () => [
            target("page-1"),
            target("stalled", "app://-/avatar-overlay.html"),
            target("healthy", "app://-/avatar-overlay.html"),
          ],
          connect: async (url) => {
            if (url.endsWith("/stalled")) return stage === "connect" ? pendingConnect : stalled;
            return url.endsWith("/healthy") ? healthy : primary;
          },
          installDraftPrewarmPolicy: async () => ({
            state: "ready",
            reason: "owned-request-bridge",
          }),
        },
      });
      try {
        expect(session.snapshot.binding).toEqual(readyBinding());
        expect(primary.close).not.toHaveBeenCalled();
        expect(healthy.commands).toContainEqual({
          method: "Runtime.evaluate",
          params: { expression: "overlay hook only", awaitPromise: true },
        });
        expect(healthy.close).not.toHaveBeenCalled();
        if (stage === "connect") {
          expect(stalled.close).not.toHaveBeenCalled();
          finishConnect?.(stalled);
          await vi.waitFor(() => expect(stalled.close).toHaveBeenCalledOnce());
          expect(stalled.command).not.toHaveBeenCalled();
        } else {
          expect(stalled.close).toHaveBeenCalledOnce();
        }
        await expect(session.ensureInstalled()).resolves.toMatchObject({ binding: readyBinding() });
        expect(healthy.close).not.toHaveBeenCalled();
      } finally {
        session.close();
      }
      expect(healthy.close).toHaveBeenCalledOnce();
    },
  );

  it("stops waiting for binding when the target connection closes", async () => {
    const client = rendererClient();
    const closed = new CdpConnectionClosedError("CDP WebSocket closed");
    client.evaluateSpy.mockRejectedValueOnce(closed);
    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        pollIntervalMs: 1,
        timeoutMs: 100,
        operations: {
          listTargets: async () => [target("page-1")],
          connect: async () => client,
          installDraftPrewarmPolicy: async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          }),
        },
      }),
    ).rejects.toBe(closed);
    expect(client.evaluateSpy).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reconciles a changed Host before judging the previous Adapter readiness", async () => {
    const binding = readyBinding();
    const client = rendererClient(binding);
    const connect = vi.fn(async () => client);
    const installDraftPrewarmPolicy = vi.fn(async () => {
      binding.adapter.state = "ready";
      binding.adapter.reason = "ready";
      return { state: "ready" as const, reason: "owned-request-bridge" as const };
    });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: async () => [target("page-1")],
        connect,
        installDraftPrewarmPolicy,
      },
    });
    try {
      binding.adapter.state = "installing";
      binding.adapter.reason = "draft-routing-policy-unavailable";
      await expect(session.ensureInstalled()).resolves.toMatchObject({
        binding: { adapter: { state: "ready" } },
      });
      expect(connect).toHaveBeenCalledOnce();
      expect(client.close).not.toHaveBeenCalled();
      expect(installDraftPrewarmPolicy).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }
  });

  it("activates the owned page target", async () => {
    const client = rendererClient();
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await expect(session.activateDesktop()).resolves.toBe(1);
    expect(client.command).toHaveBeenLastCalledWith("Page.bringToFront");
    session.close();
  });

  it("accepts the Renderer Agent list in its own presentation order", async () => {
    const client = rendererClient({
      version: 2,
      enabledAgents: ["pi", "codex"],
      adapter: { state: "ready", reason: "ready" },
    } as never);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      enabledAgents: ["codex", "pi"],
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await expect(session.ensureInstalled()).resolves.toMatchObject({
      binding: { enabledAgents: ["pi", "codex"] },
    });
    // A healthy check must not re-run the Renderer bundle, which remounts every Composer control.
    expect(
      client.commands.filter(
        ({ method, params }) =>
          method === "Runtime.evaluate" && params?.expression === "production renderer",
      ),
    ).toHaveLength(1);
    session.close();
  });

  it("fails closed when CDP target discovery hangs past its timeout", async () => {
    const client = rendererClient();
    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        pollIntervalMs: 10,
        timeoutMs: 40,
        operations: {
          listTargets: vi.fn((_endpoint, signal) => {
            return new Promise<CdpTarget[]>((_resolve, reject) => {
              const fail = (): void => reject(new Error("Renderer CDP target discovery timed out"));
              if (signal?.aborted) {
                fail();
                return;
              }
              signal?.addEventListener("abort", fail, { once: true });
            });
          }),
          connect: vi.fn(async () => client),
          installDraftPrewarmPolicy: vi.fn(async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          })),
        },
      }),
    ).rejects.toThrow("Primary Codex Renderer CDP target did not become ready");
    expect(client.close).not.toHaveBeenCalled();
  });

  it("keeps the primary session when overlay CDP discovery hangs past its timeout", async () => {
    const primary = rendererClient();
    let calls = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 10,
      timeoutMs: 40,
      operations: {
        listTargets: vi.fn((_endpoint, signal) => {
          calls += 1;
          if (calls % 2 === 1) return Promise.resolve([target("page-1")]);
          return new Promise<CdpTarget[]>((_resolve, reject) => {
            const fail = (): void => reject(new Error("Overlay CDP target discovery timed out"));
            if (signal?.aborted) {
              fail();
              return;
            }
            signal?.addEventListener("abort", fail, { once: true });
          });
        }),
        connect: vi.fn(async () => primary),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(session.snapshot.binding).toEqual(readyBinding());
    await expect(session.ensureInstalled()).resolves.toMatchObject({
      binding: readyBinding(),
    });
    expect(primary.close).not.toHaveBeenCalled();
    session.close();
  });

  it("fails closed when the injected Adapter is unsupported", async () => {
    const client = rendererClient({
      version: 2,
      enabledAgents: ["codex", "pi"],
      adapter: { state: "unsupported", reason: "signature-mismatch" },
    } as never);
    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        pollIntervalMs: 1,
        timeoutMs: 100,
        operations: {
          listTargets: vi.fn(async () => [target("page-1")]),
          connect: vi.fn(async () => client),
          installDraftPrewarmPolicy: vi.fn(async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          })),
        },
      }),
    ).rejects.toThrow("Production Renderer Adapter is unsupported: signature-mismatch");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reconnects and installs a replacement primary target", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).resolves.toMatchObject({
      target: { id: "page-2" },
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    await session.executeRenderer("42");
    expect(replacement.evaluateSpy).toHaveBeenLastCalledWith("42", undefined);
    await session.executeRenderer("longRemoteOperation()", 40_000);
    expect(replacement.evaluateSpy).toHaveBeenLastCalledWith("longRemoteOperation()", 40_000);
    session.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("does not replace the installed snapshot when replacement installation fails", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    let installs = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement),
        installDraftPrewarmPolicy: vi.fn(async () => {
          installs += 1;
          if (installs > 1) throw new Error("request manager unavailable");
          return { state: "ready" as const, reason: "owned-request-bridge" as const };
        }),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).rejects.toThrow("request manager unavailable");
    expect(session.snapshot.target.id).toBe("page-1");
    expect(first.close).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledOnce();
    session.close();
  });

  it("stops ensureInstalled at target discovery when the session closes", async () => {
    const primary = rendererClient();
    const pendingDiscovery: Array<(targets: CdpTarget[]) => void> = [];
    let listCalls = 0;
    const connect = vi.fn(async () => primary);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 30_000,
      operations: {
        listTargets: vi.fn(async () => {
          listCalls += 1;
          if (listCalls <= 2) return [target("page-1")];
          return new Promise<CdpTarget[]>((resolve) => pendingDiscovery.push(resolve));
        }),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    const checking = session.ensureInstalled();
    await vi.waitFor(() => expect(listCalls).toBe(3));

    session.close();
    await expect(checking).rejects.toThrow("closed");
    expect(connect).toHaveBeenCalledOnce();

    for (const resolve of pendingDiscovery) resolve([target("page-1")]);
    await setImmediate();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("releases a replacement connection that opens after the session closes", async () => {
    const primary = rendererClient();
    const replacement = rendererClient();
    let releaseReplacement!: (client: ReturnType<typeof rendererClient>) => void;
    const opening = new Promise<ReturnType<typeof rendererClient>>((resolve) => {
      releaseReplacement = resolve;
    });
    let inventory = [target("page-1")];
    let connects = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 30_000,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn(async () => {
          connects += 1;
          return connects === 1 ? primary : opening;
        }),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    inventory = [target("page-2")];
    const checking = session.ensureInstalled();
    await vi.waitFor(() => expect(connects).toBe(2));

    session.close();
    await expect(checking).rejects.toThrow("closed");
    expect(session.snapshot.target.id).toBe("page-1");

    releaseReplacement(replacement);
    await setImmediate();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.commands).toEqual([]);
  });

  it("releases a replacement that is still installing when the session closes", async () => {
    const primary = rendererClient();
    const replacement = rendererClient();
    let releasePolicy!: () => void;
    const policyStarted = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    let inventory = [target("page-1")];
    let installs = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 30_000,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(replacement),
        installDraftPrewarmPolicy: vi.fn(async () => {
          installs += 1;
          if (installs > 1) await policyStarted;
          return { state: "ready" as const, reason: "owned-request-bridge" as const };
        }),
      },
    });
    inventory = [target("page-2")];
    const checking = session.ensureInstalled();
    await vi.waitFor(() => expect(installs).toBe(2));

    session.close();
    await expect(checking).rejects.toThrow("closed");
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.listenerCount()).toBe(0);
    expect(session.snapshot.target.id).toBe("page-1");

    releasePolicy();
    await setImmediate();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("does not commit an auxiliary connection that opens after the session closes", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    let releaseOverlay!: (client: ReturnType<typeof rendererClient>) => void;
    const opening = new Promise<ReturnType<typeof rendererClient>>((resolve) => {
      releaseOverlay = resolve;
    });
    let inventory = [target("page-1")];
    let overlayConnects = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 30_000,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn(async (webSocketDebuggerUrl: string) => {
          if (!webSocketDebuggerUrl.endsWith("/overlay")) return primary;
          overlayConnects += 1;
          return opening;
        }),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    inventory = [
      target("page-1"),
      target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
    ];
    const checking = session.ensureInstalled();
    await vi.waitFor(() => expect(overlayConnects).toBe(1));

    session.close();
    await expect(checking).rejects.toThrow("closed");

    releaseOverlay(overlay);
    await setImmediate();
    expect(overlay.close).toHaveBeenCalledOnce();
    expect(overlay.commands).toEqual([]);
  });

  it("releases an auxiliary connection that is still installing when the session closes", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    let releaseEnable!: () => void;
    const enabling = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    overlay.command.mockImplementation(async (method, params) => {
      overlay.commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Page.enable") await enabling;
      return {};
    });
    let inventory = [target("page-1")];
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 30_000,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn(async (webSocketDebuggerUrl: string) =>
          webSocketDebuggerUrl.endsWith("/overlay") ? overlay : primary,
        ),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    inventory = [
      target("page-1"),
      target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
    ];
    const checking = session.ensureInstalled();
    await vi.waitFor(() =>
      expect(overlay.commands.map((item) => item.method)).toContain("Page.enable"),
    );

    session.close();
    await expect(checking).rejects.toThrow("closed");
    expect(overlay.close).toHaveBeenCalledOnce();

    releaseEnable();
    await setImmediate();
    expect(overlay.commands.map((item) => item.method)).toEqual(["Runtime.enable", "Page.enable"]);
  });
});
