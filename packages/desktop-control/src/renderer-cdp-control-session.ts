import { createHash } from "node:crypto";

import {
  CdpClient,
  CdpConnectionClosedError,
  listCdpTargets,
  type CdpClientOptions,
  type CdpFetch,
  type CdpTarget,
  cdpExceptionMessage,
} from "./cdp-client.js";
import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "./cpa-live-voice-hook.js";
import { BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE } from "./browser-annotation-style-compat.js";
import {
  installRendererDraftPrewarmPolicyDirect,
  type RendererDraftPrewarmPolicyStatus,
} from "./renderer-draft-prewarm-policy.js";

import {
  installRendererLoadedModules,
  type RendererModuleCdpClient,
} from "./renderer-loaded-modules.js";
import { installNativeRpcRemoteControlDirect } from "./renderer-native-rpc-install.js";
import { installRendererRpcSteeringDirect } from "./renderer-rpc-steering.js";
import {
  installRendererVoiceHostBinding,
  type RendererVoiceHostOwner,
} from "./renderer-voice-host-binding.js";
import {
  isAvatarOverlayRendererUrl,
  isPrimaryRendererUrl,
  parseCodexAppUrl,
} from "./renderer-app-url.js";

export interface ProductionRendererStatus {
  version: 2;
  enabledAgents: string[];
  adapter: {
    state: "ready";
    reason: string;
  };
}

export interface RendererCdpControlSnapshot {
  target: CdpTarget;
  draftPrewarmPolicy: RendererDraftPrewarmPolicyStatus;
  binding: ProductionRendererStatus;
}

interface RendererCdpClient extends RendererModuleCdpClient {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  close(): void;
}

interface RendererCdpControlOperations {
  listTargets(endpoint: string, signal?: AbortSignal): Promise<CdpTarget[]>;
  connect(webSocketDebuggerUrl: string): Promise<RendererCdpClient>;
  installDraftPrewarmPolicy(renderer: RendererCdpClient): Promise<RendererDraftPrewarmPolicyStatus>;
}

export interface RendererCdpControlSession {
  readonly snapshot: RendererCdpControlSnapshot;
  ensureInstalled(): Promise<RendererCdpControlSnapshot>;
  /** Binds a Host voice owner that appeared after installation. Installed
   * Renderer hooks and the session's own connections are left untouched. */
  attachVoiceHost(voiceHost: RendererVoiceHostOwner): Promise<void>;
  activateDesktop(): Promise<number>;
  executeRenderer<T>(expression: string, timeoutMs?: number): Promise<T>;
  close(): void;
}

export interface InstallRendererCdpControlOptions {
  rendererCdpEndpoint: string;
  rendererSource: string;
  overlayHookSource?: string;
  /** Small overlay voice wrap. When set, current-document evaluate and
   * new-document registration use this instead of the full overlay hook IIFE. */
  overlayVoiceBootstrapSource?: string;
  enabledAgents?: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  voiceHost?: RendererVoiceHostOwner;
}

interface CreateRendererCdpControlOptions extends InstallRendererCdpControlOptions {
  operations?: RendererCdpControlOperations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function discoveryTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function abortFailure(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

/** Checked immediately before a client is committed to a session-owned map, so a
 * connection that finished opening after the session closed is never retained. */
function throwIfCdpAborted(signal: AbortSignal, fallback: string): void {
  if (signal.aborted) throw abortFailure(signal, fallback);
}

function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortFailure(signal, timeoutMessage));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortFailure(signal, timeoutMessage));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function runWithCdpSignal<T>(
  signal: AbortSignal,
  timeoutMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  return awaitWithSignal(operation(), signal, timeoutMessage);
}

async function connectRendererTarget(
  target: CdpTarget,
  operations: RendererCdpControlOperations,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<RendererCdpClient> {
  return runWithCdpSignal(signal, timeoutMessage, async () => {
    const connected = await operations.connect(target.webSocketDebuggerUrl);
    if (signal.aborted) {
      connected.close();
      signal.throwIfAborted();
    }
    return connected;
  });
}

function sameAgents(actual: readonly string[], expected: readonly string[] | undefined): boolean {
  // Production discovers plugins after mounting. Explicit tooling expectations stay exact.
  if (!actual.includes("codex") || new Set(actual).size !== actual.length) return false;
  if (!expected) return true;
  const expectedSet = new Set(expected);
  return actual.length === expected.length && actual.every((agent) => expectedSet.has(agent));
}

export function selectPrimaryRendererTarget(
  targets: readonly CdpTarget[],
  preferredTargetId?: string,
): CdpTarget | null {
  const candidates = targets.filter(
    (target) => target.type === "page" && isPrimaryRendererUrl(target.url),
  );
  return candidates.find((target) => target.id === preferredTargetId) ?? candidates.at(0) ?? null;
}

export function selectAvatarOverlayRendererTargets(targets: readonly CdpTarget[]): CdpTarget[] {
  return targets.filter((item) => item.type === "page" && isAvatarOverlayRendererUrl(item.url));
}

class RendererAdapterReadinessError extends Error {
  constructor(
    readonly state: string,
    readonly reason: string,
  ) {
    super(`Production Renderer Adapter is ${state}: ${reason}`);
    this.name = "RendererAdapterReadinessError";
  }
}

function validateBindingStatus(
  value: unknown,
  expectedAgents: readonly string[] | undefined,
): ProductionRendererStatus {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.enabledAgents) ||
    value.enabledAgents.some((agent) => typeof agent !== "string") ||
    !sameAgents(value.enabledAgents as string[], expectedAgents) ||
    !isRecord(value.adapter)
  ) {
    throw new Error("Production Renderer binding returned an invalid status");
  }
  if (value.adapter.state !== "ready" || typeof value.adapter.reason !== "string") {
    const state = typeof value.adapter.state === "string" ? value.adapter.state : "invalid";
    const reason = typeof value.adapter.reason === "string" ? value.adapter.reason : "unknown";
    throw new RendererAdapterReadinessError(state, reason);
  }
  return value as unknown as ProductionRendererStatus;
}

async function waitForPrimaryTarget(
  endpoint: string,
  operations: RendererCdpControlOperations,
  timeoutMs: number,
  pollIntervalMs: number,
  preferredTargetId?: string,
  signal?: AbortSignal,
): Promise<CdpTarget> {
  const discovery = discoveryTimeoutSignal(timeoutMs, signal);
  let lastError: unknown;
  while (!discovery.aborted) {
    try {
      const target = selectPrimaryRendererTarget(
        await awaitWithSignal(
          operations.listTargets(endpoint, discovery),
          discovery,
          "Renderer CDP target discovery timed out",
        ),
        preferredTargetId,
      );
      if (target) return target;
      lastError = new Error("Renderer CDP has no primary app://-/index.html page target");
    } catch (error) {
      lastError = error;
      if (discovery.aborted) break;
    }
    if (discovery.aborted) break;
    try {
      await awaitWithSignal(
        sleep(pollIntervalMs),
        discovery,
        "Renderer CDP target discovery timed out",
      );
    } catch (error) {
      lastError = error;
      break;
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Primary Codex Renderer CDP target did not become ready${detail}`);
}

type VoiceHostDisposals = Map<RendererCdpClient, () => void>;

async function bindRendererVoiceHost(
  renderer: RendererCdpClient,
  voiceHost: RendererVoiceHostOwner | undefined,
  disposals: VoiceHostDisposals,
  options?: { enableRuntime?: boolean },
): Promise<void> {
  if (!voiceHost) return;
  disposals.get(renderer)?.();
  disposals.set(renderer, await installRendererVoiceHostBinding(renderer, voiceHost, options));
}

function unbindRendererVoiceHost(renderer: RendererCdpClient, disposals: VoiceHostDisposals): void {
  disposals.get(renderer)?.();
  disposals.delete(renderer);
}

interface LateVoiceHostBinding {
  readonly targetId: string;
  readonly client: RendererCdpClient;
  /** Last time this connection answered a liveness probe. */
  verifiedAt: number;
  dispose(): void;
}

// Late attachment runs inside the Controller's serialized session work.
const VOICE_HOST_ATTACH_TIMEOUT_MS = 15_000;
const VOICE_HOST_OVERLAY_RETRY_MS = 5_000;
// A target ID outlives its CDP connection, so target inventory cannot prove a
// binding still delivers. One bounded round trip per interval retires a dead or
// stalled connection without probing the Renderer on every monitor pass.
const VOICE_HOST_LIVENESS_INTERVAL_MS = 5_000;
// Long enough for a Renderer that is briefly busy with an active call, short
// enough to stay below the probe interval so probes never overlap.
export const VOICE_HOST_LIVENESS_TIMEOUT_MS = 3_000;

/** Late attachment must not depend on whether re-enabling Runtime on the
 * installed connection replays `Runtime.executionContextCreated`: that replay
 * differs across Chromium builds. A fresh connection reports the live contexts
 * when Runtime is enabled, and leaves the installed session's listeners and
 * injections untouched. */
async function bindVoiceHostOnNewConnection(
  target: CdpTarget,
  voiceHost: RendererVoiceHostOwner,
  operations: RendererCdpControlOperations,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LateVoiceHostBinding> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const timeoutMessage = "Voice Host attachment timed out";
  const client = await connectRendererTarget(target, operations, deadline, timeoutMessage);
  const installing = installRendererVoiceHostBinding(client, voiceHost);
  try {
    const dispose = await awaitWithSignal(installing, deadline, timeoutMessage);
    return { targetId: target.id, client, dispose, verifiedAt: Date.now() };
  } catch (error) {
    // Closing the connection clears the binding's listeners and stops a publish that
    // is still in flight. A capability this attempt already published is left for the
    // next successful attach to replace: disposing here would settle page requests
    // that this attempt may still be serving.
    client.close();
    throw error;
  }
}

/** A closed socket rejects at once. A connection that stays silent past the
 * probe bound is retired instead of keeping the target's only binding slot, so a
 * later pass re-attaches on a fresh connection and never replays a page request
 * whose delivery was uncertain. The bound is also handed to the client, which
 * drops the unanswered command instead of queueing behind it; the external
 * deadline still bounds a client that ignores it and stops the probe as soon as
 * the session closes. A Renderer that is only briefly busy answers in time, so
 * its active call is not cancelled by a spurious retirement. */
async function lateVoiceBindingIsLive(
  binding: LateVoiceHostBinding,
  signal: AbortSignal,
): Promise<boolean> {
  if (Date.now() - binding.verifiedAt < VOICE_HOST_LIVENESS_INTERVAL_MS) return true;
  if (signal.aborted) return false;
  const deadline = AbortSignal.any([AbortSignal.timeout(VOICE_HOST_LIVENESS_TIMEOUT_MS), signal]);
  try {
    await awaitWithSignal(
      binding.client.evaluate<unknown>("1", VOICE_HOST_LIVENESS_TIMEOUT_MS),
      deadline,
      "Voice Host binding liveness check timed out",
    );
    binding.verifiedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

async function evaluateSource(renderer: RendererCdpClient, source: string): Promise<void> {
  const response = await renderer.command("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
  });
  if (!isRecord(response)) throw new Error("Renderer source evaluation returned an invalid result");
  if (isRecord(response.exceptionDetails)) {
    throw new Error(
      cdpExceptionMessage(response.exceptionDetails, "Renderer source evaluation failed"),
    );
  }
}

async function readBinding(renderer: RendererCdpClient): Promise<unknown> {
  return renderer.evaluate<unknown>("window.__codexhostRendererBindingProbeV1?.status() ?? null");
}

async function waitForBinding(
  renderer: RendererCdpClient,
  enabledAgents: readonly string[] | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<ProductionRendererStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const reading = readBinding(renderer);
      const value = await (signal
        ? awaitWithSignal(reading, signal, "Renderer binding readiness timed out")
        : reading);
      signal?.throwIfAborted();
      if (value !== null) return validateBindingStatus(value, enabledAgents);
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      if (error instanceof CdpConnectionClosedError) throw error;
      if (error instanceof RendererAdapterReadinessError && error.state !== "installing") {
        throw error;
      }
    }
    const pause = sleep(pollIntervalMs);
    await (signal ? awaitWithSignal(pause, signal, "Renderer binding readiness timed out") : pause);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Production Renderer binding did not become ready${detail}`);
}

type OverlayHookSnapshot = {
  enabled: boolean;
  revision: string | null;
  isolatedPath: string | null;
  isolatedPaths: string[] | null;
  isolatedRun: string | null;
  isolatedExpiresAt: string | null;
  isolatedPlatform: string | null;
  appPath: string | null;
  call: "idle" | "active" | "unknown";
};

type OverlayInstallState = {
  futureDigest: string;
  currentDigest?: string;
  scriptId?: string;
};

const overlayInstallState = new WeakMap<RendererCdpClient, OverlayInstallState>();

const OVERLAY_HOOK_SNAPSHOT_EXPRESSION = `(() => { /*__codexhostOverlayHookSnapshot*/
  const cpa = globalThis.${CPA_LIVE_VOICE_HOOK_GLOBAL};
  const native = globalThis.__codexhostNativeChatVoiceV1;
  const labels =
    typeof document !== "undefined" && document.querySelectorAll
      ? [...document.querySelectorAll("button")].map((button) =>
          (button.getAttribute("aria-label") || "").toLowerCase(),
        )
      : [];
  let call = "unknown";
  if (native && native.activeCall === true) call = "active";
  else if (labels.some((label) => label === "end voice" || label === "end voice chat"))
    call = "active";
  else if (native && native.activeCall === false) call = "idle";
  else if (labels.some((label) => label.includes("start voice"))) call = "idle";
  const isolated =
    cpa && typeof cpa === "object" && "isolatedQualification" in cpa
      ? cpa.isolatedQualification
      : undefined;
  return {
    enabled: Boolean(cpa && typeof cpa === "object" && cpa.enabled === true),
    revision: typeof cpa?.implementationRevision === "string" ? cpa.implementationRevision : null,
    isolatedPath:
      isolated && typeof isolated === "object" && typeof isolated.path === "string"
        ? isolated.path
        : null,
    isolatedPaths: (() => {
      if (!isolated || typeof isolated !== "object") return null;
      const listed = Array.isArray(isolated.paths)
        ? isolated.paths
        : typeof isolated.path === "string"
          ? [isolated.path]
          : [];
      const unique = ["chat", "work-codex", "work-grok"].filter((path) => listed.includes(path));
      return unique.length ? unique : null;
    })(),
    isolatedRun:
      isolated && typeof isolated === "object" && typeof isolated.run === "string"
        ? isolated.run
        : null,
    isolatedExpiresAt:
      isolated && typeof isolated === "object" && typeof isolated.expiresAt === "string"
        ? isolated.expiresAt
        : null,
    isolatedPlatform:
      isolated && typeof isolated === "object" && typeof isolated.desktopPlatform === "string"
        ? isolated.desktopPlatform
        : null,
    appPath: typeof cpa?.desktopAppPath === "string" ? cpa.desktopAppPath : null,
    call,
  };
})()`;

function overlaySourceDigest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function emptyOverlaySnapshot(
  enabled: boolean,
  call: OverlayHookSnapshot["call"] = "unknown",
): OverlayHookSnapshot {
  return {
    enabled,
    revision: null,
    isolatedPath: null,
    isolatedPaths: null,
    isolatedRun: null,
    isolatedExpiresAt: null,
    isolatedPlatform: null,
    appPath: null,
    call,
  };
}

function overlayIdentityFromSource(source: string): OverlayHookSnapshot | undefined {
  const needle = `globalThis.${CPA_LIVE_VOICE_HOOK_GLOBAL} = Object.freeze(`;
  const start = source.indexOf(needle);
  if (start < 0) return;
  const json = source.slice(start + needle.length);
  const end = json.indexOf(");");
  if (end < 0) return;
  try {
    const parsed: unknown = JSON.parse(json.slice(0, end));
    if (!isRecord(parsed)) return;
    const isolated = parsed.isolatedQualification;
    return {
      enabled: parsed.enabled === true,
      revision:
        typeof parsed.implementationRevision === "string" ? parsed.implementationRevision : null,
      isolatedPath: isRecord(isolated) && typeof isolated.path === "string" ? isolated.path : null,
      isolatedPaths: (() => {
        if (!isRecord(isolated)) return null;
        const listed = Array.isArray(isolated.paths)
          ? isolated.paths
          : typeof isolated.path === "string"
            ? [isolated.path]
            : [];
        const unique = ["chat", "work-codex", "work-grok"].filter((path) => listed.includes(path));
        return unique.length ? unique : null;
      })(),
      isolatedRun: isRecord(isolated) && typeof isolated.run === "string" ? isolated.run : null,
      isolatedExpiresAt:
        isRecord(isolated) && typeof isolated.expiresAt === "string" ? isolated.expiresAt : null,
      isolatedPlatform:
        isRecord(isolated) && typeof isolated.desktopPlatform === "string"
          ? isolated.desktopPlatform
          : null,
      appPath: typeof parsed.desktopAppPath === "string" ? parsed.desktopAppPath : null,
      call: "idle",
    };
  } catch {
    return;
  }
}

function overlayIsolatedPaths(snapshot: OverlayHookSnapshot): string[] | null {
  if (snapshot.isolatedPaths && snapshot.isolatedPaths.length > 0) return snapshot.isolatedPaths;
  return snapshot.isolatedPath ? [snapshot.isolatedPath] : null;
}

function overlayIdentitiesMatch(live: OverlayHookSnapshot, desired: OverlayHookSnapshot): boolean {
  return (
    live.enabled === true &&
    live.revision === desired.revision &&
    live.isolatedPath === desired.isolatedPath &&
    JSON.stringify(overlayIsolatedPaths(live)) === JSON.stringify(overlayIsolatedPaths(desired)) &&
    live.isolatedRun === desired.isolatedRun &&
    live.isolatedExpiresAt === desired.isolatedExpiresAt &&
    live.isolatedPlatform === desired.isolatedPlatform &&
    live.appPath === desired.appPath
  );
}

function readOverlayHookSnapshot(value: unknown): OverlayHookSnapshot | undefined {
  if (value === true) return emptyOverlaySnapshot(true);
  if (value === false || value == null) return emptyOverlaySnapshot(false);
  if (!isRecord(value) || typeof value.enabled !== "boolean") return;
  const call = value.call === "active" || value.call === "idle" ? value.call : "unknown";
  return {
    enabled: value.enabled,
    revision: typeof value.revision === "string" ? value.revision : null,
    isolatedPath: typeof value.isolatedPath === "string" ? value.isolatedPath : null,
    isolatedPaths: Array.isArray(value.isolatedPaths)
      ? value.isolatedPaths.filter((path): path is string => typeof path === "string")
      : typeof value.isolatedPath === "string"
        ? [value.isolatedPath]
        : null,
    isolatedRun: typeof value.isolatedRun === "string" ? value.isolatedRun : null,
    isolatedExpiresAt: typeof value.isolatedExpiresAt === "string" ? value.isolatedExpiresAt : null,
    isolatedPlatform: typeof value.isolatedPlatform === "string" ? value.isolatedPlatform : null,
    appPath: typeof value.appPath === "string" ? value.appPath : null,
    call,
  };
}

async function installOverlayHook(
  target: CdpTarget,
  overlayHookSource: string,
  overlayClients: Map<string, RendererCdpClient>,
  operations: RendererCdpControlOperations,
  signal: AbortSignal,
  overlayVoiceBootstrapSource?: string,
  voiceHost?: RendererVoiceHostOwner,
  voiceHostDisposals?: VoiceHostDisposals,
): Promise<void> {
  const timeoutMessage = "Overlay hook installation timed out";
  const currentDocumentSource = overlayVoiceBootstrapSource ?? overlayHookSource;
  const desiredDigest = overlaySourceDigest(currentDocumentSource);
  const desiredIdentity = overlayIdentityFromSource(currentDocumentSource);
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    runWithCdpSignal(signal, timeoutMessage, operation);
  let renderer = overlayClients.get(target.id);
  const registered = renderer !== undefined;
  renderer ??= await connectRendererTarget(target, operations, signal, timeoutMessage);
  const connected = renderer;
  try {
    if (!registered) {
      if (voiceHost && voiceHostDisposals && !voiceHostDisposals.has(connected))
        await run(() =>
          bindRendererVoiceHost(connected, voiceHost, voiceHostDisposals, { enableRuntime: false }),
        );
      await run(() => connected.command("Runtime.enable"));
      await run(() => connected.command("Page.enable"));
      throwIfCdpAborted(signal, timeoutMessage);
      overlayClients.set(target.id, connected);
    } else if (voiceHost && voiceHostDisposals && !voiceHostDisposals.has(connected)) {
      await run(() =>
        bindRendererVoiceHost(connected, voiceHost, voiceHostDisposals, { enableRuntime: false }),
      );
    }
    let inspected = true;
    const snapshot = readOverlayHookSnapshot(
      await run(async () => {
        try {
          return await connected.evaluate<unknown>(OVERLAY_HOOK_SNAPSHOT_EXPRESSION);
        } catch {
          inspected = false;
          return undefined;
        }
      }),
    );
    const applied = overlayInstallState.get(connected);
    const identityMatches =
      inspected &&
      desiredIdentity !== undefined &&
      snapshot !== undefined &&
      overlayIdentitiesMatch(snapshot, desiredIdentity);
    const digestMatches = applied?.currentDigest === desiredDigest;
    const currentMatches =
      inspected && snapshot?.enabled === true && identityMatches && digestMatches;
    const callKnownIdle = inspected && snapshot?.call === "idle";
    const futureDocumentMissing = !registered || applied?.futureDigest !== desiredDigest;
    if (futureDocumentMissing) {
      if (applied?.scriptId) {
        try {
          await run(() =>
            connected.command("Page.removeScriptToEvaluateOnNewDocument", {
              identifier: applied.scriptId,
            }),
          );
        } catch {
          /* Older overlay scripts stay until the page navigates. */
        }
      }
      const added = await run(() =>
        connected.command("Page.addScriptToEvaluateOnNewDocument", {
          source: currentDocumentSource,
        }),
      );
      const addedId =
        isRecord(added) && typeof added.identifier === "string" ? added.identifier : undefined;
      overlayInstallState.set(connected, {
        futureDigest: desiredDigest,
        ...(applied?.currentDigest ? { currentDigest: applied.currentDigest } : {}),
        ...(addedId ? { scriptId: addedId } : {}),
      });
    }
    if (currentMatches) return;
    if (!callKnownIdle) return;
    await run(() => evaluateSource(connected, currentDocumentSource));
    const evaluated = overlayInstallState.get(connected);
    overlayInstallState.set(connected, {
      futureDigest: desiredDigest,
      currentDigest: desiredDigest,
      ...(evaluated?.scriptId ? { scriptId: evaluated.scriptId } : {}),
    });
  } catch (error) {
    overlayClients.delete(target.id);
    if (voiceHostDisposals) unbindRendererVoiceHost(connected, voiceHostDisposals);
    connected.close();
    throw error;
  }
}

function isLocalThreadRenderer(target: CdpTarget): boolean {
  if (target.type !== "page") return false;
  const url = parseCodexAppUrl(target.url);
  if (!url || url.pathname !== "/index.html" || url.hash !== "") return false;
  const route = url.searchParams.get("initialRoute");
  return (
    [...url.searchParams.keys()].length === 1 &&
    (route === "/local" || route?.startsWith("/local/") === true)
  );
}

function isBrowserPage(target: CdpTarget): boolean {
  if (target.type !== "page") return false;
  try {
    return ["http:", "https:"].includes(new URL(target.url).protocol);
  } catch {
    return false;
  }
}

async function installBrowserAnnotationStyles(
  target: CdpTarget,
  browserClients: Map<string, RendererCdpClient>,
  operations: RendererCdpControlOperations,
  signal: AbortSignal,
): Promise<void> {
  const timeoutMessage = "Browser annotation style compatibility installation timed out";
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    runWithCdpSignal(signal, timeoutMessage, operation);
  let renderer = browserClients.get(target.id);
  const registered = renderer !== undefined;
  renderer ??= await connectRendererTarget(target, operations, signal, timeoutMessage);
  const connected = renderer;
  try {
    if (!registered) {
      await run(() => connected.command("Page.enable"));
      await run(() =>
        connected.command("Page.addScriptToEvaluateOnNewDocument", {
          source: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE,
        }),
      );
      // Chromium removes new-document scripts when their CDP session detaches.
      throwIfCdpAborted(signal, timeoutMessage);
      browserClients.set(target.id, connected);
    }
    const installed = await run(() =>
      connected.evaluate<unknown>(
        "globalThis.__codexhostBrowserAnnotationStylesV1?.refresh() === true",
      ),
    );
    if (installed !== true) {
      await run(() => evaluateSource(connected, BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE));
    }
  } catch (error) {
    browserClients.delete(target.id);
    connected.close();
    throw error;
  }
}

async function installLocalThreadRenderer(
  target: CdpTarget,
  source: string,
  enabledAgents: readonly string[] | undefined,
  operations: RendererCdpControlOperations,
  signal: AbortSignal,
): Promise<void> {
  const timeoutMessage = "Local chat Renderer installation timed out";
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    runWithCdpSignal(signal, timeoutMessage, operation);
  const renderer = await connectRendererTarget(target, operations, signal, timeoutMessage);
  try {
    if ((await run(() => readBinding(renderer))) === null) {
      await run(() => renderer.command("Runtime.enable"));
      await run(() => renderer.command("Page.enable"));
      await run(() => renderer.command("Page.addScriptToEvaluateOnNewDocument", { source }));
      await run(() => evaluateSource(renderer, source));
    }
    await run(() => operations.installDraftPrewarmPolicy(renderer));
    await waitForBinding(renderer, enabledAgents, 30_000, 25, signal);
  } finally {
    renderer.close();
  }
}

async function installAuxiliaryRenderers(
  endpoint: string,
  rendererSource: string,
  enabledAgents: readonly string[] | undefined,
  overlayHookSource: string | undefined,
  overlayVoiceBootstrapSource: string | undefined,
  browserStyleClients: Map<string, RendererCdpClient>,
  overlayClients: Map<string, RendererCdpClient>,
  operations: RendererCdpControlOperations,
  signal: AbortSignal,
  voiceHost?: RendererVoiceHostOwner,
  voiceHostDisposals?: VoiceHostDisposals,
  lateVoiceBindings?: Map<string, LateVoiceHostBinding>,
): Promise<void> {
  try {
    const targets = await awaitWithSignal(
      operations.listTargets(endpoint, signal),
      signal,
      "Auxiliary Renderer CDP target discovery timed out",
    );
    const liveTargets = new Set(targets.map((target) => target.id));
    for (const clients of [browserStyleClients, overlayClients]) {
      for (const [id, client] of clients) {
        if (!liveTargets.has(id)) {
          if (voiceHostDisposals) unbindRendererVoiceHost(client, voiceHostDisposals);
          client.close();
          clients.delete(id);
        }
      }
    }
    if (lateVoiceBindings)
      for (const [id, binding] of lateVoiceBindings) {
        if (liveTargets.has(id)) continue;
        binding.dispose();
        binding.client.close();
        lateVoiceBindings.delete(id);
      }
    await Promise.allSettled([
      ...targets
        .filter(isBrowserPage)
        .map((target) =>
          installBrowserAnnotationStyles(target, browserStyleClients, operations, signal),
        ),
      ...(overlayHookSource
        ? selectAvatarOverlayRendererTargets(targets).map((overlay) =>
            installOverlayHook(
              overlay,
              overlayHookSource,
              overlayClients,
              operations,
              signal,
              overlayVoiceBootstrapSource,
              voiceHost,
              voiceHostDisposals,
            ),
          )
        : []),
      ...targets
        .filter(isLocalThreadRenderer)
        .map((target) =>
          installLocalThreadRenderer(target, rendererSource, enabledAgents, operations, signal),
        ),
    ]);
  } catch {
    // Auxiliary windows share one deadline and cannot discard the primary session.
  }
}

async function installTarget(
  target: CdpTarget,
  rendererSource: string,
  enabledAgents: readonly string[] | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  operations: RendererCdpControlOperations,
  voiceHost?: RendererVoiceHostOwner,
  voiceHostDisposals?: VoiceHostDisposals,
  signal?: AbortSignal,
): Promise<{
  renderer: RendererCdpClient;
  snapshot: RendererCdpControlSnapshot;
  disposeModules(): void;
}> {
  const timeoutMessage = "Primary Renderer installation timed out";
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    signal ? runWithCdpSignal(signal, timeoutMessage, operation) : operation();
  const renderer = signal
    ? await connectRendererTarget(target, operations, signal, timeoutMessage)
    : await operations.connect(target.webSocketDebuggerUrl);
  let disposeModules: (() => void) | undefined;
  try {
    if (voiceHost && voiceHostDisposals)
      await run(() =>
        bindRendererVoiceHost(renderer, voiceHost, voiceHostDisposals, {
          enableRuntime: false,
        }),
      );
    disposeModules = await run(() => installRendererLoadedModules(renderer));
    await run(() => renderer.command("Page.enable"));
    await run(() =>
      renderer.command("Page.addScriptToEvaluateOnNewDocument", { source: rendererSource }),
    );
    await run(() => evaluateSource(renderer, rendererSource));
    const draftPrewarmPolicy = await run(() => operations.installDraftPrewarmPolicy(renderer));
    const binding = await waitForBinding(
      renderer,
      enabledAgents,
      timeoutMs,
      pollIntervalMs,
      signal,
    );
    return { renderer, snapshot: { target, draftPrewarmPolicy, binding }, disposeModules };
  } catch (error) {
    disposeModules?.();
    if (voiceHostDisposals) unbindRendererVoiceHost(renderer, voiceHostDisposals);
    renderer.close();
    throw error;
  }
}

class InstalledRendererCdpControlSession implements RendererCdpControlSession {
  #closed = false;
  #lateVoiceHost: RendererVoiceHostOwner | undefined;
  #lateVoicePrimaryId: string | undefined;
  #lateVoiceAttach: Promise<void> | undefined;
  readonly #lateVoiceBindings = new Map<string, LateVoiceHostBinding>();
  readonly #overlayVoiceRetryAt = new Map<string, number>();
  // close() aborts this deadline, so discovery, connects, installs, and
  // liveness probes in flight stop instead of running to their own timeouts.
  readonly #shutdown = new AbortController();

  constructor(
    private renderer: RendererCdpClient,
    private readonly rendererCdpEndpoint: string,
    private readonly rendererSource: string,
    private readonly overlayHookSource: string | undefined,
    private readonly overlayVoiceBootstrapSource: string | undefined,
    private readonly browserStyleClients: Map<string, RendererCdpClient>,
    private readonly overlayClients: Map<string, RendererCdpClient>,
    private readonly enabledAgents: readonly string[] | undefined,
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
    private readonly operations: RendererCdpControlOperations,
    private currentSnapshot: RendererCdpControlSnapshot,
    private disposeModules: () => void,
    private readonly voiceHost: RendererVoiceHostOwner | undefined,
    private readonly voiceHostDisposals: VoiceHostDisposals,
  ) {}

  get snapshot(): RendererCdpControlSnapshot {
    return this.currentSnapshot;
  }

  async ensureInstalled(): Promise<RendererCdpControlSnapshot> {
    this.#assertOpen();
    const target = await waitForPrimaryTarget(
      this.rendererCdpEndpoint,
      this.operations,
      this.timeoutMs,
      this.pollIntervalMs,
      this.currentSnapshot.target.id,
      this.#shutdown.signal,
    );
    // close() cancels discovery; a target found after it must not open connections.
    this.#assertOpen();
    if (target.id !== this.currentSnapshot.target.id) {
      this.#disposeLateVoiceBinding(this.currentSnapshot.target.id);
      await this.#replacePrimary(target);
    } else {
      await this.#reconcilePrimary(target);
    }
    await installAuxiliaryRenderers(
      this.rendererCdpEndpoint,
      this.rendererSource,
      this.enabledAgents,
      this.overlayHookSource,
      this.overlayVoiceBootstrapSource,
      this.browserStyleClients,
      this.overlayClients,
      this.operations,
      discoveryTimeoutSignal(this.timeoutMs, this.#shutdown.signal),
      this.voiceHost,
      this.voiceHostDisposals,
      this.#lateVoiceBindings,
    );
    this.#assertOpen();
    return this.currentSnapshot;
  }

  async #reconcilePrimary(target: CdpTarget): Promise<void> {
    try {
      const existing = await this.#runWhileOpen(() => readBinding(this.renderer));
      if (existing === null)
        await this.#runWhileOpen(() => evaluateSource(this.renderer, this.rendererSource));
      // A Host switch can temporarily leave the Adapter installing. Reconcile
      // native owners before validating readiness; that is not a lost CDP page.
      const draftPrewarmPolicy = await this.#runWhileOpen(() =>
        this.operations.installDraftPrewarmPolicy(this.renderer),
      );
      const binding = await waitForBinding(
        this.renderer,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
        this.#shutdown.signal,
      );
      this.#assertOpen();
      this.currentSnapshot = { target, draftPrewarmPolicy, binding };
    } catch {
      // close() already released the installed connection; it must not be
      // followed by a replacement install for the same target.
      this.#assertOpen();
      this.#disposeLateVoiceBinding(this.currentSnapshot.target.id);
      await this.#replacePrimary(target);
    }
  }

  async #replacePrimary(target: CdpTarget): Promise<void> {
    const replacement = await installTarget(
      target,
      this.rendererSource,
      this.enabledAgents,
      this.timeoutMs,
      this.pollIntervalMs,
      this.operations,
      this.voiceHost,
      this.voiceHostDisposals,
      this.#shutdown.signal,
    );
    if (this.#closed) {
      // Everything this install acquired belongs to a closed session: release it
      // instead of committing a connection that no later close() would reach.
      replacement.disposeModules();
      unbindRendererVoiceHost(replacement.renderer, this.voiceHostDisposals);
      replacement.renderer.close();
      throw new Error("Renderer CDP Control Session is closed");
    }
    this.disposeModules();
    unbindRendererVoiceHost(this.renderer, this.voiceHostDisposals);
    this.renderer.close();
    this.renderer = replacement.renderer;
    this.disposeModules = replacement.disposeModules;
    this.currentSnapshot = replacement.snapshot;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
  }

  #runWhileOpen<T>(operation: () => Promise<T>): Promise<T> {
    return runWithCdpSignal(
      this.#shutdown.signal,
      "Renderer CDP Control Session is closed",
      operation,
    );
  }

  async attachVoiceHost(voiceHost: RendererVoiceHostOwner): Promise<void> {
    this.#assertOpen();
    if (this.voiceHost) return;
    this.#lateVoiceAttach ??= this.#reconcileVoiceHost(voiceHost).finally(() => {
      this.#lateVoiceAttach = undefined;
    });
    return this.#lateVoiceAttach;
  }

  async #reconcileVoiceHost(voiceHost: RendererVoiceHostOwner): Promise<void> {
    const timeoutMs = Math.min(this.timeoutMs, VOICE_HOST_ATTACH_TIMEOUT_MS);
    // Bindings published for another owner cannot serve this Host.
    if (this.#lateVoiceHost !== undefined && this.#lateVoiceHost !== voiceHost)
      this.#disposeLateVoiceBindings();
    const primaryTarget = this.currentSnapshot.target;
    if (this.#lateVoicePrimaryId !== undefined && this.#lateVoicePrimaryId !== primaryTarget.id)
      this.#disposeLateVoiceBinding(this.#lateVoicePrimaryId);
    const existingPrimary = this.#lateVoiceBindings.get(primaryTarget.id);
    if (existingPrimary && !(await lateVoiceBindingIsLive(existingPrimary, this.#shutdown.signal)))
      this.#disposeLateVoiceBinding(primaryTarget.id);
    this.#assertOpen();
    if (!this.#lateVoiceBindings.has(primaryTarget.id)) {
      this.#disposeLateVoiceBinding(primaryTarget.id);
      const binding = await bindVoiceHostOnNewConnection(
        primaryTarget,
        voiceHost,
        this.operations,
        timeoutMs,
        this.#shutdown.signal,
      );
      if (this.#closed) {
        binding.dispose();
        binding.client.close();
        throw new Error("Renderer CDP Control Session is closed");
      }
      this.#lateVoiceBindings.set(binding.targetId, binding);
    }
    this.#lateVoicePrimaryId = primaryTarget.id;
    this.#lateVoiceHost = voiceHost;
    await this.#reconcileOverlayVoiceHost(voiceHost, timeoutMs);
    this.#assertOpen();
  }

  async #reconcileOverlayVoiceHost(
    voiceHost: RendererVoiceHostOwner,
    timeoutMs: number,
  ): Promise<void> {
    // Overlay voice exists only for an installed overlay hook, exactly as the
    // auxiliary installation decides whether the overlay page is qualified.
    if (this.#closed || !this.overlayHookSource) return;
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), this.#shutdown.signal]);
    let targets: CdpTarget[];
    try {
      targets = await awaitWithSignal(
        this.operations.listTargets(this.rendererCdpEndpoint, deadline),
        deadline,
        "Late overlay CDP target discovery timed out",
      );
    } catch {
      return;
    }
    const overlays = selectAvatarOverlayRendererTargets(targets);
    const live = new Set(overlays.map((target) => target.id));
    for (const id of [...this.#lateVoiceBindings.keys()])
      if (id !== this.#lateVoicePrimaryId && !live.has(id)) this.#disposeLateVoiceBinding(id);
    for (const id of [...this.#overlayVoiceRetryAt.keys()])
      if (!live.has(id)) this.#overlayVoiceRetryAt.delete(id);
    await Promise.allSettled(
      overlays.map(async (target) => {
        if (this.#closed) return;
        const existing = this.#lateVoiceBindings.get(target.id);
        if (existing) {
          if (await lateVoiceBindingIsLive(existing, this.#shutdown.signal)) return;
          if (this.#closed) return;
          this.#disposeLateVoiceBinding(target.id);
        }
        if ((this.#overlayVoiceRetryAt.get(target.id) ?? 0) > Date.now()) return;
        try {
          const binding = await bindVoiceHostOnNewConnection(
            target,
            voiceHost,
            this.operations,
            timeoutMs,
            this.#shutdown.signal,
          );
          if (this.#closed) {
            binding.dispose();
            binding.client.close();
            return;
          }
          this.#lateVoiceBindings.set(binding.targetId, binding);
          this.#overlayVoiceRetryAt.delete(binding.targetId);
        } catch {
          // The avatar overlay keeps its own hook; only the primary binding is required.
          this.#overlayVoiceRetryAt.set(target.id, Date.now() + VOICE_HOST_OVERLAY_RETRY_MS);
        }
      }),
    );
  }

  #disposeLateVoiceBinding(targetId: string): void {
    const binding = this.#lateVoiceBindings.get(targetId);
    if (!binding) return;
    // Disposal removes the page capability on its own connection asynchronously;
    // the replacement publishes on a fresh connection after this call returns.
    binding.dispose();
    binding.client.close();
    this.#lateVoiceBindings.delete(targetId);
    if (this.#lateVoicePrimaryId === targetId) this.#lateVoicePrimaryId = undefined;
    this.#overlayVoiceRetryAt.delete(targetId);
  }

  #disposeLateVoiceBindings(): void {
    for (const targetId of [...this.#lateVoiceBindings.keys()])
      this.#disposeLateVoiceBinding(targetId);
  }

  async activateDesktop(): Promise<number> {
    this.#assertOpen();
    await this.renderer.command("Page.bringToFront");
    return 1;
  }

  executeRenderer<T>(expression: string, timeoutMs?: number): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Renderer CDP Control Session is closed"));
    return this.renderer.evaluate<T>(expression, timeoutMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdown.abort(new Error("Renderer CDP Control Session is closed"));
    this.disposeModules();
    unbindRendererVoiceHost(this.renderer, this.voiceHostDisposals);
    this.renderer.close();
    for (const client of this.browserStyleClients.values()) client.close();
    this.browserStyleClients.clear();
    for (const client of this.overlayClients.values()) {
      unbindRendererVoiceHost(client, this.voiceHostDisposals);
      client.close();
    }
    this.overlayClients.clear();
    for (const dispose of this.voiceHostDisposals.values()) dispose();
    this.voiceHostDisposals.clear();
    this.#disposeLateVoiceBindings();
  }
}

const defaultOperations: RendererCdpControlOperations = {
  listTargets: (endpoint, signal) => listCdpTargets(endpoint, fetch, signal),
  connect: (webSocketDebuggerUrl) => CdpClient.connect(webSocketDebuggerUrl),
  async installDraftPrewarmPolicy(renderer) {
    const status = await installRendererDraftPrewarmPolicyDirect(renderer);
    await installNativeRpcRemoteControlDirect(renderer);
    await installRendererRpcSteeringDirect(renderer);
    return status;
  },
};

export async function createRendererCdpControlSession(
  options: CreateRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  const enabledAgents = options.enabledAgents;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const operations = options.operations ?? defaultOperations;
  const target = await waitForPrimaryTarget(
    options.rendererCdpEndpoint,
    operations,
    timeoutMs,
    pollIntervalMs,
    undefined,
    options.signal,
  );
  const voiceHostDisposals: VoiceHostDisposals = new Map();
  const installed = await installTarget(
    target,
    options.rendererSource,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    options.voiceHost,
    voiceHostDisposals,
  );
  const browserStyleClients = new Map<string, RendererCdpClient>();
  const overlayClients = new Map<string, RendererCdpClient>();
  await installAuxiliaryRenderers(
    options.rendererCdpEndpoint,
    options.rendererSource,
    enabledAgents,
    options.overlayHookSource,
    options.overlayVoiceBootstrapSource,
    browserStyleClients,
    overlayClients,
    operations,
    discoveryTimeoutSignal(timeoutMs, options.signal),
    options.voiceHost,
    voiceHostDisposals,
  );
  return new InstalledRendererCdpControlSession(
    installed.renderer,
    options.rendererCdpEndpoint,
    options.rendererSource,
    options.overlayHookSource,
    options.overlayVoiceBootstrapSource,
    browserStyleClients,
    overlayClients,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    installed.snapshot,
    installed.disposeModules,
    options.voiceHost,
    voiceHostDisposals,
  );
}

export function installRendererCdpControlSession(
  options: InstallRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  return createRendererCdpControlSession(options);
}

export type RendererCdpFetch = CdpFetch;
export type RendererCdpClientOptions = CdpClientOptions;
