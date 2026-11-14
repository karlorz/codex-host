import { describe, expect, it, vi } from "vitest";
import {
  HASHED_NATIVE_CHAT_ROLES,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  loadHashedNativeChatVoiceModules,
} from "../src/renderer-hashed-native-chat-voice.js";
import { nativeChatVoiceDraftSelection } from "../src/renderer-native-chat-voice-selection.js";
import type { NativeChatVoiceBinding } from "../src/renderer-native-chat-voice.js";

describe("hashed native Chat voice dependencies", () => {
  it("loads native dependencies and repairs a missing-factory cache before Chat START", async () => {
    const command = Promise.withResolvers<undefined>();
    const dispatchVoiceCommand = vi.fn(() => command.promise);
    const runtimeEnabled = {};
    const cache: Record<string, { exports: Record<string, unknown>; error?: unknown }> = {
      jxTE: { exports: {} },
      j9r7: {
        error: new Error("missing factory"),
        exports: {
          initializeVoiceSession: () => {
            throw new Error("partial START factory");
          },
        },
      },
    };
    const factories: Record<string, () => unknown> = {};
    const initializeVoiceSession = vi.fn(async () => {
      if (cache.jxTE) throw new Error("cached dependency has no exports");
      if (!factories.jxTE) throw new Error("missing native dependency");
      return { getVoiceNuxMode: () => "none", dispatchVoiceCommand };
    });
    const loadRuntime = vi.fn<(...args: unknown[]) => Promise<unknown>>(initializeVoiceSession);
    const exports: Record<string, unknown> = {
      j9r7: { initializeVoiceSession },
      oWM3: { VoiceInstantConnectCacheController() {} },
      OWtl: { u: { __scopeBrand: "AppScope" } },
      Oj9r: { GD: { __scopeBrand: "RouteScope" } },
      Sd8U: { PR: { __scopeBrand: "ComposerScope" } },
      bgok: { MH: () => ({ getState: () => ({ isVoiceModeActive: false }) }) },
      hOYb: { H3: {} },
      cY1t: { Iy: runtimeEnabled, Re: loadRuntime },
      zd8w: { createElement() {} },
      CE87: { createRoot() {} },
    };
    const loadChunk = vi.fn(async (id: number) => {
      if (id === 422391) factories.jxTE = () => ({ ready: true });
    });
    const require = Object.assign((id: string) => cache[id]?.exports ?? exports[id], {
      m: factories,
      c: cache,
      e: loadChunk,
    });
    const modules = await loadHashedNativeChatVoiceModules(async (url) =>
      url.endsWith(HASHED_WEBPACK_VOICE_RUNTIME_ASSET)
        ? { __webpack_require__: require }
        : { __webpack_modules__: {} },
    );
    expect(modules.initial.aT).toBe(runtimeEnabled);
    expect(modules.initial.Nir).toBeUndefined();
    expect(modules.shared.Vot).toBeUndefined();
    expect(modules.initial.Ycr).toBeUndefined();
    expect(modules.initial.n0n).toBeUndefined();
    expect(modules.initial.Y1n).toBeUndefined();
    expect(modules.initial.B1n).toEqual({});
    const scope = {};
    const started = (modules.start.n as (...args: unknown[]) => Promise<void>)(
      scope,
      { conversationId: "saved-chat" },
      {},
      new AbortController().signal,
    );
    let completed = false;
    void started.then(() => {
      completed = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(completed).toBe(false);
    command.resolve(undefined);
    await started;
    expect(loadChunk).toHaveBeenCalledWith(422391);
    expect(loadChunk).toHaveBeenCalledWith(530142);
    expect(dispatchVoiceCommand).toHaveBeenCalledExactlyOnceWith(scope, {
      type: "START",
      args: { conversationId: "saved-chat", eventSource: "composer" },
    });
    expect(loadRuntime).toHaveBeenCalledExactlyOnceWith(
      scope,
      "saved-chat",
      { event_source: "composer" },
      expect.any(AbortSignal),
    );
    loadRuntime.mockResolvedValueOnce(null);
    await expect(
      (modules.start.n as (...args: unknown[]) => Promise<void>)(
        scope,
        { conversationId: "saved-chat" },
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(dispatchVoiceCommand).toHaveBeenCalledOnce();
  });

  it("maps 26.1106 draft-selection roles from the hashed loader onto native navigation", async () => {
    const backendSelector = {};
    const mappingSelector = {};
    const nodeSelector = {};
    const locationSelector = {};
    const origin = { pathname: "/", key: "home" };
    const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
    const backend = "a7e3282d-f457-4586-9b28-921411364f6b";
    const navigate = vi.fn(() => true);
    const conversationPath = vi.fn((id: string) => `/c/${encodeURIComponent(id)}`);
    const values = new Map<unknown, unknown>([[locationSelector, origin]]);
    const roles = HASHED_NATIVE_CHAT_ROLES;
    const exports: Record<string, unknown> = {
      [roles.startModuleId]: { initializeVoiceSession: vi.fn() },
      [roles.prewarmModuleId]: { VoiceInstantConnectCacheController() {} },
      [roles.appScopeModuleId]: { [roles.appScopeExport]: { __scopeBrand: "AppScope" } },
      [roles.routeScopeModuleId]: { [roles.routeScopeExport]: { __scopeBrand: "RouteScope" } },
      [roles.composerScopeModuleId]: {
        [roles.composerScopeExport]: { __scopeBrand: "ComposerScope" },
      },
      [roles.storeModuleId]: {
        [roles.storeExport]: () => ({
          getState: () => ({
            isVoiceModeActive: true,
            isWorkMode: false,
            conversationId: draft,
            voiceSessionId: "fixture-session",
            hasVoiceSessionStarted: true,
            earlyServerThreadId: backend,
            server: { connectionState: "connected" },
          }),
        }),
      },
      [roles.runtimeModuleId]: {
        [roles.runtimeEnableExport]: {},
        [roles.runtimeLoaderExport]: vi.fn(),
      },
      [roles.reactModuleId]: { createElement() {} },
      [roles.reactDomModuleId]: { createRoot() {} },
      [roles.conversationModuleId]: {
        [roles.backendConversationExport]: backendSelector,
        [roles.transcriptMappingExport]: mappingSelector,
        [roles.currentNodeExport]: nodeSelector,
      },
      [roles.locationModuleId]: { [roles.locationExport]: locationSelector },
      [roles.navigationModuleId]: { [roles.navigationExport]: navigate },
      [roles.conversationPathModuleId]: { [roles.conversationPathExport]: conversationPath },
    };
    const require = Object.assign((id: string) => exports[id], {
      m: {},
      c: {},
      e: vi.fn(async () => {}),
    });
    const modules = await loadHashedNativeChatVoiceModules(async (url) =>
      url.endsWith(HASHED_WEBPACK_VOICE_RUNTIME_ASSET)
        ? { __webpack_require__: require }
        : { __webpack_modules__: {} },
    );
    expect(modules.initial.B1n).toBe(backendSelector);
    expect(modules.initial.Ycr).toBe(locationSelector);
    expect(modules.initial.n0n).toBe(mappingSelector);
    expect(modules.initial.Y1n).toBe(nodeSelector);
    expect(typeof modules.initial.Nir).toBe("function");
    expect(modules.shared.Vot).toBe(conversationPath);

    const binding = {
      props: { conversationId: draft },
      backendConversationId: backend,
      scope: { get: vi.fn((selector) => values.get(selector)), set: vi.fn() },
    } as unknown as NativeChatVoiceBinding;
    const select = nativeChatVoiceDraftSelection(
      binding,
      modules.initial,
      modules.shared,
      origin,
      new AbortController().signal,
    );
    select();
    expect(navigate).not.toHaveBeenCalled();
    values.set(backendSelector, backend);
    values.set(nodeSelector, "message");
    values.set(mappingSelector, { message: { message: { author: { role: "user" } } } });
    select();
    expect(conversationPath).toHaveBeenCalledExactlyOnceWith(backend);
    expect(conversationPath).not.toHaveBeenCalledWith(draft);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(binding.scope, {
      pathname: `/c/${encodeURIComponent(backend)}`,
    });
    select();
    expect(navigate).toHaveBeenCalledOnce();
  });
});
