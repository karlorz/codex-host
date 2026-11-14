import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  CPA_LIVE_VOICE_HOOK_GLOBAL,
} from "../src/renderer-cpa-live-voice-hook.js";
import { CLIENT_OWNED_VOICE_ASSETS } from "../src/renderer-client-owned-voice.js";
import {
  installExternalVoiceLaunchHook,
  ownedChatgptChatStartUnavailable,
  routeExternalVoiceLaunch,
} from "../src/renderer-external-voice-launch.js";
import { applySharedVoiceRoutes } from "../src/renderer-cpa-live-voice-preference.js";
import {
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
} from "../src/renderer-hashed-native-chat-voice.js";
import { hashedVoiceTestIdentity } from "./voice-evidence-fixture.js";
import { voiceImplementationRevision } from "../src/renderer-voice-profiles.js";

const carrier = "codexhost/plugin-v1@grok-test-model-permission";
const source = "composer_button_new_thread";
const request = () => ({
  source,
  activeCollaborationMode: {
    mode: "default",
    settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: "keep" },
  },
  projectId: "project-1",
  pageCompanion: null,
});

function routingFixture() {
  const policy = { selectedModel: vi.fn<() => string | null>(() => carrier) };
  const route = { hostId: "local", policy };
  const routing = {
    forComposer: vi.fn(() => route),
    forHost: vi.fn((hostId: string) => (hostId === route.hostId ? route : null)),
  } as unknown as RendererHostRouting;
  return { policy, route, routing };
}

function hookFixture() {
  const { routing, policy } = routingFixture();
  const start = vi.fn(function (this: unknown, ...args: unknown[]) {
    return { receiver: this, args };
  });
  const other = vi.fn();
  // Native services are a plain decoded record containing immutable RPC stubs.
  const runtime = new Proxy(
    { requestRealtimeStart: start, registerRealtimeStarter: other },
    {
      set() {
        throw new Error("Can't assign properties on RPC stubs.");
      },
      defineProperty() {
        throw new Error("Can't define properties on RPC stubs.");
      },
    },
  );
  const services = { realtimeVoiceRuntime: runtime, untouched: {} };
  const names = [AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET, "app-shared-8bd9d0399038.js"];
  const target = {
    [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
      enabled: true,
      auditedDesktopVersion: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
      auditedAppInitialAsset: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
    },
    __codexhostHostRoutingV1: routing,
    document: {
      querySelectorAll: () => names.map((name) => ({ getAttribute: () => `/assets/${name}` })),
    } as unknown as ParentNode,
    setTimeout,
    clearTimeout,
  };
  const importModule = vi.fn(async () => ({ fN: services }));
  return { policy, services, runtime, start, other, names, target, importModule };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("native new-voice selection", () => {
  it("forwards native Codex Work through the installed hook despite a saved Cursor default", async () => {
    const f = hookFixture();
    f.policy.selectedModel.mockReturnValue(null);
    Object.assign(f.target, {
      localStorage: {
        getItem: () => JSON.stringify({ version: 1, lastAgent: "cursor-cli" }),
      },
    });
    const hook = installExternalVoiceLaunchHook(f);
    await settle();
    const original = { ...request(), productExperience: "work" };
    f.services.realtimeVoiceRuntime.requestRealtimeStart(original);
    expect(f.start).toHaveBeenCalledExactlyOnceWith(original);
    expect(original.activeCollaborationMode.settings.model).toBe("gpt-6.1-sol");
    hook.dispose();
  });

  it.each(CLIENT_OWNED_VOICE_ASSETS)(
    "keeps the selected Harness on Desktop $version",
    async (assets) => {
      const f = hookFixture();
      f.names.splice(0, f.names.length, assets.initial, assets.shared);
      Reflect.set(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], "desktopVersion", assets.version);
      const hook = installExternalVoiceLaunchHook({
        target: f.target,
        importModule: async () => ({ [assets.services]: f.services }),
      });
      await settle();
      expect(hook.status).toBe("active");
      const routed = f.services.realtimeVoiceRuntime.requestRealtimeStart(request()) as {
        args: unknown[];
      };
      expect(routed.args[0]).toMatchObject({
        activeCollaborationMode: { settings: { model: carrier } },
      });
      hook.dispose();
    },
  );
  it("does not fall back to legacy launch assets when modern ownership is mixed", async () => {
    vi.useFakeTimers();
    const f = hookFixture();
    f.names.push("app-initial-dddef47d6ef6.js", "app-shared-2eda13eb7044.js");
    const hook = installExternalVoiceLaunchHook(f);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hook.status).toBe("unsupported");
    expect(f.importModule).not.toHaveBeenCalled();
    expect(f.services.realtimeVoiceRuntime).toBe(f.runtime);
    hook.dispose();
  });

  it("keeps hashed Chat requestRealtimeStart on native Instant Connect", async () => {
    const f = hookFixture();
    Reflect.set(
      f.target[CPA_LIVE_VOICE_HOOK_GLOBAL],
      "desktopVersion",
      HASHED_WEBPACK_VOICE_VERSION,
    );
    Reflect.set(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], "desktopPlatform", "darwin");
    f.names.splice(0, f.names.length, HASHED_WEBPACK_VOICE_RUNTIME_ASSET);
    const nativeStart = vi.fn().mockResolvedValue(undefined);
    Object.assign(f.target, {
      __codexhostNativeChatVoiceV1: { status: "active", start: nativeStart },
    });
    applySharedVoiceRoutes(f.target, {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "gateway",
    });
    const require = Object.assign(
      (id: string) => {
        if (id === "GaA7") return { appServices: f.services };
        throw new Error(id);
      },
      { m: {}, c: {} },
    );
    const hook = installExternalVoiceLaunchHook({
      target: f.target,
      importModule: async (url) => {
        expect(url).toBe(`app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}`);
        return { __webpack_require__: require };
      },
    });
    await settle();
    expect(hook.status).toBe("active");
    const request = { source: "composer_button_new_thread", productExperience: "chat" };
    await f.services.realtimeVoiceRuntime.requestRealtimeStart(request);
    expect(nativeStart).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    hook.dispose();
  });

  it("does not move Chat-mode Start Voice onto the selected Harness", () => {
    const { routing } = routingFixture();
    const original = { ...request(), productExperience: "chat" };
    expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
  });
  it("keeps Work-mode Start Voice on the selected Harness", () => {
    const { routing } = routingFixture();
    const routed = routeExternalVoiceLaunch(
      { ...request(), productExperience: "work" },
      routing,
    ) as ReturnType<typeof request>;
    expect(routed.activeCollaborationMode.settings.model).toBe(carrier);
  });
  it("snapshots the external route into a separately cloned overlay request", () => {
    const { routing, policy } = routingFixture();
    const original = request();
    const routed = structuredClone(routeExternalVoiceLaunch(original, routing)) as ReturnType<
      typeof request
    >;
    // Overlay's native start builder consumes precisely this settings.model.
    const threadStart = { model: routed.activeCollaborationMode.settings.model };
    expect(threadStart.model).toBe(carrier);
    expect(routed.activeCollaborationMode.settings.developer_instructions).toBe("keep");
    expect(routed.projectId).toBe(original.projectId);
    expect(original.activeCollaborationMode.settings.model).toBe("gpt-6.1-sol");
    policy.selectedModel.mockReturnValue(null);
    expect(threadStart.model).toBe(carrier);
    expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
  });

  it.each(["grok", "cursor-cli"] as const)(
    "preserves Codex Work when saved lastAgent %s disagrees with the current selection",
    (lastAgent) => {
      const { routing, policy } = routingFixture();
      policy.selectedModel.mockReturnValue(null);
      const original = { ...request(), productExperience: "work" };
      const owner = {
        localStorage: {
          getItem: () => JSON.stringify({ version: 1, lastAgent, externalByAgent: {} }),
        },
      };
      const routed = routeExternalVoiceLaunch(original, routing, owner) as ReturnType<
        typeof request
      >;
      expect(routed).toBe(original);
      const threadStart = structuredClone(routed.activeCollaborationMode.settings);
      expect(threadStart.model).toBe("gpt-6.1-sol");
      expect(original.activeCollaborationMode.settings.model).toBe("gpt-6.1-sol");
    },
  );

  it.each(["composer_button_existing_thread", "avatar", "global_hotkey"])(
    "preserves %s and its locator even with an external draft",
    (entry) => {
      const original = {
        ...request(),
        source: entry,
        locator: { hostId: "local", conversationId: "codex-1" },
      };
      const { routing, policy } = routingFixture();
      expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
      expect(policy.selectedModel).not.toHaveBeenCalled();
    },
  );

  it("preserves official requests by identity after clearing external selection", () => {
    const { routing, policy } = routingFixture();
    policy.selectedModel.mockReturnValue(null);
    const original = request();
    expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
  });

  it("does not borrow another Host or ambiguous Composer's draft", () => {
    const { routing, policy } = routingFixture();
    const remote = { ...request(), hostId: "remote-ssh-discovered:linux" };
    expect(routeExternalVoiceLaunch(remote, routing)).toBe(remote);
    vi.mocked(routing.forComposer).mockReturnValue(null);
    const local = request();
    expect(routeExternalVoiceLaunch(local, routing)).toBe(local);
    expect(policy.selectedModel).not.toHaveBeenCalled();
  });

  it("resolves the matching remote Host without using local selection", () => {
    const { routing, route } = routingFixture();
    route.hostId = "remote-ssh-discovered:linux";
    const remote = { ...request(), hostId: route.hostId };
    expect(routeExternalVoiceLaunch(remote, routing)).toMatchObject({
      hostId: route.hostId,
      activeCollaborationMode: { settings: { model: carrier } },
    });
    const local = request();
    expect(routeExternalVoiceLaunch(local, routing)).toBe(local);
  });

  it("constructs default collaboration settings when native launch has none", () => {
    const { routing } = routingFixture();
    expect(
      routeExternalVoiceLaunch({ source, activeCollaborationMode: null }, routing),
    ).toMatchObject({
      activeCollaborationMode: {
        mode: "default",
        settings: { model: carrier, reasoning_effort: null, developer_instructions: null },
      },
    });
  });
});

describe("versioned native voice service hook", () => {
  it("wraps the service reference and forwards the native RPC receiver, callbacks and return value", async () => {
    const fixture = hookFixture();
    const hook = installExternalVoiceLaunchHook(fixture);
    await settle();
    expect(hook.status).toBe("active");
    expect(installExternalVoiceLaunchHook(fixture)).toBe(hook);
    const contextProvider = () => "context";
    const result = fixture.services.realtimeVoiceRuntime.requestRealtimeStart(
      request(),
      "launch-1",
      contextProvider,
    );
    expect(result.receiver).toBe(fixture.runtime);
    expect(result.args).toEqual([
      expect.objectContaining({
        activeCollaborationMode: expect.objectContaining({
          settings: expect.objectContaining({ model: carrier }),
        }),
      }),
      "launch-1",
      contextProvider,
    ]);
    expect(fixture.services.realtimeVoiceRuntime.registerRealtimeStarter).toBe(fixture.other);
    expect(fixture.importModule).toHaveBeenCalledOnce();
    expect(fixture.importModule).toHaveBeenCalledWith("app://-/assets/app-shared-8bd9d0399038.js");
    hook.dispose();
    expect(fixture.services.realtimeVoiceRuntime).toBe(fixture.runtime);
  });

  it("passes official launches unchanged and preserves RPC failures", async () => {
    const fixture = hookFixture();
    const hook = installExternalVoiceLaunchHook(fixture);
    await settle();
    fixture.policy.selectedModel.mockReturnValue(null);
    const original = request();
    fixture.services.realtimeVoiceRuntime.requestRealtimeStart(original);
    expect(fixture.start.mock.calls[0]?.[0]).toBe(original);
    fixture.start.mockImplementation(() => {
      throw new Error("native failure");
    });
    expect(() => fixture.services.realtimeVoiceRuntime.requestRealtimeStart(original)).toThrow(
      "native failure",
    );
    hook.dispose();
  });

  it("does not import mismatched or absent audited assets", async () => {
    vi.useFakeTimers();
    const fixture = hookFixture();
    fixture.names[1] = "app-shared-different.js";
    const hook = installExternalVoiceLaunchHook(fixture);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hook.status).toBe("unsupported");
    expect(fixture.importModule).not.toHaveBeenCalled();
    expect(fixture.services.realtimeVoiceRuntime).toBe(fixture.runtime);
    hook.dispose();
  });

  it("waits for native services initialization after importing the audited module", async () => {
    vi.useFakeTimers();
    const fixture = hookFixture();
    const module: { fN?: unknown } = {};
    const hook = installExternalVoiceLaunchHook({ ...fixture, importModule: async () => module });
    await settle();
    expect(hook.status).toBe("pending");
    module.fN = fixture.services;
    await vi.advanceTimersByTimeAsync(250);
    expect(hook.status).toBe("active");
    hook.dispose();
  });

  it("does not publish a hook after disposal during module import", async () => {
    const fixture = hookFixture();
    let resolve!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    const hook = installExternalVoiceLaunchHook({ ...fixture, importModule: () => pending });
    hook.dispose();
    resolve({ fN: fixture.services });
    await settle();
    expect(fixture.services.realtimeVoiceRuntime).toBe(fixture.runtime);
  });
});

describe("native Chat service interception", () => {
  it("awaits the native Chat START without entering the overlay's new-thread launcher", async () => {
    const f = hookFixture();
    const chatStart = vi.fn().mockResolvedValue(undefined);
    Object.assign(f.target, {
      __codexhostNativeChatVoiceV1: { status: "active", start: chatStart },
    });
    const hook = installExternalVoiceLaunchHook(f);
    await settle();
    await f.services.realtimeVoiceRuntime.requestRealtimeStart({
      ...request(),
      productExperience: "chat",
    });
    expect(chatStart).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    await f.services.realtimeVoiceRuntime.requestRealtimeStart({
      ...request(),
      productExperience: "work",
    });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      activeCollaborationMode: { settings: { model: carrier } },
    });
    hook.dispose();
  });

  it.each(["absent", "disabled", "unsupported", "pending"] as const)(
    "does not dispatch official Instant Connect for owned ChatGPT Chat when the Chat hook is %s",
    async (status) => {
      const f = hookFixture();
      const chatStart = vi.fn();
      if (status !== "absent")
        Object.assign(f.target, {
          __codexhostNativeChatVoiceV1: { status, start: chatStart },
        });
      const hook = installExternalVoiceLaunchHook(f);
      try {
        await settle();
        expect(() =>
          f.services.realtimeVoiceRuntime.requestRealtimeStart({
            ...request(),
            productExperience: "chat",
          }),
        ).toThrow("Chat voice is waiting for Desktop identity.");
        expect(chatStart).not.toHaveBeenCalled();
        expect(f.start).not.toHaveBeenCalled();
        f.services.realtimeVoiceRuntime.requestRealtimeStart({
          ...request(),
          productExperience: "work",
        });
        expect(f.start).toHaveBeenCalledOnce();
      } finally {
        hook.dispose();
      }
    },
  );

  it("does not dispatch hashed Chat Instant Connect onto overlay transport when Chat is unqualified", async () => {
    const f = hookFixture();
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    Reflect.set(
      f.target[CPA_LIVE_VOICE_HOOK_GLOBAL],
      "desktopVersion",
      HASHED_WEBPACK_VOICE_VERSION,
    );
    Reflect.set(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], "desktopPlatform", "darwin");
    Reflect.set(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], "desktopAppPath", appPath);
    Object.assign(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], hashedVoiceTestIdentity(), {
      isolatedQualification: {
        path: "work-codex",
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
        ...hashedVoiceTestIdentity(),
        desktopPlatform: "darwin",
        appPath,
        label: "unqualified-isolated",
      },
    });
    applySharedVoiceRoutes(f.target, {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "gateway",
    });
    f.names.splice(0, f.names.length, HASHED_WEBPACK_VOICE_RUNTIME_ASSET);
    const require = Object.assign(
      (id: string) => {
        if (id === "GaA7") return { appServices: f.services };
        throw new Error(id);
      },
      { m: {}, c: {} },
    );
    const hook = installExternalVoiceLaunchHook({
      target: f.target,
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await settle();
      expect(hook.status).toBe("active");
      expect(ownedChatgptChatStartUnavailable({ productExperience: "chat" }, f.target)).toBe(
        "Chat voice is not qualified on this Desktop.",
      );
      expect(() =>
        f.services.realtimeVoiceRuntime.requestRealtimeStart({
          ...request(),
          productExperience: "chat",
        }),
      ).toThrow("Chat voice is not qualified on this Desktop.");
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("does not dispatch overlay transport when owned Chat is qualified but the WM hook is pending", async () => {
    const f = hookFixture();
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const identity = hashedVoiceTestIdentity();
    Reflect.set(
      f.target[CPA_LIVE_VOICE_HOOK_GLOBAL],
      "desktopVersion",
      HASHED_WEBPACK_VOICE_VERSION,
    );
    Reflect.set(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], "desktopPlatform", "darwin");
    Reflect.set(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], "desktopAppPath", appPath);
    Object.assign(f.target[CPA_LIVE_VOICE_HOOK_GLOBAL], identity, {
      isolatedQualification: {
        path: "chat",
        run: "2026-11-14-isolated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
        ...identity,
        implementationRevision: voiceImplementationRevision(),
        desktopPlatform: "darwin",
        appPath,
        label: "unqualified-isolated",
      },
    });
    const pendingHook = { status: "pending" as const, start: vi.fn() };
    Object.assign(f.target, {
      __codexhostNativeChatVoiceV1: pendingHook,
    });
    applySharedVoiceRoutes(f.target, {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "gateway",
    });
    f.names.splice(0, f.names.length, HASHED_WEBPACK_VOICE_RUNTIME_ASSET);
    const require = Object.assign(
      (id: string) => {
        if (id === "GaA7") return { appServices: f.services };
        throw new Error(id);
      },
      { m: {}, c: {} },
    );
    const hook = installExternalVoiceLaunchHook({
      target: f.target,
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await settle();
      expect(() =>
        f.services.realtimeVoiceRuntime.requestRealtimeStart({
          ...request(),
          productExperience: "chat",
        }),
      ).toThrow("Native Chat voice is unavailable");
      expect(f.start).not.toHaveBeenCalled();
      expect(pendingHook.start).not.toHaveBeenCalled();
      expect(
        (f.target as { __codexhostNativeChatVoiceV1?: { status?: string } })
          .__codexhostNativeChatVoiceV1?.status,
      ).toBe("pending");
    } finally {
      hook.dispose();
    }
  });

  it("leaves Chat Instant Connect on the original service when the extension voice hook is disabled", async () => {
    const f = hookFixture();
    Reflect.deleteProperty(f.target, CPA_LIVE_VOICE_HOOK_GLOBAL);
    const hook = installExternalVoiceLaunchHook(f);
    try {
      await settle();
      expect(hook.status).toBe("disabled");
      expect(f.services.realtimeVoiceRuntime).toBe(f.runtime);
      f.services.realtimeVoiceRuntime.requestRealtimeStart({
        ...request(),
        productExperience: "chat",
      });
      expect(f.start).toHaveBeenCalledOnce();
    } finally {
      hook.dispose();
    }
  });

  it.each(["desktop", "gateway"] as const)(
    "preserves explicit Codex Chat on %s without a native Chat binding",
    async (chatConnection) => {
      const f = hookFixture();
      applySharedVoiceRoutes(f.target, {
        chatExperience: "codex",
        chatConnection,
        workConnection: "gateway",
      });
      const hook = installExternalVoiceLaunchHook(f);
      try {
        await settle();
        await f.services.realtimeVoiceRuntime.requestRealtimeStart({
          ...request(),
          productExperience: "chat",
        });
        expect(f.start).toHaveBeenCalledOnce();
      } finally {
        hook.dispose();
      }
    },
  );

  it("does not fall back to a Grok/Codex overlay when native Chat START rejects", async () => {
    const f = hookFixture();
    Object.assign(f.target, {
      __codexhostNativeChatVoiceV1: {
        status: "active",
        start: vi.fn().mockRejectedValue(new Error("native start failed")),
      },
    });
    const hook = installExternalVoiceLaunchHook(f);
    await settle();
    await expect(
      f.services.realtimeVoiceRuntime.requestRealtimeStart({
        ...request(),
        productExperience: "chat",
      }),
    ).rejects.toThrow("native start failed");
    expect(f.start).not.toHaveBeenCalled();
    hook.dispose();
  });
});
