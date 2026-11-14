import {
  REALTIME_CALL_METHOD,
  filterRealtimeCallHeaders,
  isRealtimeCallId,
  realtimeCallIdFromLocation,
} from "@codexhost/shared-contracts/realtime-call-core";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";

type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

export interface NativeVoiceBridge {
  dispatchMessage(type: string, message: RecordValue): void;
  subscribe(type: string, listener: (message: unknown) => void): () => void;
}

export interface NativeVoiceFetch {
  fetch(url: string, options?: RequestInit): Promise<Response>;
}

const HOST_MCP_TIMEOUT_MESSAGE = "Host request timed out";
const HOST_MCP_UNAVAILABLE_MESSAGE = "Local Host connection is unavailable";
export const DIRECT_VOICE_HOST_GLOBAL = "__codexhostVoiceHostV1";

export interface DirectVoiceHostCapability {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export function resolveDirectVoiceHost(
  owner: object = globalThis,
): DirectVoiceHostCapability | null {
  const value = Reflect.get(owner, DIRECT_VOICE_HOST_GLOBAL);
  if (!value || typeof value !== "object") return null;
  const request = Reflect.get(value, "request");
  return typeof request === "function"
    ? { request: request.bind(value) as DirectVoiceHostCapability["request"] }
    : null;
}

function hostMcpStage(
  value: unknown,
): "config" | "request" | "transport" | "identity" | "cancel" | "rpc" {
  return value === "config" ||
    value === "request" ||
    value === "transport" ||
    value === "identity" ||
    value === "cancel"
    ? value
    : "rpc";
}

/** JSON-RPC over Instant Connect mcp-request. Native AppServer sendRequest rejects
 * unknown `codexhost/` variants before Host sees them. */
export function requestLocalHostMcp(
  bridge: NativeVoiceBridge,
  method: string,
  params: RecordValue,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const id = `codexhost-voice:${crypto.randomUUID()}`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(HOST_MCP_TIMEOUT_MESSAGE));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    unsubscribe = bridge.subscribe("mcp-response", (event) => {
      if (
        !object(event) ||
        event.hostId !== "local" ||
        !object(event.message) ||
        event.message.id !== id
      )
        return;
      done();
      if (event.message.error) {
        const error = object(event.message.error) ? event.message.error : undefined;
        const data = object(error?.data) ? error.data : undefined;
        const message =
          typeof error?.message === "string" &&
          error.message.length > 0 &&
          error.message.length <= 500
            ? error.message
            : "Host request failed";
        reject(Object.assign(new Error(message), { stage: hostMcpStage(data?.stage) }));
        return;
      }
      resolve(event.message.result);
    });
    try {
      bridge.dispatchMessage("mcp-request", {
        hostId: "local",
        request: { id, method, params },
      });
    } catch {
      done();
      reject(new Error(HOST_MCP_UNAVAILABLE_MESSAGE));
    }
  });
}

export function requestVoiceHost(
  _bridge: NativeVoiceBridge | null | undefined,
  params: RecordValue,
  method: string = REALTIME_CALL_METHOD,
): Promise<unknown> {
  const host = resolveDirectVoiceHost();
  if (!host) {
    chatVoiceDebug("gateway-create", { stage: "rpc", cause: "host-unavailable" });
    return Promise.reject(new Error("Voice gateway Host connection is unavailable"));
  }
  return host.request(method, params).then(
    (result) => result,
    (error) => {
      const message = error instanceof Error ? error.message : "";
      if (message === HOST_MCP_TIMEOUT_MESSAGE || /timed out/i.test(message)) {
        chatVoiceDebug("gateway-create", { stage: "rpc", cause: "timeout" });
        throw new Error("Voice gateway did not answer in time");
      }
      if (message === HOST_MCP_UNAVAILABLE_MESSAGE) {
        chatVoiceDebug("gateway-create", { stage: "rpc", cause: "host-unavailable" });
        throw new Error("Voice gateway Host connection is unavailable");
      }
      const stage = error instanceof Error && "stage" in error ? hostMcpStage(error.stage) : "rpc";
      chatVoiceDebug("gateway-create", { stage, cause: "failed" });
      throw new Error("Configured voice gateway request failed");
    },
  );
}

function parseRealtimeCallResponse(value: unknown): {
  status: number;
  body: string;
  headers: Record<string, string>;
} {
  if (value === null || typeof value !== "object")
    throw new Error("Invalid voice gateway response");
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "number" ||
    !Number.isInteger(record.status) ||
    record.status < 200 ||
    record.status > 599 ||
    typeof record.body !== "string" ||
    record.headers === null ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers)
  ) {
    throw new Error("Invalid voice gateway response");
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(record.headers as Record<string, unknown>)) {
    if (typeof header === "string") headers[name] = header;
  }
  return { status: record.status, body: record.body, headers };
}

function backendModelName(headers?: HeadersInit): string {
  const raw = new Headers(headers).get("x-codex-turn-metadata");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { backend_model_name?: unknown };
    return typeof parsed.backend_model_name === "string" ? parsed.backend_model_name : "";
  } catch {
    return "";
  }
}

function isWorkBackendModel(name: string): boolean {
  const model = name.toLowerCase();
  if (!model) return false;
  if (model.startsWith("codexhost/")) return true;
  return model.includes("codex") && !model.includes("gpt-live");
}

let lastVoiceProductExperience: string | undefined;

/** Shared across the primary Composer and avatar overlay JavaScript realms. */
export const VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY = "codexhost.voice-launch-experience.v1";

function launchStorage(owner: object): Storage | undefined {
  return (owner as { localStorage?: Storage }).localStorage;
}

function storedVoiceProductExperience(owner: object): string | undefined {
  try {
    const stored = launchStorage(owner)?.getItem(VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY);
    return stored === "chat" || stored === "work" || stored === "codex" ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function rememberVoiceProductExperience(request: unknown, owner: object = globalThis): void {
  const experience = object(request) ? request.productExperience : undefined;
  lastVoiceProductExperience =
    experience === "chat" || experience === "work" || experience === "codex"
      ? experience
      : undefined;
  try {
    const storage = launchStorage(owner);
    if (!storage) return;
    if (lastVoiceProductExperience)
      storage.setItem(VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY, lastVoiceProductExperience);
    else storage.removeItem(VOICE_LAUNCH_EXPERIENCE_STORAGE_KEY);
  } catch {
    /* In-memory launch ownership still applies in this JavaScript realm. */
  }
}

export function lastVoiceLaunchProductExperience(owner: object = globalThis): string | undefined {
  return lastVoiceProductExperience ?? storedVoiceProductExperience(owner);
}

/** Only the audited native WebFetch voice bootstrap is forwarded. Other native
 * requests retain their receiver, arguments, authentication and error behavior.
 */
export function wrapClientOwnedVoiceFetch(
  client: NativeVoiceFetch,
  bridge: NativeVoiceBridge,
  workOverride: () => boolean,
  responseError: (response: Response, url: string) => Promise<unknown>,
  chatOverride: () => boolean = () => false,
  workSurface: () => boolean = () => false,
  externalHarness: () => boolean = () => false,
  overlayExistingCall: () => boolean = () => false,
  externalLane: () => boolean = () => true,
  workLane: () => boolean = () => true,
  unavailableReason: (kind: "work" | "external" | "chat") => string = (kind) =>
    kind === "chat"
      ? "Chat voice is not qualified on this Desktop."
      : "Work voice is not qualified on this Desktop.",
  chatLane: () => boolean = () => true,
  allowChatNativeWham: () => boolean = () => true,
  chatgptInstantConnect: () => boolean = () => true,
): () => void {
  const original = client.fetch;
  const wrapped: NativeVoiceFetch["fetch"] = async function (this: NativeVoiceFetch, url, options) {
    if (
      typeof url !== "string" ||
      url.split("?")[0] !== "/wham/realtime/calls" ||
      options?.method !== "POST"
    )
      return original.call(this, url, options);
    const experience = lastVoiceLaunchProductExperience();
    const model = backendModelName(options.headers);
    const originator = new Headers(options.headers).get("originator");
    // Overlay Voice Chat has no Composer. Compact Work still sets
    // originator=codex_work_desktop. Chat Instant Connect can reuse that
    // originator after a Chat launch, so Chat experience wins.
    const overlayWork = originator === "codex_work_desktop" && experience !== "chat";
    // Overlay existingCall Host-create is Work compact, not Chat Instant Connect.
    const overlayHostCreate = overlayExistingCall() && workOverride() && experience !== "chat";
    const chat = experience === "chat" && !overlayWork && !overlayHostCreate;
    const work =
      overlayWork ||
      overlayHostCreate ||
      (!chat &&
        (experience === "work" ||
          experience === "codex" ||
          isWorkBackendModel(model) ||
          workSurface()));
    const external = !chat && (model.startsWith("codexhost/") || externalHarness());
    const intendedGateway = external ? true : work ? workOverride() : chatOverride();
    const chatQualified = chatLane();
    const qualified = external ? externalLane() : work ? workLane() : chat ? chatQualified : true;
    const chatgptNative = chat && chatgptInstantConnect();
    const nativeChatWham =
      chatgptNative && !intendedGateway && allowChatNativeWham() && chatQualified;
    let route: "desktop" | "gateway" | "blocked";
    if (chatgptNative && !chatQualified) route = "blocked";
    else if (chatgptNative && !intendedGateway && !nativeChatWham) route = "blocked";
    else if (chat && intendedGateway && !chatQualified) route = "blocked";
    else if (!intendedGateway) route = "desktop";
    else if (qualified) route = "gateway";
    else route = "blocked";
    chatVoiceDebug("wham-create", {
      work,
      external,
      route,
      productExperience: experience ?? "unset",
      originator: originator ?? "unset",
      overlayWork,
      overlayHostCreate,
    });
    if (route === "blocked") {
      if (chat) {
        throw new Error(
          chatQualified ? "Native Chat voice is unavailable" : unavailableReason("chat"),
        );
      }
      throw new Error(unavailableReason(external ? "external" : "work"));
    }
    if (route === "desktop") {
      if (!external && !work)
        chatVoiceDebug("chat-native-passthrough", {
          hasThreadId: new Headers(options.headers).has("Thread-Id"),
        });
      return original.call(this, url, options);
    }
    if (typeof options.body !== "string") throw new Error("Unsupported native voice call request");
    options.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void requestVoiceHost(bridge, { operation: "cancel", requestId }).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      let result: ReturnType<typeof parseRealtimeCallResponse>;
      try {
        result = parseRealtimeCallResponse(
          await requestVoiceHost(bridge, {
            operation: "create",
            requestId,
            body: options.body,
            headers: filterRealtimeCallHeaders(Object.fromEntries(new Headers(options.headers))),
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid voice gateway response")
          chatVoiceDebug("gateway-create", { stage: "response", cause: "invalid" });
        throw error;
      }
      chatVoiceDebug("gateway-create", {
        stage: "status",
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
      });
      if (options.signal?.aborted) {
        const callId = realtimeCallIdFromLocation(result.headers.location ?? "");
        if (result.status >= 200 && result.status < 300 && isRealtimeCallId(callId))
          await requestVoiceHost(bridge, { operation: "hangup", callId });
        options.signal.throwIfAborted();
      }
      const response = new Response(result.status === 204 ? null : result.body, {
        status: result.status,
        headers: result.headers,
      });
      if (!response.ok) throw await responseError(response, url);
      return response;
    } catch (error) {
      cancel();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  };
  client.fetch = wrapped;
  return () => {
    if (client.fetch === wrapped) client.fetch = original;
  };
}
