import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_CHAT_START_TIMEOUT_MS,
  awaitBoundNative,
  classifyNativeChatVoiceStart,
  createNativeChatPrepareBudget,
  nativeChatVoiceConnected,
  observeNativeChatVoiceConnection,
  readNativeChatVoiceObservedState,
  selectNativeChatVoiceAdapter,
  startNativeChatVoiceSession,
} from "../src/renderer-native-chat-voice-runtime.js";

describe("native Chat voice runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("selects hashed versus named adapters from reviewed identity", () => {
    expect(
      selectNativeChatVoiceAdapter({
        desktopVersion: "26.1106.51428",
        desktopPlatform: "darwin",
      }),
    ).toBe("hashed");
    expect(
      selectNativeChatVoiceAdapter({
        desktopVersion: "26.1027.61615",
        desktopPlatform: "darwin",
      }),
    ).toBe("named");
    expect(
      selectNativeChatVoiceAdapter({
        desktopVersion: "26.1106.51428",
        desktopPlatform: "win32",
      }),
    ).toBeUndefined();
    expect(
      selectNativeChatVoiceAdapter({
        desktopVersion: "26.1106.51428",
        desktopPlatform: "win32",
        desktopBuild: "26605",
        asarDigest: `sha256:${"ab".repeat(32)}`,
        desktopAppPath:
          "C:\\Users\\karlchow\\AppData\\Local\\.codexhost\\update-impact\\26.1106.51428\\bundle\\app\\ChatGPT.exe",
        implementationRevision: "abcd1234abcd1234",
        isolatedQualification: {
          path: "chat",
          run: "isolated",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          desktopVersion: "26.1106.51428",
          desktopBuild: "26605",
          desktopPlatform: "win32",
          asarDigest: `sha256:${"ab".repeat(32)}`,
          appPath:
            "C:\\Users\\karlchow\\AppData\\Local\\.codexhost\\update-impact\\26.1106.51428\\bundle\\app\\ChatGPT.exe",
          implementationRevision: "abcd1234abcd1234",
          label: "unqualified-isolated",
        },
      }),
    ).toBe("hashed");
  });

  it("treats START acknowledgment without native connected Chat state as incomplete", () => {
    const observation = {
      acknowledged: true,
      connected: false,
      conversationMatched: true,
      productMatched: true,
      category: "start-acknowledged" as const,
    };
    expect(classifyNativeChatVoiceStart(observation)).toBe("start-acknowledged");
    expect(
      nativeChatVoiceConnected({
        voiceModeActive: true,
        connected: false,
        sessionStarted: true,
        conversationMatched: true,
        isWorkMode: false,
        conversationId: "local",
      }),
    ).toBe(false);
  });

  it("does not dispatch a second START while one is already in flight", async () => {
    const start = vi.fn(async () => undefined);
    const observation = await startNativeChatVoiceSession({
      binding: {
        composer: {} as Element,
        appNode: {},
        props: { conversationId: "chat" },
        scope: { get: vi.fn(), set: vi.fn() } as never,
        context: {},
        composerContext: { context: {}, chain: new Map() },
        backendConversationId: undefined,
      },
      modules: {
        initial: { SPn: () => ({ getState: () => ({}) }) },
        shared: {},
        start: { n: start },
        prewarm: {},
      },
      signal: new AbortController().signal,
      starting: true,
    });
    expect(observation.category).toBe("duplicate");
    expect(start).not.toHaveBeenCalled();
  });

  it("times out START acknowledgment that never reaches native connected Chat", async () => {
    let now = 0;
    const category = await observeNativeChatVoiceConnection({
      read: () => ({
        voiceModeActive: true,
        connected: false,
        sessionStarted: true,
        conversationMatched: true,
        isWorkMode: false,
        conversationId: "local",
      }),
      signal: new AbortController().signal,
      timeoutMs: 8000,
      now: () => now,
      wait: async () => {
        now = 8000;
      },
    });
    expect(category).toBe("timeout");
  });

  it("observes native connected Chat independently of START acknowledgment", async () => {
    const category = await observeNativeChatVoiceConnection({
      read: () => ({
        voiceModeActive: true,
        connected: true,
        sessionStarted: true,
        conversationMatched: true,
        isWorkMode: false,
        conversationId: "local",
      }),
      signal: new AbortController().signal,
      now: () => 0,
      wait: async () => {
        throw new Error("should not wait");
      },
    });
    expect(category).toBe("connected");
  });

  it("resets a failed prepare budget when the owner key changes", () => {
    const budget = createNativeChatPrepareBudget(1);
    expect(budget.allow("graph-a")).toBe(true);
    budget.fail("graph-a");
    expect(budget.allow("graph-a")).toBe(false);
    expect(budget.allow("graph-b")).toBe(true);
  });

  it("does not treat unknown native product state as Chat", () => {
    const scope = {};
    const missing = readNativeChatVoiceObservedState(scope as never, {
      SPn: () => ({
        getState: () => ({
          isVoiceModeActive: true,
          conversationId: "chat",
          hasVoiceSessionStarted: true,
          server: { connectionState: "connected" },
        }),
      }),
    });
    expect(missing?.isWorkMode).toBeUndefined();
    expect(nativeChatVoiceConnected(missing)).toBe(false);
    const nonboolean = readNativeChatVoiceObservedState(scope as never, {
      SPn: () => ({
        getState: () => ({
          isVoiceModeActive: true,
          isWorkMode: "chat",
          conversationId: "chat",
          hasVoiceSessionStarted: true,
          server: { connectionState: "connected" },
        }),
      }),
    });
    expect(nonboolean?.isWorkMode).toBeUndefined();
    expect(nativeChatVoiceConnected(nonboolean)).toBe(false);
  });

  it("requires matching conversation and Chat product for a connected observation", () => {
    const scope = {};
    const state = readNativeChatVoiceObservedState(
      scope as never,
      {
        SPn: () => ({
          getState: () => ({
            isVoiceModeActive: true,
            isWorkMode: true,
            conversationId: "other",
            hasVoiceSessionStarted: true,
            server: { connectionState: "connected" },
          }),
        }),
      },
      {
        composer: {} as Element,
        appNode: {},
        props: { conversationId: "chat" },
        scope: scope as never,
        context: {},
        composerContext: { context: {}, chain: new Map() },
        backendConversationId: undefined,
      },
    );
    expect(nativeChatVoiceConnected(state)).toBe(false);
  });

  it("bounds a native START that never resolves and discards a late result", async () => {
    vi.useFakeTimers();
    let received: AbortSignal | undefined;
    const start = vi.fn((_scope, _props, _meta, signal: AbortSignal) => {
      received = signal;
      return new Promise<undefined>(() => undefined);
    });
    const controller = new AbortController();
    const pending = startNativeChatVoiceSession({
      binding: {
        composer: {} as Element,
        appNode: {},
        props: { conversationId: "chat" },
        scope: { get: vi.fn(), set: vi.fn() } as never,
        context: {},
        composerContext: { context: {}, chain: new Map() },
        backendConversationId: undefined,
      },
      modules: {
        initial: { SPn: () => ({ getState: () => ({}) }) },
        shared: {},
        start: { n: start },
        prewarm: {},
      },
      signal: controller.signal,
      starting: false,
    });
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_START_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({
      acknowledged: false,
      category: "timeout",
    });
    expect(received?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    const late = Promise.withResolvers<string>();
    const bound = awaitBoundNative(late.promise, new AbortController().signal, 8_000);
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_START_TIMEOUT_MS);
    await expect(bound).resolves.toEqual({ status: "timeout" });
    late.resolve("stale");
    await vi.advanceTimersByTimeAsync(0);
    await expect(bound).resolves.toEqual({ status: "timeout" });
  });

  it("cancels a pending native START without waiting for settlement", async () => {
    const controller = new AbortController();
    const start = vi.fn(() => new Promise<undefined>(() => undefined));
    const pending = startNativeChatVoiceSession({
      binding: {
        composer: {} as Element,
        appNode: {},
        props: { conversationId: "chat" },
        scope: { get: vi.fn(), set: vi.fn() } as never,
        context: {},
        composerContext: { context: {}, chain: new Map() },
        backendConversationId: undefined,
      },
      modules: {
        initial: { SPn: () => ({ getState: () => ({}) }) },
        shared: {},
        start: { n: start },
        prewarm: {},
      },
      signal: controller.signal,
      starting: false,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ category: "cancelled", acknowledged: false });
  });
});
