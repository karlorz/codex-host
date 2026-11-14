import { describe, expect, it, vi } from "vitest";
import {
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  loadHashedNativeChatVoiceModules,
} from "../src/renderer-hashed-native-chat-voice.js";

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
});
