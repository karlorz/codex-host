/**
 * Controller → real CDP transport → page capability → real authenticated Host channel.
 * The in-process CDP peer runs page sources in a `node:vm` context and forwards
 * `Runtime.bindingCalled`; the Host fixture speaks the documented client-channel wire.
 * Only the Renderer's draft-prewarm installer is replaced, because it needs a live React tree.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";

import { VOICE_GATEWAY_STATUS_METHOD, VOICE_SETTINGS_METHOD } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { CdpClient, listCdpTargets } from "../src/cdp-client.js";
import {
  createRendererCdpControlSession,
  type RendererCdpControlSession,
} from "../src/renderer-cdp-control-session.js";
import {
  runDesktopController,
  type DesktopControllerDependencies,
} from "../src/production-controller.js";

const ATTACHMENT_NONCE = "0123456789abcdef0123456789abcdef";
const PRIMARY_TARGET_ID = "primary";
const PRIMARY_TARGET_URL = "app://-/index.html";
const INELIGIBLE_TARGET_ID = "settings";
const INELIGIBLE_TARGET_URL = "app://-/index.html?initialRoute=%2Fsettings";
const VOICE_HOST_TOKEN = "c".repeat(64);
const CONTEXT_ID = 1;

// The fixture Renderer only provides the status contract the Controller probes.
const RENDERER_SOURCE = `globalThis.__codexhostRendererBindingProbeV1 = Object.freeze({
  status: () => ({ version: 2, enabledAgents: ["codex"], adapter: { state: "ready", reason: "ready" } }),
});`;

const VOICE_ENVIRONMENT_KEYS = [
  "CODEXHOST_CPA_LIVE_VOICE",
  "CODEXHOST_DESKTOP_VERSION",
  "CODEXHOST_DESKTOP_BUILD",
  "CODEXHOST_DESKTOP_ASAR_DIGEST",
  "CODEXHOST_DESKTOP_APP_PATH",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`${label} did not happen within ${timeoutMs}ms`);
}

async function withVoiceEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(
    VOICE_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof VOICE_ENVIRONMENT_KEYS)[number], string | undefined>;
  for (const key of VOICE_ENVIRONMENT_KEYS) Reflect.deleteProperty(process.env, key);
  // Disables the CPA overlay hook so the fixture never inspects the user's Desktop installation.
  process.env.CODEXHOST_CPA_LIVE_VOICE = "0";
  try {
    return await run();
  } finally {
    for (const key of VOICE_ENVIRONMENT_KEYS) {
      const value = previous[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

interface FakeCdpPage {
  readonly id: string;
  readonly url: string;
  readonly context: ReturnType<typeof createContext>;
  readonly sandbox: Record<string, unknown>;
  readonly timers: Set<NodeJS.Timeout>;
  publications: number;
}

function fakeCdpPage(id: string, url: string): FakeCdpPage {
  const timers = new Set<NodeJS.Timeout>();
  const sandbox: Record<string, unknown> = {
    URL,
    console,
    crypto: { randomUUID },
    setTimeout: (callback: () => void, milliseconds?: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, milliseconds);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: NodeJS.Timeout) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  };
  const context = createContext(sandbox, { name: `fake-cdp-${id}` });
  runInContext(
    `globalThis.window = globalThis;
     globalThis.self = globalThis;
     globalThis.top = globalThis;
     globalThis.location = { href: ${JSON.stringify(url)} };
     globalThis.document = { href: ${JSON.stringify(url)}, querySelectorAll: () => [] };`,
    context,
  );
  return { id, url, context, sandbox, timers, publications: 0 };
}

interface FakeCdpConnection {
  readonly pageId: string;
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }>;
}

interface FakeCdpTarget {
  readonly id: string;
  readonly url: string;
}

async function startFakeCdp(targets: readonly FakeCdpTarget[]) {
  const pages = new Map(targets.map((target) => [target.id, fakeCdpPage(target.id, target.url)]));
  const connections: FakeCdpConnection[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  let scriptSequence = 0;
  let port = 0;

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/json/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          [...pages.values()].map((page) => ({
            id: page.id,
            type: "page",
            title: page.id,
            url: page.url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}`,
          })),
        ),
      );
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      sockets.emit("connection", websocket, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake CDP server has no port");
  port = address.port;

  sockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const page = pages.get(pathname.split("/").at(-1) ?? "");
    if (!page) {
      socket.close();
      return;
    }
    const uniqueId = `context-${page.id}`;
    const connection: FakeCdpConnection = { pageId: page.id, commands: [] };
    connections.push(connection);
    const bindings = new Map<string, (payload: string) => void>();
    const respond = (id: number, result: unknown): void => {
      socket.send(JSON.stringify({ id, result }));
    };
    const fail = (id: number, error: unknown): void => {
      socket.send(
        JSON.stringify({
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        }),
      );
    };
    const evaluate = async (params: Record<string, unknown> | undefined) => {
      const expression = typeof params?.expression === "string" ? params.expression : "";
      if (typeof params?.contextId === "number" && params.contextId !== CONTEXT_ID)
        throw new Error("Cannot find context with specified id");
      if (typeof params?.uniqueContextId === "string" && params.uniqueContextId !== uniqueId)
        throw new Error("uniqueContextId not found");
      let value: unknown;
      try {
        value = runInContext(expression, page.context);
        if (params?.awaitPromise === true) value = await value;
      } catch (error) {
        return {
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: error instanceof Error ? error.message : String(error) },
          },
        };
      }
      if (expression.includes('const cap = "__codexhostVoiceHostV1"')) page.publications += 1;
      const type = typeof value === "object" && value !== null ? "object" : typeof value;
      if (params?.returnByValue !== true) return { result: { type } };
      return { result: { type, value: hostValue(value) } };
    };
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      connection.commands.push({
        method: frame.method,
        ...(frame.params ? { params: frame.params } : {}),
      });
      void (async (): Promise<unknown> => {
        switch (frame.method) {
          case "Runtime.enable":
            socket.send(
              JSON.stringify({
                method: "Runtime.executionContextCreated",
                params: {
                  context: {
                    id: CONTEXT_ID,
                    origin: "app://-",
                    name: "",
                    uniqueId,
                    auxData: { isDefault: true, type: "default", frameId: `frame-${page.id}` },
                  },
                },
              }),
            );
            return {};
          case "Runtime.addBinding": {
            const name = String(frame.params?.name);
            const binding = (payload: string): void => {
              socket.send(
                JSON.stringify({
                  method: "Runtime.bindingCalled",
                  params: { name, payload, executionContextId: CONTEXT_ID },
                }),
              );
            };
            bindings.set(name, binding);
            page.sandbox[name] = binding;
            return {};
          }
          case "Runtime.removeBinding": {
            const name = String(frame.params?.name);
            if (!bindings.delete(name)) return {};
            Reflect.deleteProperty(page.sandbox, name);
            return {};
          }
          case "Runtime.evaluate":
            return await evaluate(frame.params);
          case "Page.addScriptToEvaluateOnNewDocument":
            scriptSequence += 1;
            return { identifier: `script-${scriptSequence}` };
          default:
            return {};
        }
      })().then(
        (result) => respond(frame.id, result),
        (error: unknown) => fail(frame.id, error),
      );
    });
  });

  const pageContext = (targetId: string) => {
    const page = pages.get(targetId);
    if (!page) throw new Error(`Unknown fake CDP target ${targetId}`);
    return page.context;
  };

  return {
    endpoint: `http://127.0.0.1:${port}`,
    connections,
    pageHasCapability(targetId: string): boolean {
      return (
        runInContext(
          "typeof globalThis.__codexhostVoiceHostV1 === 'object'",
          pageContext(targetId),
        ) === true
      );
    },
    capability(targetId: string): unknown {
      return jsonValue(
        runInContext(
          `(() => {
            const capability = globalThis.__codexhostVoiceHostV1;
            return capability ? { owner: capability.owner, generation: capability.generation } : null;
          })()`,
          pageContext(targetId),
        ),
      );
    },
    requestFromPage(targetId: string, method: string, params: Record<string, unknown>) {
      return runInContext(
        `globalThis.__codexhostVoiceHostV1.request(${JSON.stringify(method)}, ${JSON.stringify(params)})`,
        pageContext(targetId),
      ) as Promise<unknown>;
    },
    publications(targetId: string): number {
      return pages.get(targetId)?.publications ?? 0;
    },
    bindingConnections(targetId: string): number {
      return connections.filter(
        (connection) =>
          connection.pageId === targetId &&
          connection.commands.some((command) => command.method === "Runtime.addBinding"),
      ).length;
    },
    async close(): Promise<void> {
      for (const socket of sockets.clients) socket.close();
      for (const page of pages.values()) for (const timer of page.timers) clearTimeout(timer);
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function hostValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return jsonValue(value);
  }
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isRecord(parsed) ? parsed : {};
}

async function startFakeVoiceHost() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-voice-controller-"));
  const clientHosts = path.join(dataDirectory, "client-hosts");
  await mkdir(clientHosts, { recursive: true, mode: 0o700 });
  const epoch = randomUUID();
  const requests: Array<{
    method: string;
    params: Record<string, unknown>;
    authorization: string | undefined;
  }> = [];
  const streams = new Set<ServerResponse>();
  let eventConnections = 0;

  const server = createServer((request, response) => {
    if (
      request.headers.origin !== undefined ||
      request.headers.authorization !== `Bearer ${VOICE_HOST_TOKEN}`
    ) {
      response
        .writeHead(401)
        .end(JSON.stringify({ error: { code: -32001, message: "Unauthorized" } }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/events") {
      eventConnections += 1;
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 0 }, reset: true })}\n`,
      );
      streams.add(response);
      response.on("close", () => streams.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/rpc") {
      void requestBody(request).then((input) => {
        const method = typeof input.method === "string" ? input.method : "";
        const params = isRecord(input.params) ? input.params : {};
        requests.push({ method, params, authorization: request.headers.authorization });
        const result =
          method === VOICE_SETTINGS_METHOD
            ? { initialized: true, settings: params }
            : { state: "ready", stage: "transport" };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result }));
      });
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake Host has no port");

  return {
    dataDirectory,
    token: VOICE_HOST_TOKEN,
    requests,
    get eventConnections(): number {
      return eventConnections;
    },
    get openEventStreams(): number {
      return streams.size;
    },
    /** Publishing the descriptor is the Host becoming available to the Controller. */
    async publish(): Promise<void> {
      const descriptor = path.join(clientHosts, `host-${address.port}.json`);
      const staging = `${descriptor}.tmp`;
      await writeFile(
        staging,
        JSON.stringify({
          version: 1,
          owner: "service",
          pid: process.pid,
          port: address.port,
          token: VOICE_HOST_TOKEN,
          epoch,
          startedAt: Date.now(),
        }),
        { mode: 0o600 },
      );
      await chmod(staging, 0o600);
      await rename(staging, descriptor);
    },
    async close(): Promise<void> {
      for (const stream of streams) stream.end();
      streams.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

describe("production Desktop Controller Voice Host integration", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("binds an eligible page to a Host that appears after startup and routes voice RPC exactly once", async () => {
    await withVoiceEnvironment(async () => {
      const cdp = await startFakeCdp([
        { id: PRIMARY_TARGET_ID, url: PRIMARY_TARGET_URL },
        { id: INELIGIBLE_TARGET_ID, url: INELIGIBLE_TARGET_URL },
      ]);
      cleanups.push(() => cdp.close());
      const host = await startFakeVoiceHost();
      cleanups.push(() => host.close());
      const rendererDirectory = await mkdtemp(
        path.join(os.tmpdir(), "codexhost-controller-renderer-"),
      );
      cleanups.push(() => rm(rendererDirectory, { recursive: true, force: true }));

      const rendererPath = path.join(rendererDirectory, "renderer-extension.js");
      const installs: Array<Parameters<DesktopControllerDependencies["install"]>[0]> = [];
      const installed = Promise.withResolvers<undefined>();
      const abort = new AbortController();
      let runError: unknown;
      const run = runDesktopController(
        {
          rendererCdpEndpoint: cdp.endpoint,
          rendererPath,
          attachmentPort: 43_124,
          attachmentNonce: ATTACHMENT_NONCE,
          hostDataDirectory: host.dataDirectory,
        },
        abort.signal,
        {
          readRenderer: async (filePath) => {
            if (filePath !== rendererPath) throw new Error(`Unexpected Renderer read ${filePath}`);
            return RENDERER_SOURCE;
          },
          install: async (options): Promise<RendererCdpControlSession> => {
            installs.push(options);
            const session = await createRendererCdpControlSession({
              ...options,
              operations: {
                listTargets: (endpoint, signal) => listCdpTargets(endpoint, fetch, signal),
                connect: (webSocketDebuggerUrl) => CdpClient.connect(webSocketDebuggerUrl),
                installDraftPrewarmPolicy: async () => ({
                  state: "ready" as const,
                  reason: "owned-request-bridge" as const,
                }),
              },
            });
            installed.resolve(undefined);
            return session;
          },
          startAttachmentServer: async () => ({ close: async () => {} }),
          ready: () => {},
          sleep,
          monitorIntervalMs: 50,
        },
      );
      run.catch((error: unknown) => {
        runError = error;
      });

      let stopping = false;
      try {
        await installed.promise;
        if (runError) throw runError;

        // The Host was absent for every startup attempt and the Renderer is installed.
        expect(host.eventConnections).toBe(0);
        expect(installs).toHaveLength(1);
        expect(installs[0]?.voiceHost).toBeUndefined();
        expect(cdp.pageHasCapability(PRIMARY_TARGET_ID)).toBe(false);
        expect(cdp.pageHasCapability(INELIGIBLE_TARGET_ID)).toBe(false);

        await host.publish();
        await waitFor(
          () => cdp.pageHasCapability(PRIMARY_TARGET_ID),
          25_000,
          "voice capability publication",
        );

        // Only the eligible page received it, once, through one late binding connection.
        expect(cdp.pageHasCapability(INELIGIBLE_TARGET_ID)).toBe(false);
        expect(cdp.publications(PRIMARY_TARGET_ID)).toBe(1);
        expect(cdp.bindingConnections(PRIMARY_TARGET_ID)).toBe(1);
        expect(cdp.capability(PRIMARY_TARGET_ID)).toEqual({
          owner: expect.any(String),
          generation: 1,
        });
        expect(host.eventConnections).toBe(1);

        const settings = await cdp.requestFromPage(PRIMARY_TARGET_ID, VOICE_SETTINGS_METHOD, {
          scope: "controller-integration",
        });
        expect(jsonValue(settings)).toEqual({
          initialized: true,
          settings: { scope: "controller-integration" },
        });
        const settingsRequests = host.requests.filter(
          (request) => request.method === VOICE_SETTINGS_METHOD,
        );
        expect(settingsRequests).toHaveLength(1);
        expect(settingsRequests[0]?.params).toEqual({ scope: "controller-integration" });
        expect(settingsRequests[0]?.authorization).toBe(`Bearer ${host.token}`);

        const gateway = await cdp.requestFromPage(
          PRIMARY_TARGET_ID,
          VOICE_GATEWAY_STATUS_METHOD,
          {},
        );
        expect(jsonValue(gateway)).toEqual({ state: "ready", stage: "transport" });
        expect(
          host.requests.filter((request) => request.method === VOICE_GATEWAY_STATUS_METHOD),
        ).toHaveLength(1);
        expect(host.requests).toHaveLength(2);
        // A late Host must not replace the installed Renderer Session.
        expect(installs).toHaveLength(1);
        expect(cdp.bindingConnections(PRIMARY_TARGET_ID)).toBe(1);

        stopping = true;
        abort.abort();
        await run;
        if (runError) throw runError;
        await waitFor(() => host.openEventStreams === 0, 5_000, "Host channel release");
      } finally {
        if (!stopping) abort.abort();
        await run.catch(() => undefined);
      }
    });
  }, 60_000);
});
