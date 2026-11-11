import { z } from "zod";

/** v1 hop serves this enrollment client only. */
export const RELAY_ENROLLMENT_CLIENT_ID = "muse";

export const RELAY_LINK_PROTOCOL_VERSION = 1;
export const RELAY_DEFAULT_HOP_IPV4 = "100.118.12.90";
export const RELAY_DEFAULT_MCP_LISTEN = "127.0.0.1";
export const RELAY_DEFAULT_LINK_LISTEN = RELAY_DEFAULT_HOP_IPV4;
export const RELAY_DEFAULT_LINK_PORT = 4401;
export const RELAY_DEFAULT_MCP_PORT = 4400;
export const RELAY_PUBLIC_ORIGIN = "https://codexhost.karldigi.dev";
export const RELAY_PUBLIC_RESOURCE = `${RELAY_PUBLIC_ORIGIN}/mcp`;
export const RELAY_WAIT_TIMEOUT_MAX_MS = 25_000;
export const RELAY_UPSTREAM_TIMEOUT_MS = 30_000;
export const RELAY_OFFLINE_TIMEOUT_MS = 2_000;
export const RELAY_MAX_BODY_BYTES = 2 * 1024 * 1024;

export const RELAY_ALLOWED_ROUTES = [
  "/v1/enroll/status",
  "/v1/thread/read",
  "/v1/thread/wait",
  "/v1/thread/send",
] as const;

export type RelayAllowedRoute = (typeof RELAY_ALLOWED_ROUTES)[number];

export const RELAY_MCP_TOOL_NAMES = [
  "enroll_status",
  "thread_read",
  "thread_wait",
  "thread_send",
] as const;

export type RelayMcpToolName = (typeof RELAY_MCP_TOOL_NAMES)[number];

export const relayLinkHelloSchema = z.strictObject({
  v: z.literal(RELAY_LINK_PROTOCOL_VERSION),
  secret: z.string().min(1).max(4096),
});

export const relayLinkHelloAckSchema = z.strictObject({
  v: z.literal(RELAY_LINK_PROTOCOL_VERSION),
  ok: z.literal(true),
});

export const relayLinkRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  deadlineMs: z.number().int().positive(),
  route: z.enum(RELAY_ALLOWED_ROUTES),
  body: z.record(z.string(), z.unknown()),
});

export const relayLinkErrorSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().max(2048),
  details: z.unknown().optional(),
});

export const relayLinkReplySchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  status: z.number().int().min(100).max(599).optional(),
  body: z.unknown().optional(),
  error: relayLinkErrorSchema.optional(),
});

export const relayThreadReadInputSchema = z.strictObject({
  threadId: z.string().min(1),
  view: z.enum(["result", "messages"]).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const relayThreadWaitInputSchema = z.strictObject({
  threadId: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(RELAY_WAIT_TIMEOUT_MAX_MS).optional(),
  view: z.enum(["result", "messages"]).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const relayThreadSendInputSchema = z.strictObject({
  threadId: z.string().min(1),
  message: z.string().min(1).max(RELAY_MAX_BODY_BYTES),
});

export const relayEnrollStatusInputSchema = z.strictObject({});

export const relayEnrollStatusResultSchema = z.strictObject({
  clientId: z.string().min(1),
  pairing: z.enum(["machine", "session"]),
  expiresAt: z.string().min(1),
  allowlist: z.array(
    z.strictObject({
      threadId: z.string().min(1),
      verbs: z.array(z.string().min(1)).min(1),
    }),
  ),
  threadId: z.string().min(1),
  link: z.enum(["online", "offline"]),
  runtime: z.enum(["reachable", "unreachable"]),
});

export type RelayLinkHello = z.infer<typeof relayLinkHelloSchema>;
export type RelayLinkHelloAck = z.infer<typeof relayLinkHelloAckSchema>;
export type RelayLinkRequest = z.infer<typeof relayLinkRequestSchema>;
export type RelayLinkReply = z.infer<typeof relayLinkReplySchema>;
export type RelayEnrollStatusResult = z.infer<typeof relayEnrollStatusResultSchema>;
