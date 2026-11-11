import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RELAY_MCP_TOOL_NAMES } from "@codexhost/shared-contracts";

import { EnrollmentAuthority } from "../../packages/host-runtime/src/client-enrollment-authority.js";
import { createStubEnrollmentConsent } from "../../packages/host-runtime/src/client-enrollment-consent.js";
import { allowlistDigest } from "../../packages/host-runtime/src/client-enrollment.js";
import { runEnrollmentRelayLink } from "../../packages/host-runtime/src/client-enrollment-relay-link.js";
import {
  enrollmentStorePath,
  writeEnrollmentStore,
} from "../../packages/host-runtime/src/client-enrollment-store.js";
import { startDelegationControlServer } from "../../packages/host-runtime/src/delegation-control-server.js";
import {
  threadBusyError,
  type DelegationControlApi,
} from "../../packages/host-runtime/src/delegation-types.js";
import { sha256Hex, startEnrolledMcpRelay } from "../../packages/enrolled-mcp-relay/src/index.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function mcp(origin: string, method: string, params?: unknown) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown> & {
        error?: { code?: string; details?: { reason?: string } };
      };
      tools?: { name: string }[];
    };
  };
}

describe("enrolled MCP relay loop", () => {
  it("forces caller identity, follows a new Runtime port, and does not retry send", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-relay-loop-"));
    cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const read = vi.fn(async (body: { threadId: string; callerThreadId?: string }) => ({
      threadId: body.threadId,
      status: "completed",
    }));
    const send = vi.fn(async () => {
      if (send.mock.calls.length > 1) throw new Error("relay retried send");
      return { status: "running", turnId: "turn-1" };
    });
    const wait = vi.fn(async () => ({ threadId: "target", status: "completed", timedOut: false }));
    const authority = new EnrollmentAuthority({
      hostToken: "host-secret",
      dataDirectory,
      consent: createStubEnrollmentConsent("approve"),
      createThread: async () => "muse-own",
    });
    const runtime = await startDelegationControlServer({
      token: "host-secret",
      enrollment: authority,
      api: { read, send, wait } as unknown as DelegationControlApi,
    });
    cleanup.push(async () => runtime.close());
    await authority.publishBootstrap(runtime.endpoint);
    const issued = await authority.enroll({
      clientId: "muse",
      executablePath: "/test/codexhost",
      allowlist: [{ threadId: "target", verbs: ["read", "send"] }],
    });
    expect(allowlistDigest(issued.allowlist)).toBe(issued.allowlistDigest);
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDirectory }, "muse"),
      issued,
    );

    const secret = "loop-secret";
    const secretFile = path.join(dataDirectory, "link.secret");
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
    await chmod(secretFile, 0o600);

    const relay = await startEnrolledMcpRelay({
      listen: "127.0.0.1",
      linkPort: 0,
      mcpPort: 0,
      expectedNodeId: "nKarlmac",
      linkSecretHash: sha256Hex(secret),
      whois: async () => "nKarlmac",
    });
    cleanup.push(() => relay.close());

    const output = new PassThrough();
    const linked = runEnrollmentRelayLink({
      environment: { CODEXHOST_DATA_DIR: dataDirectory },
      parsed: {
        options: new Map([
          ["--client", "muse"],
          ["--hop", "127.0.0.1"],
          ["--port", String(relay.linkPort)],
          ["--link-secret-file", secretFile],
        ]),
        positionals: [],
      },
      output,
      connect: async (hop, port) => createConnection({ host: hop, port }),
    });
    cleanup.push(async () => {
      /* closed via relay.close / socket destroy */
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const tools = await mcp(relay.mcpOrigin, "tools/list");
    expect(tools.result?.tools?.map((tool) => tool.name)).toEqual([...RELAY_MCP_TOOL_NAMES]);

    const status = await mcp(relay.mcpOrigin, "tools/call", {
      name: "enroll_status",
      arguments: {},
    });
    expect(status.result?.structuredContent).toMatchObject({
      clientId: "muse",
      pairing: "machine",
      threadId: "muse-own",
      link: "online",
      runtime: "reachable",
    });
    expect(JSON.stringify(status)).not.toContain(issued.token);

    const allowed = await mcp(relay.mcpOrigin, "tools/call", {
      name: "thread_read",
      arguments: { threadId: "target" },
    });
    expect(allowed.result?.structuredContent).toMatchObject({ threadId: "target" });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "target",
        callerThreadId: "muse-own",
        view: "result",
      }),
    );

    const denied = await mcp(relay.mcpOrigin, "tools/call", {
      name: "thread_read",
      arguments: { threadId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(denied.result?.structuredContent?.error?.code).toBe("UNAUTHORIZED_TARGET");

    const started = await mcp(relay.mcpOrigin, "tools/call", {
      name: "thread_send",
      arguments: { threadId: "target", message: "hello" },
    });
    expect(started.result?.structuredContent).toMatchObject({ status: "running" });

    send.mockImplementationOnce(async () => {
      throw threadBusyError("target");
    });
    const busy = await mcp(relay.mcpOrigin, "tools/call", {
      name: "thread_send",
      arguments: { threadId: "target", message: "again" },
    });
    expect(busy.result?.structuredContent?.error?.code).toBe("THREAD_BUSY");
    expect(
      (
        busy.result?.structuredContent?.error as {
          details?: { authorized?: boolean; notStarted?: boolean };
        }
      )?.details,
    ).toMatchObject({ authorized: true, notStarted: true });

    const waited = await mcp(relay.mcpOrigin, "tools/call", {
      name: "thread_wait",
      arguments: { threadId: "target", timeoutMs: 1000 },
    });
    expect(waited.result?.structuredContent).toMatchObject({ timedOut: false });

    await authority.publishBootstrap("http://127.0.0.1:1");
    const laterRuntime = await startDelegationControlServer({
      token: "host-secret",
      enrollment: authority,
      api: { read, send, wait } as unknown as DelegationControlApi,
    });
    cleanup.push(async () => laterRuntime.close());
    await authority.publishBootstrap(laterRuntime.endpoint);
    read.mockClear();
    const afterPortChange = await mcp(relay.mcpOrigin, "tools/call", {
      name: "thread_read",
      arguments: { threadId: "target" },
    });
    expect(afterPortChange.result?.structuredContent).toMatchObject({ threadId: "target" });
    expect(read).toHaveBeenCalled();

    await relay.close();
    await linked.catch(() => undefined);
  });
});
