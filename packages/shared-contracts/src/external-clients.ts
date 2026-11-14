import { z } from "zod";

/** Same-Mac and public-hop operational clients. Distinct from enrollment pairing. */
export const EXTERNAL_CLIENT_LIST_METHOD = "codexhost/external-clients/list";
export const EXTERNAL_CLIENT_CREATE_METHOD = "codexhost/external-clients/create";
export const EXTERNAL_CLIENT_UPDATE_METHOD = "codexhost/external-clients/update";
export const EXTERNAL_CLIENT_REVOKE_METHOD = "codexhost/external-clients/revoke";

export const EXTERNAL_CLIENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export const externalClientNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(EXTERNAL_CLIENT_NAME_PATTERN);

export const externalClientAccessSchema = z.enum(["all-threads", "selected-workspaces"]);
export const externalClientConnectionModeSchema = z.enum(["public-relay", "local", "direct"]);
export const externalClientDispatchGrantSchema = z.enum(["legacy-four", "full-dispatch"]);

export const EXTERNAL_MCP_TOOL_NAMES = [
  "harness_list",
  "harness_inspect",
  "delegate_start",
  "thread_read",
  "thread_wait",
  "thread_list",
  "thread_send",
  "thread_cancel",
  "thread_watch",
  "thread_watches",
  "events_poll",
] as const;

export type ExternalMcpToolName = (typeof EXTERNAL_MCP_TOOL_NAMES)[number];

export const EXTERNAL_MCP_DISPATCH_ROUTES = [
  "/v1/harness/list",
  "/v1/harness/inspect",
  "/v1/delegate/start",
  "/v1/thread/send",
  "/v1/thread/cancel",
  "/v1/thread/read",
  "/v1/thread/wait",
  "/v1/thread/watch",
  "/v1/thread/watches",
  "/v1/thread/list",
  "/v1/events/poll",
] as const;

export type ExternalMcpDispatchRoute = (typeof EXTERNAL_MCP_DISPATCH_ROUTES)[number];

const workspacePathSchema = z.string().trim().min(1).max(4096);
const directUrlSchema = z.string().trim().max(2048);

/** HTTPS /mcp, or HTTP /mcp on a Tailscale 100.64/10 address. Never loopback or plain LAN. */
export function isProtectedDirectMcpUrl(value: string): boolean {
  if (value.includes("?") || value.includes("#") || value.includes("@")) return false;
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/mcp\/?$/u.test(value)) return true;
  const match = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?\/mcp\/?$/u.exec(
    value,
  );
  if (!match) return false;
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  const second = octets[1] ?? -1;
  return (
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    second >= 64 &&
    second <= 127
  );
}

export const externalClientPublicViewSchema = z.strictObject({
  name: externalClientNameSchema,
  createdAt: z.string().min(1).max(64),
  access: externalClientAccessSchema,
  workspaces: z.array(workspacePathSchema).max(64),
  connectionMode: externalClientConnectionModeSchema,
  dispatchGrant: externalClientDispatchGrantSchema,
  oauthClientId: z.string().trim().min(1).max(128).optional(),
  directUrl: directUrlSchema.optional(),
  mcpUrl: z.string().min(1).max(2048).optional(),
  mcpUrlNote: z.string().min(1).max(512).optional(),
});

export const externalClientListParamsSchema = z.strictObject({});

export const externalClientListResultSchema = z.strictObject({
  clients: z.array(externalClientPublicViewSchema).max(256),
});

export const externalClientWriteFieldsSchema = z.strictObject({
  access: externalClientAccessSchema.optional(),
  workspaces: z.array(workspacePathSchema).max(64).optional(),
  connectionMode: externalClientConnectionModeSchema.optional(),
  dispatchGrant: externalClientDispatchGrantSchema.optional(),
  oauthClientId: z.string().trim().min(1).max(128).optional(),
  directUrl: directUrlSchema.optional(),
});

export const externalClientCreateParamsSchema = externalClientWriteFieldsSchema.extend({
  name: externalClientNameSchema,
});

export const externalClientCreateResultSchema = externalClientPublicViewSchema.extend({
  token: z.string().min(1).max(256).optional(),
});

export const externalClientUpdateParamsSchema = externalClientWriteFieldsSchema.extend({
  name: externalClientNameSchema,
  clearOauthClientId: z.literal(true).optional(),
});

export const externalClientRevokeParamsSchema = z.strictObject({
  name: externalClientNameSchema,
});

export const externalClientRevokeResultSchema = z.strictObject({
  name: externalClientNameSchema,
  revoked: z.literal(true),
});

export type ExternalClientAccess = z.infer<typeof externalClientAccessSchema>;
export type ExternalClientConnectionMode = z.infer<typeof externalClientConnectionModeSchema>;
export type ExternalClientDispatchGrant = z.infer<typeof externalClientDispatchGrantSchema>;
export type ExternalClientPublicView = z.infer<typeof externalClientPublicViewSchema>;
export type ExternalClientListResult = z.infer<typeof externalClientListResultSchema>;
export type ExternalClientCreateParams = z.infer<typeof externalClientCreateParamsSchema>;
export type ExternalClientCreateResult = z.infer<typeof externalClientCreateResultSchema>;
export type ExternalClientUpdateParams = z.infer<typeof externalClientUpdateParamsSchema>;
export type ExternalClientRevokeResult = z.infer<typeof externalClientRevokeResultSchema>;

const stringProp = (description: string) => ({ type: "string" as const, description });
const integerProp = (description: string) => ({
  type: "integer" as const,
  minimum: 0,
  description,
});
const threadProp = stringProp("Thread id or codex://threads/<id> link");

/** MCP tool descriptors for the shared 11-tool catalog. Browser-safe JSON Schema only. */
export const EXTERNAL_MCP_TOOL_DESCRIPTORS = [
  {
    name: "harness_list",
    description: "List the Harnesses this codexhost can delegate to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "harness_inspect",
    description:
      "Read a Harness's Models, Thinking options and defaults; use the returned ids when delegating.",
    inputSchema: {
      type: "object",
      properties: {
        harnessId: stringProp("Harness id from harness_list"),
        cwd: stringProp("Absolute workspace path"),
        refresh: { type: "boolean" },
      },
      required: ["harnessId"],
    },
  },
  {
    name: "delegate_start",
    description:
      "Start a task in a new Thread and return at once. Without parentThread the work belongs to this client and cwd is required. watch=true records an event for this client when the Thread stops (read it with events_poll or the SSE stream).",
    inputSchema: {
      type: "object",
      properties: {
        harnessId: stringProp("Harness id from harness_list"),
        task: stringProp("The full task text"),
        taskName: stringProp("Short display name"),
        cwd: stringProp("Absolute workspace path"),
        model: stringProp("Model id from harness_inspect"),
        thinking: stringProp("Thinking option id from harness_inspect"),
        parentThread: stringProp("Optional parent Thread"),
        requestId: stringProp("Reuse to retry idempotently"),
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Absolute URIs of where the work came from",
        },
        watch: { type: "boolean", description: "Record an event when the Thread stops" },
        watchTimeoutMs: integerProp("How long to watch; default 29 minutes"),
      },
      required: ["harnessId", "task"],
    },
  },
  {
    name: "thread_read",
    description:
      "Read a Thread's status and latest result, or page its visible messages (view=messages). Never changes the Thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread: threadProp,
        view: { type: "string", enum: ["result", "messages"] },
        cursor: stringProp("Message cursor"),
        limit: integerProp("Messages per page, at most 100"),
      },
      required: ["thread"],
    },
  },
  {
    name: "thread_wait",
    description:
      "Wait up to timeoutMs (at most 60000) for a Thread to stop, then return the same snapshot as thread_read plus timedOut.",
    inputSchema: {
      type: "object",
      properties: {
        thread: threadProp,
        timeoutMs: integerProp("At most 60000; default 30000"),
        view: { type: "string", enum: ["result", "messages"] },
      },
      required: ["thread"],
    },
  },
  {
    name: "thread_list",
    description:
      "List Threads: by workspace (cwd), by parent Thread, by the client that started them, or by reference.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: stringProp("Absolute workspace path"),
        parent: stringProp("Parent Thread"),
        client: stringProp("Client name"),
        ref: stringProp("Reference URI"),
        limit: integerProp("At most 100; default 25"),
        cursor: stringProp("Cursor from a previous page"),
        sort: {
          type: "string",
          enum: [
            "created-asc",
            "created-desc",
            "updated-asc",
            "updated-desc",
            "recency-asc",
            "recency-desc",
          ],
        },
      },
    },
  },
  {
    name: "thread_send",
    description:
      "Start a new Turn in an idle Thread. THREAD_BUSY means its current Turn is still running; messages are not queued.",
    inputSchema: {
      type: "object",
      properties: { thread: threadProp, message: stringProp("Message text") },
      required: ["thread", "message"],
    },
  },
  {
    name: "thread_cancel",
    description: "Cancel a Thread's active Turn, keeping the Thread and its history.",
    inputSchema: { type: "object", properties: { thread: threadProp }, required: ["thread"] },
  },
  {
    name: "thread_watch",
    description: "Record one event for this client when the Thread stops or the watch expires.",
    inputSchema: {
      type: "object",
      properties: { thread: threadProp, timeoutMs: integerProp("Default 29 minutes") },
      required: ["thread"],
    },
  },
  {
    name: "thread_watches",
    description: "List watches that have not been delivered yet.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "events_poll",
    description:
      "Read this client's events after a cursor (0 for all retained). Waits up to timeoutMs (at most 60000) for the first one. Pass the returned cursor back next time. CURSOR_EXPIRED: reconcile with thread_list client=<this client>.",
    inputSchema: {
      type: "object",
      properties: {
        after: integerProp("Cursor; 0 for all retained"),
        timeoutMs: integerProp("At most 60000; default 0"),
        limit: integerProp("At most 100"),
      },
    },
  },
] as const;
