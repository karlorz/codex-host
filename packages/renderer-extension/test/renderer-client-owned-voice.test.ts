import { afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_CALL_METHOD, VOICE_SETTINGS_METHOD } from "@codexhost/shared-contracts";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
  HOME_COMPOSER_MODE_STORAGE_KEY,
  installClientOwnedVoiceHook,
  isExternalHarnessComposer,
  isWorkComposerSurface,
  rememberVoiceProductExperience,
  VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY,
  wrapClientOwnedVoiceFetch,
  type NativeVoiceBridge,
} from "../src/renderer-client-owned-voice.js";
import {
  DIRECT_VOICE_HOST_GLOBAL,
  requestLocalHostMcp,
  requestVoiceHost,
} from "../src/renderer-voice-gateway-wrap.js";
import { RENDERER_NEW_THREAD_PREFERENCE_KEY } from "../src/renderer-new-thread-preference.js";
import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../src/renderer-cpa-live-voice-hook.js";
import { wrapGatewayVoiceStarter } from "../src/renderer-voice-start-capability.js";
import {
  CHAT_LIVE_VOICE_STORAGE_KEY,
  CPA_LIVE_VOICE_STORAGE_KEY,
} from "../src/renderer-cpa-live-voice-preference.js";
import { installHashedOverlayVoiceHook } from "../src/renderer-hashed-overlay-voice.js";
import { voiceImplementationRevision } from "../src/renderer-voice-profiles.js";
import {
  hashedVoiceTestIdentity,
  reviewedVoiceEvidenceRecord,
  TEST_REVIEWED_ASAR_DIGEST,
  TEST_REVIEWED_NATIVE_BUILD,
} from "./voice-evidence-fixture.js";

function fixture(
  result = { status: 201, body: "answer", headers: { location: "/v1/realtime/calls/rtc_fixture" } },
) {
  const listeners = new Set<(event: unknown) => void>();
  const dispatch = vi.fn((_type: string, value: Record<string, unknown>) => {
    const request = value.request as { id: string; params: { operation: string } };
    queueMicrotask(() => {
      for (const listener of listeners)
        listener({
          hostId: "local",
          message: {
            id: request.id,
            result:
              request.params.operation === "create"
                ? result
                : { status: 204, body: "", headers: {} },
          },
        });
    });
  });
  const bridge: NativeVoiceBridge = {
    dispatchMessage: dispatch,
    subscribe: (_type, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const original = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(
    async () => new Response("native"),
  );
  const client = { fetch: original as (url: string, options?: RequestInit) => Promise<Response> };
  const responseError = vi.fn(async (response: Response) =>
    Object.assign(new Error(await response.text()), { status: response.status }),
  );
  Reflect.set(globalThis, DIRECT_VOICE_HOST_GLOBAL, {
    request: (method: string, params: Record<string, unknown>) =>
      requestLocalHostMcp(bridge, method, params, { timeoutMs: 30_000 }),
  });
  return { bridge, dispatch, listeners, client, original, responseError };
}
function sharedExports(f: ReturnType<typeof fixture>) {
  const fetch = { getInstance: () => f.client };
  const bridge = { getInstance: () => f.bridge };
  return {
    Oit: vi.fn(),
    Eit: fetch,
    AFt: bridge,
    Mit: f.responseError,
    Zot: fetch,
    Htr: fetch,
    yir: fetch,
    wdr: fetch,
    Odr: fetch,
    Pdr: f.responseError,
    LRt: bridge,
    Adr: vi.fn(),
    QIt: bridge,
    bIt: bridge,
    Qot: { realtimeVoiceRuntime: vi.fn() },
  };
}
const url = "/wham/realtime/calls?intent=quicksilver&architecture=avas";
const body = (model: string | undefined) =>
  JSON.stringify({ sdp: "offer", ...(model === undefined ? {} : { session: { model } }) });
const speechBody = () => body("gpt-live-1-codex");
const chatBody = () => body("gpt-live");
const workMeta = {
  "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "gpt-5.3-codex" }),
};
const options = (requestBody: string = speechBody(), headers?: HeadersInit) => ({
  method: "POST" as const,
  body: requestBody,
  ...(headers ? { headers } : {}),
});
const workOptions = (requestBody: string = speechBody()) => options(requestBody, workMeta);
afterEach(() => {
  vi.useRealTimers();
  rememberVoiceProductExperience({ productExperience: "" });
  Reflect.deleteProperty(globalThis, DIRECT_VOICE_HOST_GLOBAL);
});

describe("client-owned voice gateway", () => {
  it("creates the native call through Host rather than Desktop OAuth", async () => {
    const f = fixture();
    const dispose = wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    const response = await f.client.fetch(url, workOptions());
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("answer");
    expect(response.headers.get("location")).toBe("/v1/realtime/calls/rtc_fixture");
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledWith(
      "mcp-request",
      expect.objectContaining({
        hostId: "local",
        request: expect.objectContaining({
          method: REALTIME_CALL_METHOD,
          params: expect.objectContaining({ operation: "create", body: speechBody() }),
        }),
      }),
    );
    expect(f.listeners.size).toBe(0);
    dispose();
    expect(f.client.fetch).toBe(f.original);
  });
  it("routes overlay Work calls marked originator=codex_work_desktop", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("passes Chat Instant Connect through when overlay originator is Work", async () => {
    rememberVoiceProductExperience({ productExperience: "chat" });
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("passes overlay Chat Instant Connect through even when Work gateway is on", async () => {
    rememberVoiceProductExperience({ productExperience: "chat" });
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => false,
      () => false,
      () => true,
    );
    await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("Host-creates overlay Work /wham after a Work launch", async () => {
    rememberVoiceProductExperience({ productExperience: "work" });
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => false,
      () => false,
      () => true,
    );
    await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("hosts overlay Chat Instant Connect through the Chat gateway when Chat selects Codex", async () => {
    rememberVoiceProductExperience({ productExperience: "chat" });
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => true,
      () => false,
      () => false,
      () => true,
    );
    await f.client.fetch(url, options(chatBody(), { originator: "codex_work_desktop" }));
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("strips Desktop account credentials and cookies before crossing the bridge", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, {
      ...workOptions(),
      headers: {
        ...workMeta,
        Authorization: "Bearer desktop-oauth",
        Cookie: "session=private",
        "ChatGPT-Account-Id": "disabled-account",
        "openai-alpha": "quicksilver=v2",
        "Thread-Id": "thread-fixture",
      },
    });
    const params = f.dispatch.mock.calls
      .map(
        ([, value]) => (value.request as { params: { headers?: Record<string, string> } }).params,
      )
      .find((entry) => entry.headers !== undefined);
    expect(params?.headers).toEqual({
      "openai-alpha": "quicksilver=v2",
      "thread-id": "thread-fixture",
      "x-codex-turn-metadata": workMeta["x-codex-turn-metadata"],
    });
    const serialized = JSON.stringify(f.dispatch.mock.calls);
    expect(serialized).not.toContain("desktop-oauth");
    expect(serialized).not.toContain("disabled-account");
    expect(serialized).not.toContain("session=private");
  });
  it("strips Desktop account credentials on an intercepted Chat call too", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => true,
    );
    await f.client.fetch(url, {
      ...options(chatBody()),
      headers: {
        Authorization: "Bearer desktop-oauth",
        Cookie: "session=private",
        "ChatGPT-Account-Id": "disabled-account",
        "openai-alpha": "quicksilver=v2",
      },
    });
    expect(f.original).not.toHaveBeenCalled();
    const serialized = JSON.stringify(f.dispatch.mock.calls);
    expect(serialized).not.toContain("desktop-oauth");
    expect(serialized).not.toContain("disabled-account");
    expect(serialized).not.toContain("session=private");
    expect(serialized).toContain("quicksilver=v2");
  });
  it.each([
    "/other",
    "/wham/realtime/calls/rtc_fixture/hangup",
    "https://chatgpt.com/wham/realtime/calls",
    "/wham/realtime/calls-extra",
  ])("preserves unrelated requests: %s", async (path) => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    expect(await (await f.client.fetch(path, options())).text()).toBe("native");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does not treat a saved lastAgent as the current Work Harness", () => {
    const grokOwner = {
      localStorage: {
        getItem: () => JSON.stringify({ version: 1, lastAgent: "grok", externalByAgent: {} }),
      },
    };
    rememberVoiceProductExperience({ productExperience: "chat" });
    expect(isExternalHarnessComposer(grokOwner)).toBe(false);
    rememberVoiceProductExperience({ productExperience: "work" });
    expect(isExternalHarnessComposer(grokOwner)).toBe(false);
    rememberVoiceProductExperience({ productExperience: "work" });
    expect(
      isExternalHarnessComposer({
        localStorage: {
          getItem: () => JSON.stringify({ version: 1, lastAgent: "codex", externalByAgent: {} }),
        },
      }),
    ).toBe(false);
  });
  it.each(["grok", "cursor-cli"])(
    "does not infer the current Harness from saved lastAgent %s on Work home",
    (lastAgent) => {
      rememberVoiceProductExperience({});
      expect(
        isExternalHarnessComposer({
          localStorage: {
            getItem: (key: string) =>
              key === HOME_COMPOSER_MODE_STORAGE_KEY
                ? "work"
                : key === RENDERER_NEW_THREAD_PREFERENCE_KEY
                  ? JSON.stringify({ version: 1, lastAgent, externalByAgent: {} })
                  : null,
          },
        }),
      ).toBe(false);
    },
  );
  it("identifies the currently selected external carrier despite a different saved default", () => {
    const owner = {
      __codexhostHostRoutingV1: {
        forComposer: () => ({ policy: { selectedModel: () => "codexhost/grok/grok-4" } }),
      },
      localStorage: { getItem: () => JSON.stringify({ version: 1, lastAgent: "cursor-cli" }) },
    };
    rememberVoiceProductExperience({ productExperience: "work" });
    expect(isExternalHarnessComposer(owner)).toBe(true);
    rememberVoiceProductExperience({ productExperience: "chat" });
    expect(isExternalHarnessComposer(owner)).toBe(false);
  });
  it("sends external Harness voice through Host even when the Work gateway switch is off", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => false,
      () => false,
      () => true,
    );
    const response = await f.client.fetch(url, options(speechBody()));
    expect(response.status).toBe(201);
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it.each(["codexhost/grok/grok-4", "codexhost/claude/opus"])(
    "routes the cold overlay's explicit Harness metadata through Host: %s",
    async (model) => {
      const f = fixture();
      // No primary Composer, remembered launch, or lastAgent exists in this realm.
      wrapClientOwnedVoiceFetch(
        f.client,
        f.bridge,
        () => false,
        f.responseError,
        () => false,
        () => false,
        () => false,
      );
      await f.client.fetch(
        url,
        options(speechBody(), {
          "x-codex-turn-metadata": JSON.stringify({ backend_model_name: model }),
        }),
      );
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    },
  );
  it("honors the Work preference at call time", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => false, f.responseError);
    await f.client.fetch(url, workOptions());
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("blocks a selected Work gateway when the Work lane is unqualified", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "work" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => true,
      () => false,
      () => false,
      () => true,
      () => false,
    );
    await expect(f.client.fetch(url, workOptions())).rejects.toThrow(
      "Work voice is not qualified on this Desktop.",
    );
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("keeps an intentional Desktop Work preference native when the lane is also off", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "work" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => false,
      () => true,
      () => false,
      () => false,
      () => true,
      () => false,
    );
    await f.client.fetch(url, workOptions());
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each([
    { experience: "work", model: "gpt-6.1-sol" },
    { experience: "work", model: undefined },
    { experience: "codex", model: "gpt-6.1-sol" },
    { experience: "codex", model: undefined },
  ])(
    "routes an explicit $experience overlay start through Host without a Work composer: $model",
    async ({ experience, model }) => {
      const f = fixture();
      wrapClientOwnedVoiceFetch(
        f.client,
        f.bridge,
        () => true,
        f.responseError,
        () => false,
        () => false,
        () => false,
      );
      const starter = wrapGatewayVoiceStarter(
        () =>
          f.client.fetch(
            url,
            options(
              speechBody(),
              model
                ? { "x-codex-turn-metadata": JSON.stringify({ backend_model_name: model }) }
                : undefined,
            ),
          ),
        {
          qualifies: () => true,
          ready: async () => true,
          prepare: async () => ({ current: () => true, dispose() {} }),
          committed: async () => {},
        },
      );
      const response = (await starter.start({
        productExperience: experience,
        source: "composer_button_new_thread",
        hostId: "local",
      })) as Response;
      expect(response.status).toBe(201);
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    },
  );
  it.each(["work", "codex"])(
    "uses the Work preference for an explicit %s overlay start when Chat uses gateway",
    async (experience) => {
      const f = fixture();
      rememberVoiceProductExperience({ productExperience: experience });
      wrapClientOwnedVoiceFetch(
        f.client,
        f.bridge,
        () => false,
        f.responseError,
        () => true,
        () => false,
        () => false,
      );
      await f.client.fetch(url, options(speechBody()));
      expect(f.original).toHaveBeenCalledOnce();
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["gpt-live", chatBody()],
    ["shared speech model gpt-live-1-codex", speechBody()],
    ["no session", JSON.stringify({ sdp: "offer" })],
  ])(
    "leaves Chat %s on native /wham so Desktop Chat voice can own Instant Connect",
    async (_name, request) => {
      const f = fixture();
      wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
      expect(await (await f.client.fetch(url, options(request))).text()).toBe("native");
      expect(f.original).toHaveBeenCalledOnce();
      expect(f.original.mock.calls[0]?.[0]).toBe(url);
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );
  it("does not retry native AppServer or mcp when the direct Host capability is missing", async () => {
    Reflect.deleteProperty(globalThis, DIRECT_VOICE_HOST_GLOBAL);
    const sendRequest = vi.fn();
    const dispatch = vi.fn();
    const bridge: NativeVoiceBridge = {
      dispatchMessage: dispatch,
      subscribe: () => () => {},
    };
    await expect(requestVoiceHost(bridge, { operation: "create" })).rejects.toThrow(
      "Voice gateway Host connection is unavailable",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
  });
  it("reads voice settings over Host mcp-request without native sendRequest", async () => {
    let captured: Record<string, unknown> | undefined;
    let listener: ((event: unknown) => void) | undefined;
    const bridge: NativeVoiceBridge = {
      dispatchMessage: vi.fn((_type, value: Record<string, unknown>) => {
        captured = value;
        const request = value.request as { id: string };
        queueMicrotask(() =>
          listener?.({
            hostId: "local",
            message: { id: request.id, result: { initialized: true, gatewayReady: false } },
          }),
        );
      }),
      subscribe: (_type, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    await expect(
      requestLocalHostMcp(bridge, VOICE_SETTINGS_METHOD, { operation: "get" }),
    ).resolves.toEqual({ initialized: true, gatewayReady: false });
    expect(captured).toMatchObject({
      hostId: "local",
      request: { method: VOICE_SETTINGS_METHOD, params: { operation: "get" } },
    });
  });
  it("classifies Host settings errors without parser output", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const bridge: NativeVoiceBridge = {
      dispatchMessage: vi.fn((_type, value: Record<string, unknown>) => {
        const request = value.request as { id: string };
        queueMicrotask(() =>
          listener?.({
            hostId: "local",
            message: {
              id: request.id,
              error: {
                code: -32602,
                message: "Invalid voice settings request",
                data: { issues: [{ code: "invalid_type" }] },
              },
            },
          }),
        );
      }),
      subscribe: (_type, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    await expect(
      requestLocalHostMcp(bridge, VOICE_SETTINGS_METHOD, { operation: "create" }),
    ).rejects.toMatchObject({ message: "Invalid voice settings request" });
    await expect(
      requestLocalHostMcp(bridge, VOICE_SETTINGS_METHOD, { operation: "create" }),
    ).rejects.toSatisfy((error: unknown) => {
      const text = JSON.stringify(error instanceof Error ? error.message : error);
      return !text.includes("invalid_type") && !text.includes("Zod");
    });
  });
  it("keeps gateway-create mapping when Host MCP returns a call error", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const bridge: NativeVoiceBridge = {
      dispatchMessage: vi.fn((_type, value: Record<string, unknown>) => {
        const request = value.request as { id: string };
        queueMicrotask(() =>
          listener?.({
            hostId: "local",
            message: {
              id: request.id,
              error: {
                code: -32092,
                message: "Invalid voice call request",
                data: { stage: "request" },
              },
            },
          }),
        );
      }),
      subscribe: (_type, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    Reflect.set(globalThis, DIRECT_VOICE_HOST_GLOBAL, {
      request: (method: string, params: Record<string, unknown>) =>
        requestLocalHostMcp(bridge, method, params, { timeoutMs: 30_000 }),
    });
    await expect(requestVoiceHost(bridge, { operation: "create" })).rejects.toThrow(
      "Configured voice gateway request failed",
    );
    const log = (globalThis as { __codexhostChatVoiceDebug?: unknown[] }).__codexhostChatVoiceDebug;
    expect(JSON.stringify(log)).toContain("gateway-create");
    expect(JSON.stringify(log)).toContain('"stage":"request"');
  });
  it("records a sanitized gateway-create RPC failure without payloads", async () => {
    const f = fixture();
    f.dispatch.mockImplementation((_type: string, value: Record<string, unknown>) => {
      const request = value.request as { id: string };
      queueMicrotask(() => {
        for (const listener of f.listeners)
          listener({
            hostId: "local",
            message: {
              id: request.id,
              error: {
                code: -32090,
                message: "Configured voice gateway request failed",
                data: { stage: "identity" },
              },
            },
          });
      });
    });
    rememberVoiceProductExperience({ productExperience: "work" });
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await expect(f.client.fetch(url, workOptions())).rejects.toThrow(
      "Configured voice gateway request failed",
    );
    expect(f.original).not.toHaveBeenCalled();
    const log = (globalThis as { __codexhostChatVoiceDebug?: unknown[] }).__codexhostChatVoiceDebug;
    expect(JSON.stringify(log)).toContain("gateway-create");
    expect(JSON.stringify(log)).toContain('"stage":"identity"');
    expect(JSON.stringify(log)).toContain('"cause":"failed"');
    expect(JSON.stringify(log)).not.toContain("offer");
  });
  it("records Chat passthrough debug without credentials", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, {
      ...options(chatBody()),
      headers: { Authorization: "Bearer secret-token", "Thread-Id": "conv-chat-1" },
    });
    const log = (globalThis as { __codexhostChatVoiceDebug?: unknown[] }).__codexhostChatVoiceDebug;
    expect(JSON.stringify(log)).not.toContain("secret-token");
    expect(JSON.stringify(log)).toContain("chat-native-passthrough");
    expect(JSON.stringify(log)).toContain('"hasThreadId":true');
    const persisted = globalThis.localStorage?.getItem("codexhost.chat-voice-debug.v1");
    if (persisted !== undefined && persisted !== null)
      expect(persisted).toContain("chat-native-passthrough");
  });
  it("keeps Desktop login headers on native Chat /wham", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, {
      ...options(chatBody()),
      headers: {
        Authorization: "Bearer desktop-oauth",
        "ChatGPT-Account-Id": "acct-fixture",
      },
    });
    const forwarded = f.original.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(forwarded.Authorization).toBe("Bearer desktop-oauth");
    expect(forwarded["ChatGPT-Account-Id"]).toBe("acct-fixture");
    expect(f.original.mock.calls[0]?.[0]).toBe(url);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("treats a Harness backend model as Work even on the Chat surface", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(
      url,
      options(speechBody(), {
        "x-codex-turn-metadata": JSON.stringify({
          backend_model_name: "codexhost/plugin-v1@grok-test-model",
        }),
      }),
    );
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("treats the Work composer surface as Work without backend metadata", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => true,
    );
    await f.client.fetch(url, options(speechBody()));
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("does not treat a gpt-live backend name as Work", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(
      url,
      options(speechBody(), {
        "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "gpt-live-1-codex" }),
      }),
    );
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.original.mock.calls[0]?.[0]).toBe(url);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("routes a Chat call through Host only when the Chat override is on", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => true,
    );
    const response = await f.client.fetch(url, options(chatBody()));
    expect(response.status).toBe(201);
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch.mock.calls[0]?.[1]).toMatchObject({
      request: { params: { operation: "create", body: chatBody() } },
    });
  });
  it("preserves gateway quota errors without falling back to the signed-in account", async () => {
    const f = fixture({ status: 429, body: "usage_limit_reached", headers: { location: "" } });
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await expect(f.client.fetch(url, workOptions())).rejects.toMatchObject({
      message: "usage_limit_reached",
      status: 429,
    });
    expect(f.original).not.toHaveBeenCalled();
  });
  it("hangs up an answer that arrives after cancellation", async () => {
    const f = fixture();
    const abort = new AbortController();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    const creation = f.client.fetch(url, { ...workOptions(), signal: abort.signal });
    abort.abort();
    await expect(creation).rejects.toMatchObject({ name: "AbortError" });
    expect(
      f.dispatch.mock.calls.map(([, value]) => (value.request as { params: unknown }).params),
    ).toContainEqual({ operation: "hangup", callId: "rtc_fixture" });
  });
  it("installs only after both audited assets are present", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const names = [CLIENT_OWNED_VOICE_INITIAL_ASSET];
    const target = {
      [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
        enabled: true,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      document: {
        querySelectorAll: () => names.map((name) => ({ getAttribute: () => `/assets/${name}` })),
      } as unknown as ParentNode,
      setTimeout,
      clearTimeout,
    };
    const importModule = vi.fn(async () => sharedExports(f));
    const hook = installClientOwnedVoiceHook({ target, importModule });
    expect(importModule).not.toHaveBeenCalled();
    names.push(CLIENT_OWNED_VOICE_SHARED_ASSET);
    await vi.advanceTimersByTimeAsync(250);
    expect(hook.status).toBe("active");
    expect(importModule).toHaveBeenCalledWith(`app://-/assets/${CLIENT_OWNED_VOICE_SHARED_ASSET}`);
    hook.dispose();
    expect(f.client.fetch).toBe(f.original);
  });
  it.each([
    ["26.1027.30824", "app-initial-60f141238751.js", "app-shared-7815d5a1a42a.js"],
    ["26.1023.51421", "app-initial-bc8256c3cccb.js", "app-shared-e9f258fd3588.js"],
    ["26.1021.31345", "app-initial-feb30b196d11.js", "app-shared-2cae01273bae.js"],
    ["26.1016.62342", "app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js"],
    ["26.1016.61520", "app-initial-c95ddb62696e.js", "app-shared-2eda13eb7044.js"],
  ])(
    "routes explicit Work through its qualified %s WebFetch",
    async (desktopVersion, initial, shared) => {
      vi.useFakeTimers();
      const f = fixture();
      const target = {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion,
          desktopPlatform: "darwin",
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        },
        document: {
          querySelectorAll: () =>
            [initial, shared].map((name) => ({ getAttribute: () => `app://-/assets/${name}` })),
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      };
      const importModule = vi.fn(async () => sharedExports(f));
      const hook = installClientOwnedVoiceHook({ target, importModule });
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      expect(importModule).toHaveBeenCalledWith(`app://-/assets/${shared}`);
      rememberVoiceProductExperience({ productExperience: "work" });
      await f.client.fetch(
        url,
        options(speechBody(), {
          "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "gpt-6.1-sol" }),
        }),
      );
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
      hook.dispose();
      expect(f.client.fetch).toBe(f.original);
    },
  );

  it("routes 26.1027 Work through the initialized fetch owner and its native error handler", async () => {
    vi.useFakeTimers();
    const f = fixture({ status: 429, body: "usage_limit_reached", headers: { location: "" } });
    const unrelated = vi.fn(() => {
      throw new Error("Unrelated native export");
    });
    const initial: Record<string, unknown> = {
      Edr: vi.fn(() => {
        initial.wdr = { getInstance: () => f.client };
      }),
      Adr: f.responseError,
      Oit: unrelated,
    };
    const shared = { LRt: { getInstance: () => f.bridge }, Oit: unrelated, Mit: unrelated };
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: "26.1027.30824",
          desktopPlatform: "darwin",
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => "app://-/assets/app-shared-7815d5a1a42a.js" },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async (url) => (url.includes("app-initial") ? initial : shared),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      expect(initial.Edr).toHaveBeenCalledOnce();
      rememberVoiceProductExperience({ productExperience: "work" });
      await expect(f.client.fetch(url, options(speechBody()))).rejects.toMatchObject({
        message: "usage_limit_reached",
        status: 429,
      });
      expect(f.responseError).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
      expect(unrelated).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
    expect(f.client.fetch).toBe(f.original);
  });

  it("routes 26.1027.61615 Work through the initialized fetch owner and its native error handler", async () => {
    vi.useFakeTimers();
    const f = fixture({ status: 429, body: "usage_limit_reached", headers: { location: "" } });
    const unrelated = vi.fn(() => {
      throw new Error("Unrelated native export");
    });
    const initial: Record<string, unknown> = {
      Adr: vi.fn(() => {
        initial.Odr = { getInstance: () => f.client };
      }),
      Pdr: f.responseError,
      Oit: unrelated,
    };
    const shared = { LRt: { getInstance: () => f.bridge }, Oit: unrelated, Mit: unrelated };
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: "26.1027.61615",
          desktopPlatform: "darwin",
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => "app://-/assets/app-shared-601019a330d7.js" },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async (url) => (url.includes("app-initial") ? initial : shared),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      expect(initial.Adr).toHaveBeenCalledOnce();
      rememberVoiceProductExperience({ productExperience: "work" });
      await expect(f.client.fetch(url, options(speechBody()))).rejects.toMatchObject({
        message: "usage_limit_reached",
        status: 429,
      });
      expect(f.responseError).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
      expect(unrelated).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
    expect(f.client.fetch).toBe(f.original);
  });

  it("wraps 26.1106.51428 hashed webpack WebFetch and Host bridge", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          voiceEvidence: [
            reviewedVoiceEvidenceRecord({
              path: "work-codex",
              desktopPlatform: "darwin",
              desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            }),
          ],
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async (url) => {
        expect(url).toBe(`app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}`);
        return { __webpack_require__: require };
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      expect(hook.activation).toEqual({
        assetSeen: true,
        importStarted: true,
        importResolved: true,
        factoryHooked: false,
        wrapperActive: true,
      });
      expect(require).toHaveBeenCalledWith("GDNt");
      rememberVoiceProductExperience({ productExperience: "work" });
      await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
    expect(f.client.fetch).toBe(f.original);
  });

  it("hooks overlay GDNt factory without executing an incomplete webpack module", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const cache: Record<string, { exports: Record<string, unknown> }> = {
      GDNt: { exports: {} },
    };
    const factories: Record<string, (module?: unknown, exports?: Record<string, unknown>) => void> =
      {
        GDNt(module, exports) {
          if (exports) exports._n = fetchClass;
        },
      };
    const require = Object.assign(
      (id: string) => {
        if (id === "TL6G") return { O1: f.bridge };
        if (id === "eShZ") return { s1: f.responseError };
        if (id === "GDNt") throw new Error("Cannot read properties of undefined (reading 'call')");
        throw new Error(id);
      },
      { m: factories, c: cache },
    );
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          voiceEvidence: [
            reviewedVoiceEvidenceRecord({
              path: "work-codex",
              desktopPlatform: "darwin",
              desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            }),
          ],
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.GDNt).toBeUndefined();
      expect(hook.status).toBe("pending");
      expect(hook.activation).toMatchObject({
        importResolved: true,
        factoryHooked: true,
        wrapperActive: false,
      });
      const exports: Record<string, unknown> = {};
      const factory = factories.GDNt;
      if (!factory) throw new Error("Expected installed voice factory");
      factory({}, exports);
      expect(hook.status).toBe("active");
      expect(hook.activation?.wrapperActive).toBe(true);
      rememberVoiceProductExperience({ productExperience: "work" });
      await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("uses remembered Work launch ownership on hashed overlay, not the overlay URL", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    const values = new Map<string, string>([
      [
        "codexhost.voice-routes-cache.v1",
        JSON.stringify({
          chatExperience: "chatgpt",
          chatConnection: "desktop",
          workConnection: "gateway",
        }),
      ],
      [CPA_LIVE_VOICE_STORAGE_KEY, "0"],
    ]);
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          voiceEvidence: [
            reviewedVoiceEvidenceRecord({
              path: "work-codex",
              desktopPlatform: "darwin",
              desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            }),
          ],
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: { getItem: (key: string) => values.get(key) ?? null },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      await f.client.fetch(url, options(speechBody()));
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("publishes Chat from a visible Chat composer even if Work storage is stale", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    const chatComposer = {
      getBoundingClientRect: () => ({ width: 640 }),
      closest: () => null,
    };
    rememberVoiceProductExperience({ productExperience: "chat" });
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          voiceEvidence: [
            reviewedVoiceEvidenceRecord({
              path: "work-codex",
              desktopPlatform: "darwin",
              desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            }),
          ],
        },
        localStorage: {
          getItem: (key: string) =>
            key === HOME_COMPOSER_MODE_STORAGE_KEY
              ? "work"
              : key === "codexhost.voice-routes-cache.v1"
                ? JSON.stringify({
                    chatExperience: "chatgpt",
                    chatConnection: "desktop",
                    workConnection: "gateway",
                  })
                : null,
        },
        document: {
          querySelectorAll: (selector: string) => {
            if (selector.includes("script[src]"))
              return [
                { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
              ];
            if (selector === "[data-chatgpt-composer]") return [chatComposer];
            return [];
          },
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      await expect(
        f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" })),
      ).rejects.toThrow("Chat voice is not qualified on this Desktop.");
      expect(f.original).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("blocks hashed overlay Chat Instant Connect /wham when Chat is not qualified", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    rememberVoiceProductExperience({ productExperience: "chat" });
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          voiceEvidence: [
            reviewedVoiceEvidenceRecord({
              path: "work-codex",
              desktopPlatform: "darwin",
              desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            }),
          ],
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: {
          getItem: (key: string) =>
            key === "codexhost.voice-routes-cache.v1"
              ? JSON.stringify({
                  chatExperience: "chatgpt",
                  chatConnection: "desktop",
                  workConnection: "gateway",
                })
              : key === VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY
                ? "chat"
                : null,
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      const request = options(speechBody(), { originator: "codex_work_desktop" });
      await expect(f.client.fetch(url, request)).rejects.toThrow(
        "Chat voice is not qualified on this Desktop.",
      );
      expect(f.original).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("blocks hashed overlay Work /wham when the isolated marker is Chat-only", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    rememberVoiceProductExperience({ productExperience: "work" });
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const hook = installHashedOverlayVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          desktopAppPath: appPath,
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          isolatedQualification: {
            path: "chat",
            run: "2026-11-14-isolated",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
            desktopPlatform: "darwin",
            asarDigest: TEST_REVIEWED_ASAR_DIGEST,
            appPath,
            implementationRevision: voiceImplementationRevision(),
            label: "unqualified-isolated",
          },
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: {
          getItem: (key: string) =>
            key === "codexhost.voice-routes-cache.v1"
              ? JSON.stringify({
                  chatExperience: "chatgpt",
                  chatConnection: "desktop",
                  workConnection: "gateway",
                })
              : null,
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      await expect(
        f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" })),
      ).rejects.toThrow("Work voice is not qualified on this Desktop.");
      expect(f.original).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("blocks hashed overlay Chat /wham when the isolated marker is Work-only", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    rememberVoiceProductExperience({ productExperience: "chat" });
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const hook = installHashedOverlayVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          desktopAppPath: appPath,
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          isolatedQualification: {
            path: "work-codex",
            run: "2026-11-14-isolated",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
            desktopPlatform: "darwin",
            asarDigest: TEST_REVIEWED_ASAR_DIGEST,
            appPath,
            implementationRevision: voiceImplementationRevision(),
            label: "unqualified-isolated",
          },
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: {
          getItem: (key: string) =>
            key === "codexhost.voice-routes-cache.v1"
              ? JSON.stringify({
                  chatExperience: "chatgpt",
                  chatConnection: "desktop",
                  workConnection: "gateway",
                })
              : key === VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY
                ? "chat"
                : null,
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      await expect(
        f.client.fetch(url, options(speechBody(), { originator: "Codex Desktop" })),
      ).rejects.toThrow("Chat voice is not qualified on this Desktop.");
      expect(f.original).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("gateways hashed overlay Work/Codex when the isolated marker qualifies that lane", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    rememberVoiceProductExperience({ productExperience: "work" });
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const hook = installHashedOverlayVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          desktopAppPath: appPath,
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          isolatedQualification: {
            path: "work-codex",
            run: "2026-11-14-isolated",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
            desktopPlatform: "darwin",
            asarDigest: TEST_REVIEWED_ASAR_DIGEST,
            appPath,
            implementationRevision: voiceImplementationRevision(),
            label: "unqualified-isolated",
          },
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: {
          getItem: (key: string) =>
            key === "codexhost.voice-routes-cache.v1"
              ? JSON.stringify({
                  chatExperience: "chatgpt",
                  chatConnection: "desktop",
                  workConnection: "gateway",
                })
              : null,
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("gateways Work and fail-closes ChatGPT Instant Connect on an explicit Chat+Work isolated path set", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const isolated = {
      path: "chat" as const,
      paths: ["chat", "work-codex"] as const,
      run: "2026-11-14-isolated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
      desktopPlatform: "darwin",
      asarDigest: TEST_REVIEWED_ASAR_DIGEST,
      appPath,
      implementationRevision: voiceImplementationRevision(),
      label: "unqualified-isolated" as const,
    };
    const hook = installHashedOverlayVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          desktopAppPath: appPath,
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          isolatedQualification: isolated,
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: {
          getItem: (key: string) =>
            key === "codexhost.voice-routes-cache.v1"
              ? JSON.stringify({
                  chatExperience: "chatgpt",
                  chatConnection: "desktop",
                  workConnection: "gateway",
                })
              : key === VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY
                ? "chat"
                : null,
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      rememberVoiceProductExperience({ productExperience: "chat" });
      await expect(
        f.client.fetch(url, options(speechBody(), { originator: "Codex Desktop" })),
      ).rejects.toThrow("Native Chat voice is unavailable");
      expect(f.original).not.toHaveBeenCalled();
      rememberVoiceProductExperience({ productExperience: "work" });
      await f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" }));
      expect(f.dispatch).toHaveBeenCalledOnce();
    } finally {
      hook.dispose();
    }
  });

  it("passthroughs hashed overlay Codex Chat Desktop without ChatGPT Instant Connect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    rememberVoiceProductExperience({ productExperience: "chat" });
    const hook = installHashedOverlayVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: {
          getItem: (key: string) =>
            key === "codexhost.voice-routes-cache.v1"
              ? JSON.stringify({
                  chatExperience: "codex",
                  chatConnection: "desktop",
                  workConnection: "gateway",
                })
              : key === VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY
                ? "chat"
                : null,
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      await f.client.fetch(url, options(speechBody(), { originator: "Codex Desktop" }));
      expect(f.original).toHaveBeenCalledOnce();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("gateways hashed overlay Work/Grok when the isolated marker qualifies that lane", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    rememberVoiceProductExperience({ productExperience: "work" });
    const appPath = "/tmp/codexhost-update-impact/26.1106.51428/bundle/ChatGPT.app";
    const hook = installHashedOverlayVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          desktopAppPath: appPath,
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          isolatedQualification: {
            path: "work-grok",
            run: "2026-11-14-isolated",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            desktopBuild: TEST_REVIEWED_NATIVE_BUILD,
            desktopPlatform: "darwin",
            asarDigest: TEST_REVIEWED_ASAR_DIGEST,
            appPath,
            implementationRevision: voiceImplementationRevision(),
            label: "unqualified-isolated",
          },
        },
        location: { href: "app://-/index.html?initialRoute=%2Favatar-overlay" },
        localStorage: {
          getItem: (key: string) =>
            key === "codexhost.voice-routes-cache.v1"
              ? JSON.stringify({
                  chatExperience: "chatgpt",
                  chatConnection: "desktop",
                  workConnection: "gateway",
                })
              : null,
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      await f.client.fetch(
        url,
        options(speechBody(), {
          originator: "codex_work_desktop",
          "x-codex-turn-metadata": JSON.stringify({
            backend_model_name: "codexhost/grok/grok-4",
          }),
        }),
      );
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("records hashed webpack import failure without wrapping", async () => {
    vi.useFakeTimers();
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          voiceEvidence: [
            reviewedVoiceEvidenceRecord({
              path: "work-codex",
              desktopPlatform: "darwin",
              desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            }),
          ],
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => {
        throw new Error("runtime chunk missing");
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("pending");
      expect(hook.activation).toMatchObject({
        assetSeen: true,
        importStarted: true,
        importResolved: false,
        importFailed: "hashed-import-failed",
        factoryHooked: false,
        wrapperActive: false,
      });
    } finally {
      hook.dispose();
    }
  });

  it("does not create a native or CPA Work call without reviewed Work/Codex evidence", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      rememberVoiceProductExperience({ productExperience: "work" });
      await expect(
        f.client.fetch(url, options(speechBody(), { originator: "codex_work_desktop" })),
      ).rejects.toThrow("Work voice is not qualified on this Desktop.");
      expect(f.original).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("does not let Work/Codex evidence qualify a Grok model", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetchClass = Object.assign(function WebFetch() {}, {
      getInstance: () => f.client,
    });
    const require = vi.fn((id: string) => {
      if (id === "GDNt") return { _n: fetchClass };
      if (id === "TL6G") return { O1: f.bridge };
      if (id === "eShZ") return { s1: f.responseError };
      throw new Error(id);
    });
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
          desktopPlatform: "darwin",
          ...hashedVoiceTestIdentity(),
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
          voiceEvidence: [
            reviewedVoiceEvidenceRecord({
              path: "work-codex",
              desktopPlatform: "darwin",
              desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
            }),
          ],
        },
        document: {
          querySelectorAll: () => [
            { getAttribute: () => `app://-/assets/${HASHED_WEBPACK_VOICE_RUNTIME_ASSET}` },
          ],
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      },
      importModule: async () => ({ __webpack_require__: require }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      rememberVoiceProductExperience({ productExperience: "work" });
      await expect(
        f.client.fetch(
          url,
          options(speechBody(), {
            "x-codex-turn-metadata": JSON.stringify({
              backend_model_name: "codexhost/grok/grok-4",
            }),
          }),
        ),
      ).rejects.toThrow("Work voice is not qualified on this Desktop.");
      expect(f.original).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  it("initializes the 26.1023 fetch owner without invoking reused legacy exports", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const unrelated = vi.fn(() => {
      throw new Error("Unrelated native initializer");
    });
    const initial: Record<string, unknown> = {
      Oit: unrelated,
      xir: vi.fn(() => {
        initial.yir = { getInstance: () => f.client };
      }),
    };
    const shared = { QIt: { getInstance: () => f.bridge }, Oit: unrelated };
    const hook = installClientOwnedVoiceHook({
      target: {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion: "26.1023.51421",
          desktopPlatform: "darwin",
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        },
        setTimeout,
        clearTimeout,
      },
      importModule: async (url) => (url.includes("app-initial") ? initial : shared),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      expect(initial.xir).toHaveBeenCalledOnce();
      expect(unrelated).not.toHaveBeenCalled();
      await f.client.fetch(url, workOptions());
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
    expect(f.client.fetch).toBe(f.original);
  });

  it("initializes lazy native WebFetch exports before installing on a cold document", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const target = {
      [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
        enabled: true,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      document: {
        querySelectorAll: () =>
          [CLIENT_OWNED_VOICE_INITIAL_ASSET, CLIENT_OWNED_VOICE_SHARED_ASSET].map((name) => ({
            getAttribute: () => `/assets/${name}`,
          })),
      } as unknown as ParentNode,
      performance: { getEntriesByType: () => [] },
      setTimeout,
      clearTimeout,
    };
    Object.assign(target[CPA_LIVE_VOICE_HOOK_GLOBAL], {
      desktopVersion: "26.1016.62342",
      desktopPlatform: "darwin",
    });
    const module: Record<string, unknown> = {
      Oit: vi.fn(() => {
        module.Eit = { getInstance: () => f.client };
        module.AFt = { getInstance: () => f.bridge };
        module.Mit = f.responseError;
      }),
    };
    const names = ["app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js"];
    target.document = {
      querySelectorAll: () => names.map((name) => ({ getAttribute: () => `/assets/${name}` })),
    } as unknown as ParentNode;
    const hook = installClientOwnedVoiceHook({ target, importModule: async () => module });
    await vi.advanceTimersByTimeAsync(0);
    expect(module.Oit).toHaveBeenCalledOnce();
    expect(hook.status).toBe("active");
    await f.client.fetch(url, workOptions());
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.original).not.toHaveBeenCalled();
    hook.dispose();
  });
  it("still installs with the Work override off and applies the Chat override", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const values = new Map<string, string>([
      [CPA_LIVE_VOICE_STORAGE_KEY, "0"],
      [CHAT_LIVE_VOICE_STORAGE_KEY, "1"],
    ]);
    const target = {
      [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
        enabled: true,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
      document: {
        querySelectorAll: () =>
          [CLIENT_OWNED_VOICE_INITIAL_ASSET, CLIENT_OWNED_VOICE_SHARED_ASSET].map((name) => ({
            getAttribute: () => `/assets/${name}`,
          })),
      } as unknown as ParentNode,
      performance: { getEntriesByType: () => [] },
      setTimeout,
      clearTimeout,
    };
    const importModule = vi.fn(async () => sharedExports(f));
    const hook = installClientOwnedVoiceHook({ target, importModule });
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.status).toBe("active");
    await f.client.fetch(url, options(chatBody()));
    expect(f.dispatch).toHaveBeenCalledOnce();
    await f.client.fetch(url, workOptions());
    expect(f.original).toHaveBeenCalledOnce();
    hook.dispose();
  });
});

describe("explicit Chat launch ownership", () => {
  it("does not gateway a Grok model from the Work/Codex override alone", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "work" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => true,
      () => true,
      () => false,
      () => false,
    );
    const request = options(speechBody(), {
      "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "codexhost/grok/grok-4" }),
    });
    await expect(f.client.fetch(url, request)).rejects.toThrow(
      "Work voice is not qualified on this Desktop.",
    );
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("keeps Chat /wham passthrough despite stale Work surface, Harness model and lastAgent", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => true,
      () => true,
    );
    const request = options(speechBody(), {
      "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "codexhost/grok/grok-4" }),
    });
    await f.client.fetch(url, request);
    expect(f.original).toHaveBeenCalledWith(url, request);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("applies the Chat override rather than the Work switch to an explicit Chat launch", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => true,
      () => true,
      () => false,
    );
    await f.client.fetch(url, workOptions());
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it("passes overlay Chat Instant Connect through when Work gateway existingCall would 404", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => false,
      () => false,
      () => true,
    );
    await f.client.fetch(url, options(speechBody(), { originator: "Codex Desktop" }));
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("blocks Chat /wham when the Chat lane is not qualified", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => false,
      () => false,
      () => false,
      () => true,
      () => true,
      (kind) =>
        kind === "chat"
          ? "Chat voice is not qualified on this Desktop."
          : "Work voice is not qualified on this Desktop.",
      () => false,
    );
    await expect(f.client.fetch(url, options(speechBody()))).rejects.toThrow(
      "Chat voice is not qualified on this Desktop.",
    );
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("does not passthrough hashed Chat Instant Connect /wham when native Chat owns WM", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => false,
      () => false,
      () => false,
      () => true,
      () => true,
      () => "Work voice is not qualified on this Desktop.",
      () => true,
      () => false,
    );
    await expect(f.client.fetch(url, options(speechBody()))).rejects.toThrow(
      "Native Chat voice is unavailable",
    );
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("passthroughs explicit Codex Chat Desktop /wham without ChatGPT Instant Connect", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => false,
      () => false,
      () => false,
      () => true,
      () => true,
      () => "Work voice is not qualified on this Desktop.",
      () => false,
      () => false,
      () => false,
    );
    await f.client.fetch(url, options(speechBody()));
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("keeps explicit Codex Chat gateway on Host when Chat is qualified", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => true,
      () => false,
      () => false,
      () => false,
      () => true,
      () => true,
      () => "Work voice is not qualified on this Desktop.",
      () => true,
      () => false,
      () => false,
    );
    await f.client.fetch(url, options(speechBody()));
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it("does not send explicit Codex Chat gateway when Chat is unqualified", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => true,
      () => false,
      () => false,
      () => false,
      () => true,
      () => true,
      (kind) =>
        kind === "chat"
          ? "Chat voice is not qualified on this Desktop."
          : "Work voice is not qualified on this Desktop.",
      () => false,
      () => false,
      () => false,
    );
    await expect(f.client.fetch(url, options(speechBody()))).rejects.toThrow(
      "Chat voice is not qualified on this Desktop.",
    );
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

describe("isWorkComposerSurface", () => {
  function owner(mode: string | null, tabs: { name: string; selected?: boolean }[]) {
    const storage = {
      getItem: (key: string) => (key === "home-composer-mode-v1" ? mode : null),
    };
    const nodes = tabs.map((tab) => ({
      textContent: tab.name,
      getAttribute: (name: string) =>
        name === "aria-selected" ? (tab.selected ? "true" : "false") : "",
    }));
    return {
      localStorage: storage,
      document: { querySelectorAll: () => nodes },
    };
  }

  it("treats a selected Work tab as Work when composer-mode storage is empty", () => {
    expect(
      isWorkComposerSurface(owner(null, [{ name: "Chat" }, { name: "Work", selected: true }])),
    ).toBe(true);
  });

  it("treats a visible official Work composer as Work when storage is empty", () => {
    const composer = {
      getBoundingClientRect: () => ({ width: 800 }),
      closest: () => null,
    };
    expect(
      isWorkComposerSurface({
        localStorage: { getItem: () => null },
        document: {
          querySelectorAll: (selector: string) =>
            selector === "[data-codex-composer-root]"
              ? [composer]
              : selector === "[data-chatgpt-composer]"
                ? []
                : [],
        },
      }),
    ).toBe(true);
  });

  it("does not treat official Chat as Work", () => {
    expect(
      isWorkComposerSurface(owner(null, [{ name: "Chat", selected: true }, { name: "Work" }])),
    ).toBe(false);
  });

  it.each(["zero-size", "hidden", "inert"])(
    "ignores a retained %s Chat composer beside the visible Work composer",
    (hiddenBy) => {
      const work = { getBoundingClientRect: () => ({ width: 800 }), closest: () => null };
      const chat = {
        getBoundingClientRect: () => ({ width: hiddenBy === "zero-size" ? 0 : 800 }),
        closest: () => (hiddenBy === "zero-size" ? null : {}),
      };
      expect(
        isWorkComposerSurface({
          localStorage: { getItem: () => null },
          document: {
            querySelectorAll: (selector: string) =>
              selector === "[data-codex-composer-root]"
                ? [work]
                : selector === "[data-chatgpt-composer]"
                  ? [chat]
                  : [],
          },
        }),
      ).toBe(true);
    },
  );

  it("rejects a Work surface when a visible Chat composer is also present", () => {
    const visible = { getBoundingClientRect: () => ({ width: 800 }), closest: () => null };
    expect(
      isWorkComposerSurface({
        localStorage: { getItem: () => null },
        document: {
          querySelectorAll: (selector: string) =>
            selector === "[data-codex-composer-root]" || selector === "[data-chatgpt-composer]"
              ? [visible]
              : [],
        },
      }),
    ).toBe(false);
  });

  it("keeps explicit chat storage off Work even if a Work tab is selected", () => {
    expect(isWorkComposerSurface(owner("chat", [{ name: "Work", selected: true }]))).toBe(false);
  });
});
