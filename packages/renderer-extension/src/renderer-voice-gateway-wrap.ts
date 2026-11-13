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

export function requestVoiceHost(
  bridge: NativeVoiceBridge,
  params: RecordValue,
  method: string = REALTIME_CALL_METHOD,
): Promise<unknown> {
  const id = `codexhost-voice:${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Voice gateway did not answer in time"));
    }, 30_000);
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
      if (event.message.error) reject(new Error("Configured voice gateway request failed"));
      else resolve(event.message.result);
    });
    try {
      bridge.dispatchMessage("mcp-request", {
        hostId: "local",
        request: { id, method, params },
      });
    } catch {
      done();
      reject(new Error("Voice gateway Host connection is unavailable"));
    }
  });
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
    const gateway = external || (work ? workOverride() : chatOverride());
    chatVoiceDebug("wham-create", {
      work,
      external,
      route: gateway ? "gateway" : "desktop",
      productExperience: experience ?? "unset",
      originator: originator ?? "unset",
      overlayWork,
      overlayHostCreate,
    });
    if (!gateway) {
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
      const result = parseRealtimeCallResponse(
        await requestVoiceHost(bridge, {
          operation: "create",
          requestId,
          body: options.body,
          headers: filterRealtimeCallHeaders(Object.fromEntries(new Headers(options.headers))),
        }),
      );
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
