import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REALTIME_CALL_METHOD,
  VOICE_GATEWAY_STATUS_METHOD,
  VOICE_SETTINGS_METHOD,
} from "@codexhost/shared-contracts";
import { HostClientChannel } from "../src/host-client-channel.js";
import { ControllerVoiceHost } from "../src/controller-voice-host.js";
import {
  RENDERER_VOICE_HOST_BINDING_NAME,
  RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED,
  installRendererVoiceHostBinding,
  type RendererVoiceHostCdpClient,
} from "../src/renderer-voice-host-binding.js";

const TOKEN = "a".repeat(64);
const EPOCH = "11111111-1111-4111-8111-111111111111";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const part of request) chunks.push(Buffer.from(part as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startHost(
  handler: (method: string, params: unknown) => unknown,
  options: { directory?: string; startedAt?: number } = {},
) {
  const directory =
    options.directory ?? (await mkdtemp(path.join(os.tmpdir(), "codexhost-voice-channel-")));
  const events: ServerResponse[] = [];
  const seen: Array<{ method: string; params: unknown }> = [];
  const server = createServer((request, response) => {
    if (request.headers.origin || request.headers.authorization !== `Bearer ${TOKEN}`) {
      response
        .writeHead(401)
        .end(JSON.stringify({ error: { code: -32001, message: "Unauthorized" } }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/events") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch: EPOCH, sequence: 0 }, reset: true })}\n`,
      );
      events.push(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/rpc") {
      void body(request).then((input) => {
        const method = typeof input.method === "string" ? input.method : "";
        seen.push({ method, params: input.params });
        try {
          const result = handler(method, input.params);
          response.writeHead(200).end(JSON.stringify({ result }));
        } catch (error) {
          const stage =
            error instanceof Error && "stage" in error
              ? (error as { stage?: unknown }).stage
              : undefined;
          response.writeHead(200).end(
            JSON.stringify({
              error: {
                code: -32090,
                message: error instanceof Error ? error.message : "Host request failed",
                ...(typeof stage === "string" ? { data: { stage } } : {}),
              },
            }),
          );
        }
      });
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Host test server has no port");
  const descriptorPath = path.join(directory, `host-${address.port}.json`);
  await writeFile(
    descriptorPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: address.port,
      token: TOKEN,
      epoch: EPOCH,
      owner: "service",
      startedAt: options.startedAt ?? Date.now(),
    }),
  );
  await chmod(descriptorPath, 0o600);
  let closed = false;
  return {
    directory,
    port: address.port,
    seen,
    endEvents() {
      for (const stream of events) stream.end();
    },
    async close(removeDirectory = true) {
      this.endEvents();
      if (!closed) {
        closed = true;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      if (removeDirectory) await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Host Client Channel voice methods", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("uses explicit voice methods and preserves allowlisted gateway stage", async () => {
    const seen: string[] = [];
    const fake = await startHost((method, params) => {
      seen.push(method);
      if (method === VOICE_SETTINGS_METHOD) return { initialized: true, settings: params };
      if (method === VOICE_GATEWAY_STATUS_METHOD) return true;
      if (method === REALTIME_CALL_METHOD) {
        throw Object.assign(new Error("Configured voice gateway request failed"), {
          stage: "config",
        });
      }
      throw new Error(`unexpected ${method}`);
    });
    cleanups.push(() => fake.close());
    const descriptor = {
      version: 1 as const,
      pid: process.pid,
      port: 1,
      token: TOKEN,
      epoch: EPOCH,
      owner: "service" as const,
      startedAt: Date.now(),
    };
    const channel = new HostClientChannel(fake.directory, descriptor);
    cleanups.push(async () => channel.close());
    await channel.start();
    await expect(channel.requestVoiceSettings({ operation: "get" })).resolves.toMatchObject({
      initialized: true,
    });
    await expect(channel.requestVoiceGatewayStatus()).resolves.toBe(true);
    await expect(
      channel.requestRealtimeCall({
        operation: "cancel",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({
      message: "Configured voice gateway request failed",
      stage: "config",
    });
    expect(seen).toEqual([
      VOICE_SETTINGS_METHOD,
      VOICE_GATEWAY_STATUS_METHOD,
      REALTIME_CALL_METHOD,
    ]);
  });

  it("propagates allowlisted stage through Host Client Channel, Controller owner, and CDP deliver", async () => {
    const fake = await startHost((method) => {
      if (method === REALTIME_CALL_METHOD) {
        throw Object.assign(new Error("Configured voice gateway request failed"), {
          stage: "identity",
        });
      }
      throw new Error(`unexpected ${method}`);
    });
    cleanups.push(() => fake.close());
    const channel = new HostClientChannel(fake.directory, {
      version: 1,
      pid: process.pid,
      port: 1,
      token: TOKEN,
      epoch: EPOCH,
      owner: "service",
      startedAt: Date.now(),
    });
    cleanups.push(async () => channel.close());
    await channel.start();
    const voiceHost = new ControllerVoiceHost(channel);
    const listeners = new Map<string, (params: unknown) => void>();
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const renderer = {
      evaluate: vi.fn(async <T>(expression: string): Promise<T> => {
        void expression;
        return true as T;
      }),
      command: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, ...(params ? { params } : {}) });
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
        if (method === "Runtime.evaluate" && JSON.stringify(params).includes("location.href")) {
          return {
            result: { value: { href: "app://-/index.html", top: true } },
          };
        }
        return { result: { value: true } };
      }),
      on: vi.fn((method: string, listener: (params: unknown) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
    };
    const dispose = await installRendererVoiceHostBinding(
      renderer as unknown as RendererVoiceHostCdpClient,
      voiceHost,
    );
    cleanups.push(async () => dispose());
    listeners.get("Runtime.executionContextCreated")?.({
      context: { id: 1, uniqueId: "ctx-1", auxData: { isDefault: true } },
    });
    listeners.get("Runtime.bindingCalled")?.({
      name: RENDERER_VOICE_HOST_BINDING_NAME,
      executionContextId: 1,
      payload: JSON.stringify({
        v: 1,
        id: "stage-1",
        owner: voiceHost.owner,
        generation: voiceHost.generation,
        method: REALTIME_CALL_METHOD,
        params: {
          operation: "create",
          requestId: "11111111-1111-4111-8111-111111111111",
          body: "{}",
        },
      }),
    });
    await vi.waitFor(() => {
      const expressions = commands
        .filter((item) => item.method === "Runtime.evaluate")
        .map((item) => (typeof item.params?.expression === "string" ? item.params.expression : ""))
        .join("\n");
      expect(expressions).toContain('"stage":"identity"');
      expect(expressions).toContain("Configured voice gateway request failed");
    });
  });

  it("refuses Origin-bearing Host requests without logging the token", async () => {
    const fake = await startHost(() => ({ ok: true }));
    cleanups.push(() => fake.close());
    const files = await import("node:fs/promises").then((fs) => fs.readdir(fake.directory));
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(fake.directory, files[0] ?? ""), "utf8"),
    );
    const descriptor = JSON.parse(raw) as { port: number };
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "app://-",
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: VOICE_SETTINGS_METHOD, params: { operation: "get" } }),
    });
    expect(response.status).toBe(401);
  });

  it("keeps bound voice cleanup on the original Host after generation replacement", async () => {
    const hostA = await startHost((method) => {
      if (method === REALTIME_CALL_METHOD) return { status: 204, body: "", headers: {} };
      throw new Error(`unexpected A ${method}`);
    });
    cleanups.push(() => hostA.close(true));
    const channel = new HostClientChannel(hostA.directory, {
      version: 1,
      pid: process.pid,
      port: 1,
      token: TOKEN,
      epoch: EPOCH,
      owner: "service",
      startedAt: Date.now(),
    });
    cleanups.push(async () => channel.close());
    await channel.start();
    const bound = channel.bindVoiceExecution();
    let onlineCount = 0;
    channel.subscribe((update) => {
      if (update.type === "connection" && update.online) onlineCount += 1;
    });
    const hostB = await startHost(
      (method) => {
        if (method === VOICE_SETTINGS_METHOD) return { initialized: true };
        throw new Error(`unexpected B ${method}`);
      },
      { directory: hostA.directory, startedAt: Date.now() + 10_000 },
    );
    cleanups.push(() => hostB.close(false));
    hostA.endEvents();
    await vi.waitFor(() => expect(onlineCount).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    await expect(
      bound.request(REALTIME_CALL_METHOD, {
        operation: "cancel",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({ status: 204, body: "", headers: {} });
    expect(hostA.seen.map((item) => item.method)).toEqual([REALTIME_CALL_METHOD]);
    expect(hostB.seen).toEqual([]);
    await expect(channel.requestVoiceSettings({ operation: "get" })).resolves.toMatchObject({
      initialized: true,
    });
    expect(hostB.seen.map((item) => item.method)).toEqual([VOICE_SETTINGS_METHOD]);
    await hostA.close(false);
    await expect(
      bound.request(REALTIME_CALL_METHOD, {
        operation: "hangup",
        callId: "call-123",
      }),
    ).rejects.toMatchObject({
      message: RENDERER_VOICE_HOST_CLEANUP_UNCONFIRMED,
      stage: "cancel",
    });
    expect(hostB.seen.map((item) => item.method)).toEqual([VOICE_SETTINGS_METHOD]);
  });
});
