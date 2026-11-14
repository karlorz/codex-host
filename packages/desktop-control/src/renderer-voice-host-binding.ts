import {
  REALTIME_CALL_METHOD,
  VOICE_GATEWAY_STATUS_METHOD,
  VOICE_SETTINGS_METHOD,
  isRealtimeCallId,
  realtimeCallIdFromLocation,
} from "@codexhost/shared-contracts";
import {
  isEligibleVoiceHostUrl,
  rendererVoiceHostDocumentGuardExpression,
} from "./renderer-app-url.js";

export const RENDERER_VOICE_HOST_BINDING_NAME = "__codexhostVoiceHostBindingV1";
export const RENDERER_VOICE_HOST_CAPABILITY_GLOBAL = "__codexhostVoiceHostV1";
export const RENDERER_VOICE_HOST_DELIVER_GLOBAL = "__codexhostVoiceHostDeliverV1";
export const RENDERER_VOICE_HOST_PENDING_GLOBAL = "__codexhostVoiceHostPendingV1";
export const RENDERER_VOICE_HOST_MAX_PAYLOAD_BYTES = 256 * 1024;
export const RENDERER_VOICE_HOST_SETTINGS_TIMEOUT_MS = 10_000;
export const RENDERER_VOICE_HOST_GATEWAY_TIMEOUT_MS = 2_000;
export const RENDERER_VOICE_HOST_REALTIME_TIMEOUT_MS = 30_000;

export const RENDERER_VOICE_HOST_METHODS = [
  VOICE_SETTINGS_METHOD,
  VOICE_GATEWAY_STATUS_METHOD,
  REALTIME_CALL_METHOD,
] as const;

const ALLOWED_METHODS = new Set<string>(RENDERER_VOICE_HOST_METHODS);
const STALE_CONTEXT =
  /uniqueContextId not found|Cannot find context with specified id|Execution context was destroyed|Cannot find default execution context/i;
const UNAVAILABLE = "Local Host connection is unavailable";
const UNKNOWN_OUTCOME = "Host request outcome is unknown. Do not retry automatically.";
export const RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED =
  "Original Host owner is unreachable; cleanup is unconfirmed. Do not retry automatically.";

export interface VoiceHostExecution {
  readonly generation: number;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface RendererVoiceHostOwner {
  readonly owner: string;
  readonly generation: number;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  bindExecution?(): VoiceHostExecution;
  onGenerationChange?(listener: () => void): () => void;
}

export interface RendererVoiceHostCdpClient {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  on(method: string, listener: (params: unknown) => void): () => void;
}

interface TrackedContext {
  uniqueId: string;
  isDefault: boolean;
}

interface InflightWork {
  pageId: string;
  contextId: number;
  uniqueId: string;
  generation: number;
  execution: VoiceHostExecution;
  create?: { requestId: string; result?: unknown };
  abandoned: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowlistedStage(value: unknown): string | undefined {
  return value === "config" ||
    value === "request" ||
    value === "transport" ||
    value === "identity" ||
    value === "cancel"
    ? value
    : undefined;
}

function isCreateOperation(method: string, params: Record<string, unknown>): boolean {
  return method === REALTIME_CALL_METHOD && params.operation === "create";
}

function cleanupUnconfirmedError(error: unknown): Error | undefined {
  if (
    error instanceof Error &&
    error.message === RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED &&
    allowlistedStage(Reflect.get(error, "stage")) === "cancel"
  )
    return error;
}

export function rendererVoiceHostCapabilitySource(owner: string, generation: number): string {
  const guard = rendererVoiceHostDocumentGuardExpression();
  return `(() => {
  if (!${guard}) return true;
  const binding = ${JSON.stringify(RENDERER_VOICE_HOST_BINDING_NAME)};
  const cap = ${JSON.stringify(RENDERER_VOICE_HOST_CAPABILITY_GLOBAL)};
  const deliver = ${JSON.stringify(RENDERER_VOICE_HOST_DELIVER_GLOBAL)};
  const pendingKey = ${JSON.stringify(RENDERER_VOICE_HOST_PENDING_GLOBAL)};
  const allowed = ${JSON.stringify([...RENDERER_VOICE_HOST_METHODS])};
  const maxBytes = ${RENDERER_VOICE_HOST_MAX_PAYLOAD_BYTES};
  const ownerId = ${JSON.stringify(owner)};
  const generation = ${generation};
  const settingsTimeout = ${RENDERER_VOICE_HOST_SETTINGS_TIMEOUT_MS};
  const gatewayTimeout = ${RENDERER_VOICE_HOST_GATEWAY_TIMEOUT_MS};
  const realtimeTimeout = ${RENDERER_VOICE_HOST_REALTIME_TIMEOUT_MS};
  const pending = globalThis[pendingKey] instanceof Map ? globalThis[pendingKey] : new Map();
  globalThis[pendingKey] = pending;
  const unavailable = () => Promise.reject(new Error(${JSON.stringify(UNAVAILABLE)}));
  const settleWait = (wait, message) => {
    try { clearTimeout(wait.timer); } catch (e) {}
    try { wait.reject(new Error(message)); } catch (e) {}
  };
  const settleAll = (message) => {
    for (const [id, wait] of [...pending.entries()]) {
      pending.delete(id);
      settleWait(wait, message);
    }
  };
  const previous = globalThis[cap];
  if (previous && previous.generation !== generation) settleAll(${JSON.stringify(UNAVAILABLE)});
  globalThis[deliver] = (message) => {
    if (!message || typeof message !== "object" || typeof message.id !== "string") return;
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id);
    try { clearTimeout(wait.timer); } catch (e) {}
    if (message.ok) {
      wait.resolve(message.result);
      return;
    }
    const error = new Error(
      typeof message.error === "string" && message.error.length > 0 && message.error.length <= 500
        ? message.error
        : "Host request failed",
    );
    if (typeof message.stage === "string") error.stage = message.stage;
    wait.reject(error);
  };
  Object.defineProperty(globalThis, cap, {
    configurable: true,
    value: Object.freeze({
      owner: ownerId,
      generation,
      request(method, params) {
        try {
          if (!${guard}) return unavailable();
          if (typeof method !== "string" || !allowed.includes(method)) return unavailable();
          const body = params !== null && typeof params === "object" && !Array.isArray(params) ? params : {};
          const id = crypto.randomUUID();
          const payload = JSON.stringify({ v: 1, id, owner: ownerId, generation, method, params: body });
          if (payload.length > maxBytes) return Promise.reject(new Error("Voice request is too large"));
          const timeoutMs =
            method === ${JSON.stringify(VOICE_GATEWAY_STATUS_METHOD)}
              ? gatewayTimeout
              : method === ${JSON.stringify(REALTIME_CALL_METHOD)}
                ? realtimeTimeout
                : settingsTimeout;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              try {
                globalThis[binding](JSON.stringify({
                  v: 1,
                  id,
                  owner: ownerId,
                  generation,
                  abandon: true,
                  method,
                  params: body,
                }));
              } catch (e) {}
              reject(new Error(${JSON.stringify(UNAVAILABLE)}));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer, generation });
            try {
              globalThis[binding](payload);
            } catch {
              pending.delete(id);
              try { clearTimeout(timer); } catch (e) {}
              reject(new Error(${JSON.stringify(UNAVAILABLE)}));
            }
          });
        } catch {
          return unavailable();
        }
      },
    }),
  });
  return true;
})()`;
}

function evaluateResultValue(response: unknown): unknown {
  if (!isRecord(response) || isRecord(response.exceptionDetails)) return;
  return isRecord(response.result) ? response.result.value : undefined;
}

function callIdFromCreateResult(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.headers)) return;
  const location = result.headers.location;
  if (typeof location !== "string") return;
  const callId = realtimeCallIdFromLocation(location);
  return isRealtimeCallId(callId) ? callId : undefined;
}

async function cleanupAbandonedCreate(
  execution: VoiceHostExecution,
  params: Record<string, unknown>,
  result: unknown,
): Promise<Error | undefined> {
  let unconfirmed: Error | undefined;
  const note = (error: unknown): void => {
    unconfirmed ??= cleanupUnconfirmedError(error);
  };
  const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
  if (requestId) {
    await execution.request(REALTIME_CALL_METHOD, { operation: "cancel", requestId }).catch(note);
  }
  const callId = callIdFromCreateResult(result);
  if (!callId) return unconfirmed;
  await execution.request(REALTIME_CALL_METHOD, { operation: "hangup", callId }).catch(note);
  return unconfirmed;
}

function captureExecution(host: RendererVoiceHostOwner): VoiceHostExecution {
  return (
    host.bindExecution?.() ?? {
      generation: host.generation,
      request: (method, params) => host.request(method, params),
    }
  );
}

async function readContextDocument(
  renderer: RendererVoiceHostCdpClient,
  executionContextId: number,
): Promise<{ href: string; top: boolean } | undefined> {
  try {
    const response = await renderer.command("Runtime.evaluate", {
      expression:
        "(function(){try{return {href:String(location.href),top:window.top===window};}catch(e){return {href:'',top:false};}})()",
      contextId: executionContextId,
      returnByValue: true,
    });
    const value = evaluateResultValue(response);
    if (!isRecord(value) || typeof value.href !== "string" || typeof value.top !== "boolean")
      return;
    return { href: value.href, top: value.top };
  } catch (error) {
    if (error instanceof Error && STALE_CONTEXT.test(error.message)) return;
    return;
  }
}

async function deliver(
  renderer: RendererVoiceHostCdpClient,
  executionContextId: number,
  message: Record<string, unknown>,
): Promise<void> {
  const encoded = JSON.stringify(message);
  const payload =
    encoded.length > RENDERER_VOICE_HOST_MAX_PAYLOAD_BYTES
      ? JSON.stringify({
          id: message.id,
          ok: false,
          error: "Host request failed",
        })
      : encoded;
  await renderer
    .command("Runtime.evaluate", {
      expression: `typeof globalThis[${JSON.stringify(RENDERER_VOICE_HOST_DELIVER_GLOBAL)}]==='function'&&globalThis[${JSON.stringify(RENDERER_VOICE_HOST_DELIVER_GLOBAL)}](${payload})`,
      contextId: executionContextId,
      returnByValue: true,
    })
    .catch(() => undefined);
}

async function registerFutureScript(
  renderer: RendererVoiceHostCdpClient,
  source: string,
  previousId: string | undefined,
): Promise<string | undefined> {
  if (previousId) {
    await renderer
      .command("Page.removeScriptToEvaluateOnNewDocument", { identifier: previousId })
      .catch(() => undefined);
  }
  const added = await renderer.command("Page.addScriptToEvaluateOnNewDocument", { source });
  return isRecord(added) && typeof added.identifier === "string" ? added.identifier : undefined;
}

async function removeFutureScript(
  renderer: RendererVoiceHostCdpClient,
  identifier: string | undefined,
): Promise<void> {
  if (!identifier) return;
  await renderer
    .command("Page.removeScriptToEvaluateOnNewDocument", { identifier })
    .catch(() => undefined);
}

/** Binds a generation-scoped Host voice capability into a verified app CDP target. */
export async function installRendererVoiceHostBinding(
  renderer: RendererVoiceHostCdpClient,
  host: RendererVoiceHostOwner,
  options?: { enableRuntime?: boolean },
): Promise<() => void> {
  let disposed = false;
  let scriptId: string | undefined;
  let publishing: Promise<void> = Promise.resolve();
  const inflight = new Set<Promise<unknown>>();
  const works = new Map<string, InflightWork>();
  const abandonedIds = new Set<string>();
  const contexts = new Map<number, TrackedContext>();

  const rememberContext = (params: unknown): void => {
    if (!isRecord(params) || !isRecord(params.context)) return;
    const context = params.context;
    if (typeof context.id !== "number" || typeof context.uniqueId !== "string") return;
    const aux = isRecord(context.auxData) ? context.auxData : undefined;
    contexts.set(context.id, {
      uniqueId: context.uniqueId,
      isDefault: aux?.isDefault === true,
    });
  };

  const observeCleanupUnconfirmed = async (
    contextId: number,
    pageId: string,
    unconfirmed: Error | undefined,
  ): Promise<void> => {
    if (!unconfirmed || disposed) return;
    await deliver(renderer, contextId, {
      id: pageId,
      ok: false,
      error: unconfirmed.message,
      stage: "cancel",
    });
  };

  const abandonWork = (item: InflightWork): void => {
    if (item.abandoned) return;
    item.abandoned = true;
    if (!item.create) return;
    void cleanupAbandonedCreate(
      item.execution,
      { requestId: item.create.requestId, operation: "create" },
      item.create.result,
    ).then((unconfirmed) => observeCleanupUnconfirmed(item.contextId, item.pageId, unconfirmed));
  };

  const abandonMatching = (contextId: number | undefined, uniqueId: string | undefined): void => {
    for (const item of works.values()) {
      if (
        (contextId !== undefined && item.contextId === contextId) ||
        (uniqueId !== undefined && item.uniqueId === uniqueId)
      )
        abandonWork(item);
    }
  };

  const forgetContext = (params: unknown): void => {
    if (!isRecord(params)) return;
    let contextId: number | undefined;
    let uniqueId: string | undefined;
    if (typeof params.executionContextId === "number") {
      contextId = params.executionContextId;
      uniqueId = contexts.get(contextId)?.uniqueId;
      contexts.delete(contextId);
    }
    if (typeof params.executionContextUniqueId === "string") {
      uniqueId = params.executionContextUniqueId;
      for (const [id, record] of contexts)
        if (record.uniqueId === uniqueId) {
          contextId = id;
          contexts.delete(id);
        }
    }
    abandonMatching(contextId, uniqueId);
  };

  const unsubscribeCreated = renderer.on("Runtime.executionContextCreated", rememberContext);
  const unsubscribeDestroyed = renderer.on("Runtime.executionContextDestroyed", forgetContext);
  const unsubscribeCleared = renderer.on("Runtime.executionContextsCleared", () => {
    contexts.clear();
    for (const item of works.values()) abandonWork(item);
  });

  const contextIsVerified = async (
    executionContextId: number,
    uniqueId: string,
  ): Promise<boolean> => {
    const tracked = contexts.get(executionContextId);
    if (!tracked?.isDefault || tracked.uniqueId !== uniqueId) return false;
    const document = await readContextDocument(renderer, executionContextId);
    const still = contexts.get(executionContextId);
    if (still?.uniqueId !== uniqueId || !still.isDefault) return false;
    if (!document?.top) return false;
    return isEligibleVoiceHostUrl(document.href);
  };

  const publishGeneration = async (): Promise<void> => {
    if (disposed) return;
    const startedGeneration = host.generation;
    const source = rendererVoiceHostCapabilitySource(host.owner, startedGeneration);
    const addedId = await registerFutureScript(renderer, source, scriptId);
    if (disposed || host.generation !== startedGeneration) {
      await removeFutureScript(renderer, addedId);
      return;
    }
    scriptId = addedId;
    await renderer.evaluate(source);
  };

  const enqueuePublish = (): void => {
    publishing = publishing
      .catch(() => undefined)
      .then(() => publishGeneration())
      .catch(() => undefined);
  };

  const cancelInflightCreates = (): void => {
    for (const item of works.values()) {
      if (!item.create || item.abandoned) continue;
      void item.execution
        .request(REALTIME_CALL_METHOD, { operation: "cancel", requestId: item.create.requestId })
        .catch((error) =>
          observeCleanupUnconfirmed(item.contextId, item.pageId, cleanupUnconfirmedError(error)),
        );
    }
  };

  if (options?.enableRuntime !== false) await renderer.command("Runtime.enable");
  await renderer.command("Page.enable");
  await renderer.command("Runtime.addBinding", { name: RENDERER_VOICE_HOST_BINDING_NAME });
  await publishGeneration();

  const refresh = (): void => {
    if (disposed) return;
    cancelInflightCreates();
    enqueuePublish();
  };
  const unsubscribeGeneration = host.onGenerationChange?.(refresh);
  const unsubscribe = renderer.on("Runtime.bindingCalled", (params) => {
    if (disposed || !isRecord(params) || params.name !== RENDERER_VOICE_HOST_BINDING_NAME) return;
    if (typeof params.executionContextId !== "number" || typeof params.payload !== "string") return;
    if (params.payload.length > RENDERER_VOICE_HOST_MAX_PAYLOAD_BYTES) return;
    const contextId = params.executionContextId;
    const payloadText = params.payload;
    const startedGeneration = host.generation;
    const work = (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch {
        return;
      }
      if (
        !isRecord(parsed) ||
        parsed.v !== 1 ||
        typeof parsed.id !== "string" ||
        parsed.id.length === 0 ||
        parsed.id.length > 128 ||
        parsed.owner !== host.owner
      )
        return;
      const requestId = parsed.id;
      if (parsed.abandon === true) {
        const existing = works.get(requestId);
        if (existing) abandonWork(existing);
        else abandonedIds.add(requestId);
        return;
      }
      if (
        parsed.generation !== startedGeneration ||
        parsed.generation !== host.generation ||
        typeof parsed.method !== "string" ||
        !isRecord(parsed.params)
      ) {
        await deliver(renderer, contextId, { id: requestId, ok: false, error: UNAVAILABLE });
        return;
      }
      const tracked = contexts.get(contextId);
      if (!tracked?.isDefault) {
        return;
      }
      const uniqueId = tracked.uniqueId;
      const execution = captureExecution(host);
      const item: InflightWork = {
        pageId: requestId,
        contextId,
        uniqueId,
        generation: startedGeneration,
        execution,
        abandoned: abandonedIds.has(requestId),
        ...(isCreateOperation(parsed.method, parsed.params) &&
        typeof parsed.params.requestId === "string"
          ? { create: { requestId: parsed.params.requestId } }
          : {}),
      };
      works.set(requestId, item);
      abandonedIds.delete(requestId);
      try {
        if (item.abandoned) {
          if (item.create)
            await observeCleanupUnconfirmed(
              contextId,
              requestId,
              await cleanupAbandonedCreate(
                item.execution,
                { requestId: item.create.requestId, operation: "create" },
                item.create.result,
              ),
            );
          return;
        }
        const method = parsed.method;
        const requestParams = parsed.params;
        const verified = await contextIsVerified(contextId, uniqueId);
        const still = contexts.get(contextId);
        if (
          disposed ||
          item.abandoned ||
          host.generation !== startedGeneration ||
          still?.uniqueId !== uniqueId
        ) {
          if (item.create)
            await observeCleanupUnconfirmed(
              contextId,
              requestId,
              await cleanupAbandonedCreate(item.execution, requestParams, item.create.result),
            );
          return;
        }
        if (!verified) {
          if (still?.isDefault)
            await deliver(renderer, contextId, { id: requestId, ok: false, error: UNAVAILABLE });
          return;
        }
        if (!ALLOWED_METHODS.has(method)) {
          await deliver(renderer, contextId, { id: requestId, ok: false, error: UNAVAILABLE });
          return;
        }
        try {
          const result = await item.execution.request(method, requestParams);
          if (item.create) item.create.result = result;
          const after = contexts.get(contextId);
          if (
            disposed ||
            item.abandoned ||
            host.generation !== startedGeneration ||
            after?.uniqueId !== uniqueId
          ) {
            if (item.create)
              await observeCleanupUnconfirmed(
                contextId,
                requestId,
                await cleanupAbandonedCreate(item.execution, requestParams, result),
              );
            return;
          }
          await deliver(renderer, contextId, { id: requestId, ok: true, result });
        } catch (error) {
          const unconfirmed = cleanupUnconfirmedError(error);
          if (unconfirmed && !disposed) {
            await deliver(renderer, contextId, {
              id: requestId,
              ok: false,
              error: unconfirmed.message,
              stage: "cancel",
            });
            return;
          }
          if (disposed || item.abandoned || host.generation !== startedGeneration) return;
          const stage =
            error instanceof Error ? allowlistedStage(Reflect.get(error, "stage")) : undefined;
          await deliver(renderer, contextId, {
            id: requestId,
            ok: false,
            error:
              error instanceof Error &&
              error.message.length > 0 &&
              error.message.length <= 500 &&
              !/bearer|token|authorization|sdp/i.test(error.message)
                ? error.message
                : "Host request failed",
            ...(stage ? { stage } : {}),
          });
        }
      } finally {
        works.delete(requestId);
      }
    })();
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribeGeneration?.();
    unsubscribe();
    unsubscribeCreated();
    unsubscribeDestroyed();
    unsubscribeCleared();
    cancelInflightCreates();
    const outstanding = [...inflight];
    const leftover = [...works.values()];
    void Promise.allSettled(outstanding).then(async () => {
      for (const item of leftover)
        if (item.create)
          await observeCleanupUnconfirmed(
            item.contextId,
            item.pageId,
            await cleanupAbandonedCreate(
              item.execution,
              { requestId: item.create.requestId, operation: "create" },
              item.create.result,
            ),
          );
    });
    void removeFutureScript(renderer, scriptId);
    void renderer
      .command("Runtime.removeBinding", { name: RENDERER_VOICE_HOST_BINDING_NAME })
      .catch(() => undefined);
    void renderer
      .evaluate(
        `(() => {
  const pending = globalThis[${JSON.stringify(RENDERER_VOICE_HOST_PENDING_GLOBAL)}];
  if (pending && typeof pending.forEach === "function") {
    for (const [id, wait] of [...pending.entries()]) {
      pending.delete(id);
      try { clearTimeout(wait.timer); } catch (e) {}
      try { wait.reject(new Error(${JSON.stringify(UNKNOWN_OUTCOME)})); } catch (e) {}
    }
  }
  delete globalThis[${JSON.stringify(RENDERER_VOICE_HOST_CAPABILITY_GLOBAL)}];
  delete globalThis[${JSON.stringify(RENDERER_VOICE_HOST_DELIVER_GLOBAL)}];
  delete globalThis[${JSON.stringify(RENDERER_VOICE_HOST_PENDING_GLOBAL)}];
  return true;
})()`,
      )
      .catch(() => undefined);
  };
}
