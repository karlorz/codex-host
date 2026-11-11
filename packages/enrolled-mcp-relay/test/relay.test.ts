import { createConnection } from "node:net";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { RELAY_LINK_PROTOCOL_VERSION, RELAY_MCP_TOOL_NAMES } from "@codexhost/shared-contracts";

import { sha256Hex } from "../src/secret.js";
import { startEnrolledMcpRelay } from "../src/relay.js";
import { writeJsonl } from "../src/jsonl.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const SECRET = "test-link-secret";
const NODE_ID = "nTestStable";

async function mcp(origin: string, method: string, params?: unknown) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("enrolled MCP relay hop", () => {
  it("lists the four tools and returns mac_link_offline within 2s", async () => {
    const relay = await startEnrolledMcpRelay({
      listen: "127.0.0.1",
      linkPort: 0,
      mcpPort: 0,
      expectedNodeId: NODE_ID,
      linkSecretHash: sha256Hex(SECRET),
      whois: async () => NODE_ID,
    });
    cleanup.push(() => relay.close());
    const started = Date.now();
    const listed = await mcp(relay.mcpOrigin, "tools/list");
    expect(
      (listed.body.result as { tools: { name: string }[] }).tools.map((tool) => tool.name),
    ).toEqual([...RELAY_MCP_TOOL_NAMES]);
    const status = await mcp(relay.mcpOrigin, "tools/call", {
      name: "enroll_status",
      arguments: {},
    });
    const result = status.body.result as {
      isError?: boolean;
      structuredContent?: { error?: { details?: { reason?: string } } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.details?.reason).toBe("mac_link_offline");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("closes a link with the wrong secret or node id", async () => {
    const relay = await startEnrolledMcpRelay({
      listen: "127.0.0.1",
      linkPort: 0,
      mcpPort: 0,
      expectedNodeId: NODE_ID,
      linkSecretHash: sha256Hex(SECRET),
      whois: async () => "other-node",
    });
    cleanup.push(() => relay.close());
    const socket = createConnection({ host: "127.0.0.1", port: relay.linkPort });
    await once(socket, "connect");
    writeJsonl(socket, { v: RELAY_LINK_PROTOCOL_VERSION, secret: SECRET });
    await once(socket, "close");
  });

  it("forwards read after a valid Mac hello and does not store the secret", async () => {
    const relay = await startEnrolledMcpRelay({
      listen: "127.0.0.1",
      linkPort: 0,
      mcpPort: 0,
      expectedNodeId: NODE_ID,
      linkSecretHash: sha256Hex(SECRET),
      whois: async () => NODE_ID,
    });
    cleanup.push(() => relay.close());
    const socket = createConnection({ host: "127.0.0.1", port: relay.linkPort });
    cleanup.push(
      async () =>
        new Promise<void>((resolve) => {
          socket.destroy();
          resolve();
        }),
    );
    await once(socket, "connect");
    let buffer = "";
    socket.setEncoding("utf8");
    const frames: unknown[] = [];
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        frames.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    writeJsonl(socket, { v: RELAY_LINK_PROTOCOL_VERSION, secret: SECRET });
    await viWait(() => frames.length >= 1);
    expect(frames[0]).toEqual({ v: 1, ok: true });
    const pending = mcp(relay.mcpOrigin, "tools/call", {
      name: "thread_read",
      arguments: { threadId: "target" },
    });
    await viWait(() =>
      frames.some((frame) => (frame as { route?: string }).route === "/v1/thread/read"),
    );
    const request = frames.find(
      (frame) => (frame as { route?: string }).route === "/v1/thread/read",
    ) as {
      requestId: string;
      body?: { threadId?: string; view?: string };
    };
    expect(request.body).toMatchObject({ threadId: "target", view: "result" });
    writeJsonl(socket, {
      requestId: request.requestId,
      status: 200,
      body: { threadId: "target", status: "completed" },
    });
    const result = await pending;
    expect(
      (result.body.result as { structuredContent?: { threadId?: string } }).structuredContent
        ?.threadId,
    ).toBe("target");
    expect(JSON.stringify(relay)).not.toContain(SECRET);
  });
});

async function viWait(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
