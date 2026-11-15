import { readFile } from "node:fs/promises";
import path from "node:path";
import { openRendererLocalPage } from "./renderer-local-page.js";
import { CdpConnectionClosedError, listCdpTargets } from "./cdp-client.js";
import { remoteConnectionsExpression } from "./remote-connections-control.js";
import { remoteConnectionsReplySchema } from "@codexhost/shared-contracts";

import {
  startControllerAttachmentServer,
  type ControllerAttachmentServer,
  type StartControllerAttachmentServerOptions,
} from "./controller-attachment-server.js";
import {
  createControllerStatusPublisher,
  createRendererStatusReporter,
  type DesktopControllerStatusDocument,
} from "./controller-status.js";
import {
  cpaLiveVoiceHookBootstrap,
  cpaLiveVoiceOverlayHookAllowed,
  overlayVoiceBootstrapPreferred,
  readVoiceIsolatedQualification,
  readVoiceQualification,
} from "./cpa-live-voice-hook.js";
import {
  installRendererCdpControlSession,
  type RendererCdpControlSession,
} from "./renderer-cdp-control-session.js";
import { rendererInjectionSkipReason } from "./renderer-injection-skip.js";
import { connectControllerVoiceHost, type ControllerVoiceHost } from "./controller-voice-host.js";
import type { RendererVoiceHostOwner } from "./renderer-voice-host-binding.js";

export interface DesktopControllerOptions {
  rendererCdpEndpoint: string;
  rendererPath: string;
  attachmentPort: number;
  attachmentNonce: string;
  hostDataDirectory?: string;
  requestStop?(): void;
}

export interface DesktopControllerReadiness {
  schemaVersion: 2;
  state: "compatible";
  issues: [];
}

export interface DesktopControllerDependencies {
  readRenderer(filePath: string): Promise<string>;
  install(options: {
    rendererCdpEndpoint: string;
    rendererSource: string;
    overlayHookSource?: string;
    overlayVoiceBootstrapSource?: string;
    enabledAgents?: readonly string[];
    timeoutMs: number;
    signal?: AbortSignal;
    voiceHost?: RendererVoiceHostOwner;
  }): Promise<RendererCdpControlSession>;
  startAttachmentServer(
    options: StartControllerAttachmentServerOptions,
  ): Promise<ControllerAttachmentServer>;
  ready(readiness: DesktopControllerReadiness): void;
  /** Publishes Renderer integration state for the codexhost console. */
  publishStatus?(document: DesktopControllerStatusDocument): void;
  sleep(milliseconds: number): Promise<void>;
  now?(): number;
  monitorIntervalMs: number;
}

const PRODUCTION_INSTALL_TIMEOUT_MS = 90_000;
const RENDERER_CSP_BOOTSTRAP =
  "globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;";
const DESKTOP_CONTROLLER_READINESS_MAX_BYTES = 512;
const TRANSIENT_INSTALL_ATTEMPTS = 3;
const TRANSIENT_INSTALL_RETRY_MS = 250;
const RECOVERY_RETRY_INITIAL_MS = 30_000;
const RECOVERY_RETRY_MAX_MS = 300_000;
const REMOTE_CONNECTION_RECOVERY_INTERVAL_MS = 5_000;
// Below `npm stop`'s 10s exit bound, so a stuck Renderer evaluation cannot hold the controller.
const SHUTDOWN_OPERATION_WAIT_MS = 3_000;

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const startupTraceStartedAt = Date.now();

function startupTrace(stage: string, detail?: unknown): void {
  if (process.env.CODEXHOST_STARTUP_TRACE !== "1") return;
  const suffix =
    detail === undefined ? "" : `: ${detail instanceof Error ? detail.message : String(detail)}`;
  console.error(
    `[codexhost startup +${Date.now() - startupTraceStartedAt}ms] controller: ${stage}${suffix}`,
  );
}

export function serializeDesktopControllerReadiness(readiness: DesktopControllerReadiness): string {
  if (
    readiness.schemaVersion !== 2 ||
    readiness.state !== "compatible" ||
    !Array.isArray(readiness.issues) ||
    readiness.issues.length !== 0 ||
    Object.keys(readiness).length !== 3
  ) {
    throw new Error("Desktop Controller readiness is invalid");
  }
  const line = JSON.stringify(readiness);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_CONTROLLER_READINESS_MAX_BYTES) {
    throw new Error("Desktop Controller readiness exceeds its size limit");
  }
  return line;
}

const defaultDependencies: DesktopControllerDependencies = {
  readRenderer: (filePath) => readFile(filePath, "utf8"),
  install: installRendererCdpControlSession,
  startAttachmentServer: startControllerAttachmentServer,
  ready: (readiness) => {
    process.stdout.write(`${serializeDesktopControllerReadiness(readiness)}\n`);
  },
  publishStatus: createControllerStatusPublisher(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monitorIntervalMs: 500,
};

function rendererCdpEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("--renderer-cdp-endpoint must be a loopback HTTP origin with an explicit port");
  }
  return url.origin;
}

export function parseDesktopControllerArguments(
  arguments_: readonly string[],
): DesktopControllerOptions {
  let endpoint: string | undefined;
  let rendererPath: string | undefined;
  let attachmentPort: number | undefined;
  let attachmentNonce: string | undefined;
  let hostDataDirectory: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--renderer-cdp-endpoint") {
      if (endpoint !== undefined) {
        throw new Error("--renderer-cdp-endpoint may only be provided once");
      }
      if (!value) throw new Error("--renderer-cdp-endpoint requires a value");
      endpoint = rendererCdpEndpoint(value);
      index += 1;
      continue;
    }
    if (argument === "--renderer") {
      if (rendererPath !== undefined) throw new Error("--renderer may only be provided once");
      if (!value) throw new Error("--renderer requires a value");
      if (!path.isAbsolute(value)) throw new Error("--renderer must be an absolute path");
      rendererPath = path.normalize(value);
      index += 1;
      continue;
    }
    if (argument === "--attachment-port") {
      if (attachmentPort !== undefined) {
        throw new Error("--attachment-port may only be provided once");
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--attachment-port must be a valid TCP port");
      }
      attachmentPort = port;
      index += 1;
      continue;
    }
    if (argument === "--attachment-nonce") {
      if (attachmentNonce !== undefined) {
        throw new Error("--attachment-nonce may only be provided once");
      }
      if (value === undefined || !/^[0-9a-f]{32}$/.test(value)) {
        throw new Error("--attachment-nonce must be 32 lowercase hexadecimal characters");
      }
      attachmentNonce = value;
      index += 1;
      continue;
    }
    if (argument === "--host-data") {
      if (hostDataDirectory !== undefined) throw new Error("--host-data may only be provided once");
      if (!value) throw new Error("--host-data requires a value");
      if (!path.isAbsolute(value)) throw new Error("--host-data must be an absolute path");
      hostDataDirectory = path.normalize(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown Desktop Controller option: ${argument}`);
  }
  if (endpoint === undefined) throw new Error("--renderer-cdp-endpoint is required");
  if (rendererPath === undefined) throw new Error("--renderer is required");
  if (attachmentPort === undefined) throw new Error("--attachment-port is required");
  if (attachmentNonce === undefined) throw new Error("--attachment-nonce is required");
  return {
    rendererCdpEndpoint: endpoint,
    rendererPath,
    attachmentPort,
    attachmentNonce,
    ...(hostDataDirectory ? { hostDataDirectory } : {}),
  };
}

function isTransientRendererInstallError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof CdpConnectionClosedError) return true;
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Execution context was destroyed") ||
      message.includes("Promise was collected")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
    if (current === undefined) break;
  }
  return false;
}

async function installProductionSession(
  options: Parameters<DesktopControllerDependencies["install"]>[0],
  dependencies: DesktopControllerDependencies,
): Promise<RendererCdpControlSession> {
  for (let attempt = 1; attempt <= TRANSIENT_INSTALL_ATTEMPTS; attempt += 1) {
    try {
      return await dependencies.install(options);
    } catch (error) {
      if (attempt === TRANSIENT_INSTALL_ATTEMPTS || !isTransientRendererInstallError(error)) {
        throw error;
      }
      await dependencies.sleep(TRANSIENT_INSTALL_RETRY_MS);
    }
  }
  throw new Error("Desktop Controller exhausted Renderer installation attempts");
}

export async function runDesktopController(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies = defaultDependencies,
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  let session: RendererCdpControlSession | undefined;
  let voiceHost: ControllerVoiceHost | undefined;
  let nextRecoveryAt = 0;
  let recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
  const overlayDir = path.dirname(options.rendererPath);
  const isolated = readVoiceIsolatedQualification(overlayDir);
  const qualification = readVoiceQualification(overlayDir);
  const desktopVersion = process.env.CODEXHOST_DESKTOP_VERSION?.trim();
  const desktopBuild = process.env.CODEXHOST_DESKTOP_BUILD?.trim();
  const asarDigest = process.env.CODEXHOST_DESKTOP_ASAR_DIGEST?.trim();
  const appPath = process.env.CODEXHOST_DESKTOP_APP_PATH?.trim();
  const skipReason = rendererInjectionSkipReason(
    process.env.CODEXHOST_DESKTOP_VERSION,
    process.platform,
    {
      ...(isolated ? { isolated } : {}),
      identity: {
        desktopPlatform: process.platform,
        ...(desktopVersion ? { desktopVersion } : {}),
        ...(desktopBuild ? { desktopBuild } : {}),
        ...(asarDigest ? { asarDigest } : {}),
        ...(appPath ? { appPath } : {}),
        ...(qualification ? { implementationRevision: qualification.implementationRevision } : {}),
      },
    },
  );
  const bootstrap = cpaLiveVoiceHookBootstrap(process.env, undefined, overlayDir);
  const status = createRendererStatusReporter(
    (document) =>
      dependencies.publishStatus?.({
        ...document,
        voiceInjection: Boolean(bootstrap),
        voiceEnvOverride:
          process.env.CODEXHOST_CPA_LIVE_VOICE === "0" ||
          process.env.CODEXHOST_CPA_LIVE_VOICE === "1"
            ? process.env.CODEXHOST_CPA_LIVE_VOICE
            : null,
      }),
    now,
  );
  const recordRecoveryFailure = (error: unknown): void => {
    nextRecoveryAt = now() + recoveryDelayMs;
    recoveryDelayMs = Math.min(recoveryDelayMs * 2, RECOVERY_RETRY_MAX_MS);
    status.failed(error);
  };
  const recordRecoverySuccess = (): void => {
    nextRecoveryAt = 0;
    recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
    status.installed();
  };
  const createSession = async (): Promise<RendererCdpControlSession> => {
    status.installing();
    startupTrace("reading Renderer bundle");
    const rendererRead = dependencies.readRenderer(options.rendererPath);
    const overlayPath =
      bootstrap && cpaLiveVoiceOverlayHookAllowed(process.env, overlayDir)
        ? path.join(overlayDir, "cpa-live-voice-hook.js")
        : undefined;
    const overlayBootstrapPath =
      overlayPath && overlayVoiceBootstrapPreferred(process.env, overlayDir)
        ? path.join(overlayDir, "overlay-voice-bootstrap.js")
        : undefined;
    const [rendererSource, overlayBundle, overlayBootstrapBundle] = overlayPath
      ? await Promise.all([
          rendererRead,
          dependencies.readRenderer(overlayPath),
          overlayBootstrapPath
            ? dependencies.readRenderer(overlayBootstrapPath).catch(() => "")
            : Promise.resolve(""),
        ])
      : [await rendererRead, undefined, ""];
    if (rendererSource.trim().length === 0) throw new Error("production Renderer Bundle is empty");
    const overlayHookSource =
      bootstrap && overlayBundle && overlayBundle.trim().length > 0
        ? `${RENDERER_CSP_BOOTSTRAP}\n${bootstrap}${overlayBundle}`
        : undefined;
    const overlayVoiceBootstrapSource =
      overlayHookSource && overlayBootstrapBundle.trim().length > 0
        ? `${RENDERER_CSP_BOOTSTRAP}\n${bootstrap}${overlayBootstrapBundle}`
        : undefined;
    startupTrace("installing Renderer Session");
    if (!voiceHost && options.hostDataDirectory && !skipReason) {
      voiceHost = await connectControllerVoiceHost(options.hostDataDirectory);
    }
    const installed = await installProductionSession(
      {
        rendererCdpEndpoint: options.rendererCdpEndpoint,
        rendererSource: `${RENDERER_CSP_BOOTSTRAP}\n${bootstrap}${rendererSource}`,
        ...(overlayHookSource ? { overlayHookSource } : {}),
        ...(overlayVoiceBootstrapSource ? { overlayVoiceBootstrapSource } : {}),
        ...(voiceHost ? { voiceHost } : {}),
        // External Agents are discovered from each target Host after installation.
        timeoutMs: PRODUCTION_INSTALL_TIMEOUT_MS,
        signal,
      },
      dependencies,
    );
    startupTrace("Renderer Session installed");
    return installed;
  };
  startupTrace("initialization started");

  let operation = Promise.resolve<unknown>(undefined);
  const useSession = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = operation.then(callback, callback);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  let remoteRecovery: Promise<unknown> | undefined;
  let nextRemoteRecoveryAt = 0;
  const restoreRemoteConnections = (current: RendererCdpControlSession): void => {
    if (signal.aborted || remoteRecovery || now() < nextRemoteRecoveryAt) return;
    nextRemoteRecoveryAt = now() + REMOTE_CONNECTION_RECOVERY_INTERVAL_MS;
    // Share the hosts recovery policy with Web; native SSH work must not block monitoring.
    remoteRecovery = Promise.resolve()
      .then(() => {
        if (!signal.aborted && session === current)
          return current.executeRenderer(
            remoteConnectionsExpression({ action: "session", operation: { kind: "hosts" } }),
          );
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        remoteRecovery = undefined;
      });
  };
  const resetSession = (): void => {
    session?.close();
    session = undefined;
  };
  const ensureSession = async (): Promise<RendererCdpControlSession> => {
    if (skipReason) throw new Error(skipReason);
    if (!session) session = await createSession();
    else await session.ensureInstalled();
    return session;
  };
  const recoverSession = async (): Promise<RendererCdpControlSession> => {
    if (skipReason) throw new Error(skipReason);
    try {
      const current = await ensureSession();
      recordRecoverySuccess();
      return current;
    } catch (error) {
      resetSession();
      recordRecoveryFailure(error);
      throw error;
    }
  };

  let attachmentServer: ControllerAttachmentServer | undefined;
  try {
    startupTrace("starting attachment server");
    attachmentServer = await dependencies.startAttachmentServer({
      port: options.attachmentPort,
      nonce: options.attachmentNonce,
      ...(options.requestStop ? { stop: options.requestStop } : {}),
      remoteConnections: async (request) => {
        // Serialize session recovery, not the native request: the renderer can await Host
        // responses while other settings reads run. Never retry a submitted mutation.
        const current = await useSession(() => recoverSession());
        return remoteConnectionsReplySchema.parse(
          await current.executeRenderer(remoteConnectionsExpression(request)),
        );
      },
      openLocalPage: (url) =>
        openRendererLocalPage(
          (expression) =>
            useSession(async () => (await recoverSession()).executeRenderer(expression)),
          url,
          () => listCdpTargets(options.rendererCdpEndpoint),
        ),
      attach: () =>
        useSession(async () => {
          const current = await recoverSession();
          await current.activateDesktop();
        }),
    });
    startupTrace("attachment server ready");
    startupTrace("publishing readiness");
    dependencies.ready({
      schemaVersion: 2,
      state: "compatible",
      issues: [],
    });
    if (skipReason) {
      nextRecoveryAt = Number.POSITIVE_INFINITY;
      status.failed(new Error(skipReason));
    }
    await useSession(async () => {
      if (session || skipReason) return;
      try {
        session = await createSession();
        recordRecoverySuccess();
        restoreRemoteConnections(session);
      } catch (error) {
        startupTrace("initial Renderer Session unavailable", error);
        session = undefined;
        recordRecoveryFailure(error);
      }
    });
    while (!signal.aborted) {
      await dependencies.sleep(dependencies.monitorIntervalMs);
      if (signal.aborted) continue;
      await useSession(async () => {
        if (!session && now() < nextRecoveryAt) return;
        try {
          restoreRemoteConnections(await recoverSession());
        } catch {
          // Renderer integration remains unavailable until a later bounded retry succeeds.
        }
      });
    }
  } finally {
    await attachmentServer?.close();
    // Closing the session below releases an evaluation still waiting on the Renderer.
    await settleWithin(operation, SHUTDOWN_OPERATION_WAIT_MS);
    resetSession();
    voiceHost?.close();
    // An operation that outlives the wait may still open a session; close it once it settles.
    void operation.then(resetSession);
  }
}
