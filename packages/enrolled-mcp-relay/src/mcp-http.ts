import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  RELAY_MAX_BODY_BYTES,
  RELAY_MCP_TOOL_NAMES,
  RELAY_OFFLINE_TIMEOUT_MS,
  RELAY_UPSTREAM_TIMEOUT_MS,
  RELAY_WAIT_TIMEOUT_MAX_MS,
  relayEnrollStatusInputSchema,
  relayEnrollStatusResultSchema,
  relayThreadReadInputSchema,
  relayThreadSendInputSchema,
  relayThreadWaitInputSchema,
  type RelayAllowedRoute,
  type RelayEnrollStatusResult,
  type RelayLinkReply,
} from "@codexhost/shared-contracts";

import { bindListeningPort } from "./listen.js";
import type { LinkListener } from "./link-server.js";
import {
  handleOAuthRequest,
  inspectMcpBearer,
  unauthorizedAuthenticate,
  type RelayOAuth,
} from "./oauth-http.js";

const TOOLS = [
  {
    name: "enroll_status",
    description: "Public muse enrollment view plus Mac link and Runtime liveness",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "thread_read",
    description: "Read an allowlisted Thread without starting a Turn",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1 },
        view: { type: "string", enum: ["result", "messages"] },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "thread_wait",
    description: "Wait until an allowlisted Thread is terminal or timeoutMs elapses",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1, maximum: RELAY_WAIT_TIMEOUT_MAX_MS },
        view: { type: "string", enum: ["result", "messages"] },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "thread_send",
    description: "Start a new Turn on an idle allowlisted Thread. Busy returns THREAD_BUSY.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1, maxLength: RELAY_MAX_BODY_BYTES },
      },
      required: ["threadId", "message"],
      additionalProperties: false,
    },
  },
] as const;

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extra?: Record<string, string>,
): void {
  response.writeHead(status, { "content-type": "application/json", ...extra });
  response.end(`${JSON.stringify(value)}\n`);
}

function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(code: string, message: string, details?: Record<string, unknown>): unknown {
  const error = details === undefined ? { code, message } : { code, message, details };
  return {
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    isError: true,
    structuredContent: { error },
  };
}

function toolResult(value: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function offlineError(): unknown {
  return toolError("RUNTIME_UNREACHABLE", "Mac link is not connected", {
    reason: "mac_link_offline",
  });
}

function mapStatus(body: unknown): RelayEnrollStatusResult | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const pairing =
    record.pairing === "machine" || record.pairing === "session" ? record.pairing : undefined;
  if (
    typeof record.clientId !== "string" ||
    pairing === undefined ||
    typeof record.expiresAt !== "string" ||
    typeof record.threadId !== "string" ||
    !Array.isArray(record.allowlist)
  ) {
    return undefined;
  }
  const parsed = relayEnrollStatusResultSchema.safeParse({
    clientId: record.clientId,
    pairing,
    expiresAt: record.expiresAt,
    allowlist: record.allowlist,
    threadId: record.threadId,
    link: "online",
    runtime: "reachable",
  });
  return parsed.success ? parsed.data : undefined;
}

async function readBodyString(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > RELAY_MAX_BODY_BYTES) throw new Error("too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function callMac(
  links: LinkListener,
  route: RelayAllowedRoute,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<RelayLinkReply> {
  const session = links.session();
  if (!session) {
    return {
      requestId: "offline",
      error: {
        code: "RUNTIME_UNREACHABLE",
        message: "Mac link is not connected",
        details: { reason: "mac_link_offline" },
      },
    };
  }
  return session.send({
    deadlineMs: Date.now() + timeoutMs,
    route,
    body,
  });
}

function replyToTool(reply: RelayLinkReply, route: RelayAllowedRoute): unknown {
  const reason =
    reply.error?.details && typeof reply.error.details === "object"
      ? (reply.error.details as { reason?: unknown }).reason
      : undefined;
  if (reason === "mac_link_offline") return offlineError();
  if (reply.error) {
    const details =
      reply.error.details && typeof reply.error.details === "object"
        ? (reply.error.details as Record<string, unknown>)
        : undefined;
    return toolError(reply.error.code, reply.error.message, details);
  }
  if (route === "/v1/enroll/status") {
    const mapped = mapStatus(reply.body);
    if (!mapped) {
      return toolError(
        "RUNTIME_UNREACHABLE",
        "Mac Runtime returned an unreadable enrollment status",
      );
    }
    return toolResult(mapped);
  }
  if (typeof reply.body === "object" && reply.body !== null && "error" in reply.body) {
    const error = (
      reply.body as { error?: { code?: unknown; message?: unknown; details?: unknown } }
    ).error;
    if (error && typeof error.code === "string") {
      const details =
        error.details && typeof error.details === "object"
          ? (error.details as Record<string, unknown>)
          : undefined;
      return toolError(
        error.code,
        typeof error.message === "string" ? error.message : "Runtime request failed",
        details,
      );
    }
  }
  return toolResult(reply.body);
}

async function callTool(links: LinkListener, name: string, args: unknown): Promise<unknown> {
  if (!RELAY_MCP_TOOL_NAMES.includes(name as (typeof RELAY_MCP_TOOL_NAMES)[number])) {
    return toolError("UNAUTHORIZED_TARGET", "This tool is not exposed");
  }
  if (!links.session()) return offlineError();
  if (name === "enroll_status") {
    const parsed = relayEnrollStatusInputSchema.safeParse(args ?? {});
    if (!parsed.success) return toolError("INVALID_ARGUMENT", "Invalid enroll_status arguments");
    const reply = await callMac(links, "/v1/enroll/status", {}, RELAY_OFFLINE_TIMEOUT_MS + 5_000);
    return replyToTool(reply, "/v1/enroll/status");
  }
  if (name === "thread_read") {
    const parsed = relayThreadReadInputSchema.safeParse(args);
    if (!parsed.success) return toolError("INVALID_ARGUMENT", "Invalid thread_read arguments");
    const reply = await callMac(
      links,
      "/v1/thread/read",
      { ...parsed.data, view: parsed.data.view ?? "result" },
      RELAY_UPSTREAM_TIMEOUT_MS,
    );
    return replyToTool(reply, "/v1/thread/read");
  }
  if (name === "thread_wait") {
    const parsed = relayThreadWaitInputSchema.safeParse(args);
    if (!parsed.success) return toolError("INVALID_ARGUMENT", "Invalid thread_wait arguments");
    const timeoutMs = parsed.data.timeoutMs ?? RELAY_WAIT_TIMEOUT_MAX_MS;
    const reply = await callMac(
      links,
      "/v1/thread/wait",
      { ...parsed.data, view: parsed.data.view ?? "result", timeoutMs },
      timeoutMs + 1_000,
    );
    return replyToTool(reply, "/v1/thread/wait");
  }
  const parsed = relayThreadSendInputSchema.safeParse(args);
  if (!parsed.success) return toolError("INVALID_ARGUMENT", "Invalid thread_send arguments");
  const reply = await callMac(
    links,
    "/v1/thread/send",
    parsed.data as unknown as Record<string, unknown>,
    RELAY_UPSTREAM_TIMEOUT_MS,
  );
  return replyToTool(reply, "/v1/thread/send");
}

function writeMcpUnauthorized(response: ServerResponse, oauth: RelayOAuth, revoked: boolean): void {
  writeJson(
    response,
    401,
    { error: "invalid_token" },
    { "www-authenticate": unauthorizedAuthenticate(oauth.issuer, revoked) },
  );
}

export async function listenEnrolledMcp(input: {
  listen: string;
  port: number;
  links: LinkListener;
  oauthRef?: { current?: RelayOAuth };
}): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      const oauth = input.oauthRef?.current;
      let rawBody = "";
      if (request.method !== "GET" && request.method !== "HEAD") {
        try {
          rawBody = await readBodyString(request);
        } catch {
          writeJson(response, 400, rpcError(null, -32700, "Parse error"));
          return;
        }
      }
      if (oauth && handleOAuthRequest(request, response, rawBody, oauth)) return;
      if (path !== "/mcp") {
        writeJson(response, 404, { error: { code: "UNAUTHORIZED_TARGET", message: "Not found" } });
        return;
      }
      if (oauth) {
        const bearer = inspectMcpBearer(request.headers.authorization, oauth);
        if (!bearer.ok) {
          writeMcpUnauthorized(response, oauth, bearer.revoked);
          return;
        }
      }
      if (request.method !== "POST") {
        writeJson(response, 404, { error: { code: "UNAUTHORIZED_TARGET", message: "Not found" } });
        return;
      }
      let parsed: unknown;
      try {
        parsed = rawBody.trim() ? (JSON.parse(rawBody) as unknown) : undefined;
      } catch {
        writeJson(response, 400, rpcError(null, -32700, "Parse error"));
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        writeJson(response, 400, rpcError(null, -32600, "Invalid request"));
        return;
      }
      const message = parsed as {
        jsonrpc?: unknown;
        id?: unknown;
        method?: unknown;
        params?: unknown;
      };
      if (typeof message.method !== "string") {
        writeJson(response, 400, rpcError(message.id ?? null, -32600, "Invalid request"));
        return;
      }
      if (message.method.startsWith("notifications/")) {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "initialize") {
        writeJson(
          response,
          200,
          rpcResult(message.id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "codexhost-relay", version: "0.0.0" },
          }),
        );
        return;
      }
      if (message.method === "ping") {
        writeJson(response, 200, rpcResult(message.id, {}));
        return;
      }
      if (message.method === "tools/list") {
        writeJson(response, 200, rpcResult(message.id, { tools: TOOLS }));
        return;
      }
      if (message.method === "tools/call") {
        const params = message.params;
        const name =
          typeof params === "object" && params !== null
            ? (params as { name?: unknown }).name
            : undefined;
        const args =
          typeof params === "object" && params !== null
            ? (params as { arguments?: unknown }).arguments
            : undefined;
        if (typeof name !== "string") {
          writeJson(
            response,
            200,
            rpcResult(message.id, toolError("INVALID_ARGUMENT", "Tool name is required")),
          );
          return;
        }
        const result = await callTool(input.links, name, args ?? {});
        writeJson(response, 200, rpcResult(message.id, result));
        return;
      }
      writeJson(response, 200, rpcError(message.id ?? null, -32601, "Method not found"));
    })().catch(() => {
      if (!response.headersSent) writeJson(response, 500, rpcError(null, -32603, "Internal error"));
      else response.destroy();
    });
  });
  const port = await bindListeningPort(server, input.port, input.listen);
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
