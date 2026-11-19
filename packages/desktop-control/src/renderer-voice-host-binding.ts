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
// A rejected future-document registration keeps the previous script; retrying
// replaces it once the Renderer accepts a new script, without a Host mutation.
export const RENDERER_VOICE_HOST_PUBLISH_RETRY_MS = 1_000;

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

interface CreateWork {
  requestId: string;
  result?: unknown;
  /** The original Host create request has settled; no prompt cancel is needed. */
  settled: boolean;
  cancelIssued: boolean;
  hangupIssued: boolean;
  cleanupReported: boolean;
}

interface InflightWork {
  pageId: string;
  contextId: number;
  uniqueId: string;
  generation: number;
  execution: VoiceHostExecution;
  create?: CreateWork;
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

/** `instanceId` scopes page state to one binding installation so a late disposal
 * cannot delete or settle a capability published by a replacement installation.
 * `installationOrder` orders installations of one page, so a publish that outlives
 * its installation cannot replace a newer installation's capability. */
export function rendererVoiceHostCapabilitySource(
  owner: string,
  generation: number,
  instanceId: string = "",
  installationOrder: number = 0,
  publisherId: string = "",
): string {
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
  const instance = ${JSON.stringify(instanceId)};
  const order = ${installationOrder};
  const publisher = ${JSON.stringify(publisherId)};
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
  // A publish that outlived its installation must leave a newer installation's state intact.
  if (previous && previous.publisher === publisher && typeof previous.order === "number" && previous.order > order) return true;
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
      instance,
      order,
      publisher,
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
            pending.set(id, { resolve, reject, timer, generation, instance });
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

/** Registers a future-document script without disturbing the previous one. The
 * caller removes the previous script only after the new identifier is accepted,
 * so a rejected registration leaves the existing document script in place. */
async function addFutureScript(
  renderer: RendererVoiceHostCdpClient,
  source: string,
): Promise<string> {
  const added = await renderer.command("Page.addScriptToEvaluateOnNewDocument", { source });
  if (!isRecord(added) || typeof added.identifier !== "string")
    throw new Error("Voice Host future script registration failed");
  return added.identifier;
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

/** Removes one installation's page state without touching a replacement
 * installation's capability, waiters, or delivery hook. */
function rendererVoiceHostCleanupSource(instanceId: string): string {
  return `(() => {
  const instance = ${JSON.stringify(instanceId)};
  const pending = globalThis[${JSON.stringify(RENDERER_VOICE_HOST_PENDING_GLOBAL)}];
  if (pending && typeof pending.forEach === "function") {
    for (const [id, wait] of [...pending.entries()]) {
      if (!wait || wait.instance !== instance) continue;
      pending.delete(id);
      try { clearTimeout(wait.timer); } catch (e) {}
      try { wait.reject(new Error(${JSON.stringify(UNKNOWN_OUTCOME)})); } catch (e) {}
    }
  }
  const capability = globalThis[${JSON.stringify(RENDERER_VOICE_HOST_CAPABILITY_GLOBAL)}];
  if (capability && capability.instance === instance) {
    delete globalThis[${JSON.stringify(RENDERER_VOICE_HOST_CAPABILITY_GLOBAL)}];
    delete globalThis[${JSON.stringify(RENDERER_VOICE_HOST_DELIVER_GLOBAL)}];
    if (globalThis[${JSON.stringify(RENDERER_VOICE_HOST_PENDING_GLOBAL)}] === pending)
      delete globalThis[${JSON.stringify(RENDERER_VOICE_HOST_PENDING_GLOBAL)}];
  }
  return true;
})()`;
}

const publisherId = crypto.randomUUID();
let installationSequence = 0;

/** Binds a generation-scoped Host voice capability into a verified app CDP target. */
export async function installRendererVoiceHostBinding(
  renderer: RendererVoiceHostCdpClient,
  host: RendererVoiceHostOwner,
  options?: { enableRuntime?: boolean },
): Promise<() => void> {
  const instance = crypto.randomUUID();
  const installationOrder = (installationSequence += 1);
  let disposed = false;
  let ready = false;
  let scriptId: string | undefined;
  let publishedGeneration: number | undefined;
  let publishing: Promise<void> = Promise.resolve();
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

  const reportCleanupUnconfirmed = (item: InflightWork, error: unknown): void => {
    const create = item.create;
    const unconfirmed = cleanupUnconfirmedError(error);
    if (!create || !unconfirmed || create.cleanupReported) return;
    create.cleanupReported = true;
    void observeCleanupUnconfirmed(item.contextId, item.pageId, unconfirmed);
  };

  const requestCleanup = (item: InflightWork, params: Record<string, unknown>): void => {
    try {
      void item.execution
        .request(REALTIME_CALL_METHOD, params)
        .catch((error: unknown) => reportCleanupUnconfirmed(item, error));
    } catch (error) {
      reportCleanupUnconfirmed(item, error);
    }
  };

  const hangUpLateCreate = (item: InflightWork): void => {
    const create = item.create;
    if (!create || create.hangupIssued) return;
    const callId = callIdFromCreateResult(create.result);
    if (!callId) return;
    create.hangupIssued = true;
    requestCleanup(item, { operation: "hangup", callId });
  };

  /** Retires one work exactly once. A create that is still pending is cancelled
   * promptly through the execution captured for the original Host request; a
   * create that resolves afterwards is hung up at most once. */
  const retireWork = (item: InflightWork): void => {
    item.abandoned = true;
    const create = item.create;
    if (!create) return;
    if (create.settled) {
      hangUpLateCreate(item);
      return;
    }
    if (create.cancelIssued) return;
    create.cancelIssued = true;
    requestCleanup(item, { operation: "cancel", requestId: create.requestId });
  };

  const retireInflight = (): void => {
    for (const item of works.values()) retireWork(item);
  };

  const abandonMatching = (contextId: number | undefined, uniqueId: string | undefined): void => {
    for (const item of works.values()) {
      if (
        (contextId !== undefined && item.contextId === contextId) ||
        (uniqueId !== undefined && item.uniqueId === uniqueId)
      )
        retireWork(item);
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
    for (const item of works.values()) retireWork(item);
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

  let publishRetry: ReturnType<typeof setTimeout> | undefined;
  const clearPublishRetry = (): void => {
    if (publishRetry === undefined) return;
    clearTimeout(publishRetry);
    publishRetry = undefined;
  };
  const schedulePublishRetry = (): void => {
    if (disposed || publishRetry !== undefined) return;
    publishRetry = setTimeout(() => {
      publishRetry = undefined;
      if (disposed) return;
      void enqueuePublish().catch(() => schedulePublishRetry());
    }, RENDERER_VOICE_HOST_PUBLISH_RETRY_MS);
  };

  /** Removes only this installation's page state, so a replacement installation
   * keeps its capability and waiters across a late cleanup. */
  const cleanupPageState = async (): Promise<void> => {
    try {
      await renderer.evaluate(rendererVoiceHostCleanupSource(instance));
    } catch {
      // Page cleanup is best effort; disposal and publishing must not throw.
    }
  };

  /** Publishes the Host's current generation. A generation that changes while the
   * future-document script is registered is retried here, so the newest generation
   * is published even when the change lands before `onGenerationChange` runs. */
  const publishGeneration = async (): Promise<void> => {
    for (let attempt = 0; !disposed && attempt < 3; attempt += 1) {
      const startedGeneration = host.generation;
      if (startedGeneration === publishedGeneration) return;
      const source = rendererVoiceHostCapabilitySource(
        host.owner,
        startedGeneration,
        instance,
        installationOrder,
        publisherId,
      );
      const addedId = await addFutureScript(renderer, source);
      if (disposed || host.generation !== startedGeneration) {
        await removeFutureScript(renderer, addedId);
        continue;
      }
      // The previous script stays registered until the replacement is accepted,
      // so a failed registration leaves future documents on the previous one.
      const previousId = scriptId;
      scriptId = addedId;
      await removeFutureScript(renderer, previousId);
      // A disposal during the removal must not publish into the current document.
      if (disposed) return;
      await renderer.evaluate(source);
      if (disposed) {
        // A current-document publish that outlived disposal cleanup must not leave
        // this installation's page globals behind.
        await cleanupPageState();
        return;
      }
      publishedGeneration = startedGeneration;
      // A Host without `onGenerationChange` would otherwise keep the stale capability.
      if (host.generation === startedGeneration) return;
    }
  };

  const enqueuePublish = (): Promise<void> => {
    const next = publishing
      .catch(() => undefined)
      .then(async () => {
        await publishGeneration();
        // A publish that kept losing the generation race leaves the newest
        // generation unpublished; retry instead of pinning the stale capability.
        if (!disposed && host.generation !== publishedGeneration) schedulePublishRetry();
        else clearPublishRetry();
      });
    publishing = next.catch(() => undefined);
    return next;
  };

  const refresh = (): void => {
    if (disposed) return;
    retireInflight();
    // Before setup finishes the initial publish reads the newest generation itself.
    if (!ready) return;
    // A rejected registration leaves the previous script and generation in place;
    // retry so a transient failure does not pin the binding to a stale generation.
    void enqueuePublish().catch(() => schedulePublishRetry());
  };
  let unsubscribeGeneration: (() => void) | undefined;
  const unsubscribe = renderer.on("Runtime.bindingCalled", (params) => {
    if (disposed || !isRecord(params) || params.name !== RENDERER_VOICE_HOST_BINDING_NAME) return;
    if (typeof params.executionContextId !== "number" || typeof params.payload !== "string") return;
    if (params.payload.length > RENDERER_VOICE_HOST_MAX_PAYLOAD_BYTES) return;
    const contextId = params.executionContextId;
    const payloadText = params.payload;
    const startedGeneration = host.generation;
    void (async () => {
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
        if (existing) retireWork(existing);
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
          ? {
              create: {
                requestId: parsed.params.requestId,
                settled: false,
                cancelIssued: false,
                hangupIssued: false,
                cleanupReported: false,
              },
            }
          : {}),
      };
      works.set(requestId, item);
      abandonedIds.delete(requestId);
      try {
        if (item.abandoned) {
          retireWork(item);
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
          retireWork(item);
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
          if (item.create) {
            item.create.result = result;
            item.create.settled = true;
          }
          const after = contexts.get(contextId);
          if (
            disposed ||
            item.abandoned ||
            host.generation !== startedGeneration ||
            after?.uniqueId !== uniqueId
          ) {
            retireWork(item);
            return;
          }
          await deliver(renderer, contextId, { id: requestId, ok: true, result });
        } catch (error) {
          if (item.create) item.create.settled = true;
          const unconfirmed = cleanupUnconfirmedError(error);
          if (unconfirmed && !disposed) {
            if (item.create) item.create.cleanupReported = true;
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
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearPublishRetry();
    unsubscribeGeneration?.();
    unsubscribe();
    unsubscribeCreated();
    unsubscribeDestroyed();
    unsubscribeCleared();
    retireInflight();
    void removeFutureScript(renderer, scriptId);
    void renderer
      .command("Runtime.removeBinding", { name: RENDERER_VOICE_HOST_BINDING_NAME })
      .catch(() => undefined);
    void cleanupPageState();
  };

  try {
    unsubscribeGeneration = host.onGenerationChange?.(refresh);
    if (options?.enableRuntime !== false) await renderer.command("Runtime.enable");
    await renderer.command("Page.enable");
    await renderer.command("Runtime.addBinding", { name: RENDERER_VOICE_HOST_BINDING_NAME });
    ready = true;
    await enqueuePublish();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
