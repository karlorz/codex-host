import { readFile, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  EXTERNAL_MCP_DISPATCH_ROUTES,
  RELAY_ALLOWED_ROUTES,
  RELAY_DEFAULT_HOP_IPV4,
  RELAY_DEFAULT_LINK_PORT,
  RELAY_ENROLLMENT_CLIENT_ID,
  RELAY_LINK_PROTOCOL_VERSION,
  RELAY_MAX_BODY_BYTES,
  RELAY_UPSTREAM_TIMEOUT_MS,
  relayLinkHelloAckSchema,
  relayLinkRequestSchema,
  type RelayLinkReply,
} from "@codexhost/shared-contracts";

import {
  isTailscaleIPv4,
  parseEnrollmentClientId,
  type EnrollmentRecord,
} from "./client-enrollment.js";
import {
  enrollmentStorePath,
  isPrivateFileMode,
  readEnrollmentStore,
} from "./client-enrollment-store.js";
import {
  readLiveEnrollmentEndpoint,
  rejectEnrollmentAttackOptions,
} from "./delegation-cli-enrollment.js";
import type { DelegationCliArguments } from "./delegation-cli-options.js";
import { DelegationControlError } from "./delegation-types.js";
import { ExternalClientRegistry, defaultExternalClientsPath } from "./external-clients.js";
import { attachJsonl, writeJsonl } from "./relay-link-jsonl.js";

const LEGACY_ALLOWED = new Set<string>(RELAY_ALLOWED_ROUTES);
const DISPATCH_ALLOWED = new Set<string>(EXTERNAL_MCP_DISPATCH_ROUTES);

function stampLegacyEnrollmentBody(
  callerThreadId: string,
  route: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...body };
  if (route === "/v1/thread/read" || route === "/v1/thread/wait" || route === "/v1/thread/send") {
    next.callerThreadId = callerThreadId;
    if (route !== "/v1/thread/send" && next.view === undefined) next.view = "result";
  }
  return next;
}

function assertHopAddress(value: string): string {
  if (value === "127.0.0.1" || isTailscaleIPv4(value)) return value;
  throw new DelegationControlError(
    "INVALID_ARGUMENT",
    "--hop must be 127.0.0.1 or a Tailscale IPv4 address (100.64.0.0/10)",
  );
}

function positivePort(value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  const port = /^[0-9]+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new DelegationControlError("INVALID_ARGUMENT", "--port must be a TCP port");
  }
  return port;
}

async function readLinkSecret(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--link-secret-file must be an absolute path",
    );
  }
  const info = await stat(filePath);
  if (!info.isFile() || (!isPrivateFileMode(info.mode) && process.platform !== "win32")) {
    throw new DelegationControlError("ENROLLMENT_INVALID", "Link secret file must be mode 600");
  }
  const secret = (await readFile(filePath, "utf8")).trim();
  if (!secret) throw new DelegationControlError("ENROLLMENT_INVALID", "Link secret file is empty");
  return secret;
}

export async function handleRelayLinkRequest(input: {
  record: EnrollmentRecord;
  request: {
    requestId: string;
    deadlineMs: number;
    route: string;
    body: Record<string, unknown>;
    operationalClient?: string;
    oauthClientId?: string;
    dispatchGrant?: "legacy-four" | "full-dispatch";
  };
  resolveUpstream: () => Promise<string>;
  clients?: ExternalClientRegistry;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<RelayLinkReply> {
  const now = input.now ?? Date.now;
  const operationalClient = input.request.operationalClient;
  const hopGrant = input.request.dispatchGrant ?? "legacy-four";
  const named =
    operationalClient && input.clients ? await input.clients.record(operationalClient) : undefined;
  const fullDispatch = hopGrant === "full-dispatch" && named?.dispatchGrant === "full-dispatch";
  const allowed = fullDispatch ? DISPATCH_ALLOWED : LEGACY_ALLOWED;
  if (!allowed.has(input.request.route)) {
    return {
      requestId: input.request.requestId,
      status: 403,
      body: {
        error: {
          code: "UNAUTHORIZED_TARGET",
          message: "This route is unavailable over the enrolled relay",
        },
      },
    };
  }
  if (input.request.body.hostId !== undefined) {
    return {
      requestId: input.request.requestId,
      status: 403,
      body: {
        error: {
          code: "UNAUTHORIZED_TARGET",
          message: "hostId is rejected on the enrolled relay",
        },
      },
    };
  }
  const body = fullDispatch
    ? { ...input.request.body }
    : stampLegacyEnrollmentBody(input.record.threadId, input.request.route, input.request.body);
  const remaining = input.request.deadlineMs - now();
  if (remaining <= 0) {
    return {
      requestId: input.request.requestId,
      error: { code: "outcome_unknown", message: "Deadline already passed" },
    };
  }
  const timeoutMs = Math.min(RELAY_UPSTREAM_TIMEOUT_MS, remaining);
  let posted = false;
  try {
    const upstream = await input.resolveUpstream();
    posted = true;
    const result = await (input.fetchImpl ?? fetch)(
      new URL(fullDispatch ? "/v1/external/dispatch" : input.request.route, upstream),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.record.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          fullDispatch
            ? {
                client: operationalClient,
                route: input.request.route,
                body,
                ...(input.request.oauthClientId
                  ? { oauthClientId: input.request.oauthClientId }
                  : {}),
              }
            : body,
        ),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const text = await result.text();
    if (text.length > RELAY_MAX_BODY_BYTES) {
      return {
        requestId: input.request.requestId,
        error: { code: "INVALID_ARGUMENT", message: "Runtime response is too large" },
      };
    }
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { error: { code: "RUNTIME_UNREACHABLE", message: "Runtime response is not JSON" } };
    }
    return { requestId: input.request.requestId, status: result.status, body: parsed };
  } catch (error) {
    if (posted) {
      return {
        requestId: input.request.requestId,
        error: {
          code: "outcome_unknown",
          message: "Link or deadline failed after the Mac posted upstream",
          details: { cause: error instanceof Error ? error.message : String(error) },
        },
      };
    }
    return {
      requestId: input.request.requestId,
      status: 502,
      body: {
        error: {
          code: "RUNTIME_UNREACHABLE",
          message: "The enrolled Mac Runtime could not be reached",
        },
      },
    };
  }
}

export function serveRelayLinkSocket(input: {
  socket: Socket;
  record: EnrollmentRecord;
  secret: string;
  resolveUpstream: () => Promise<string>;
  clients?: ExternalClientRegistry;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  return new Promise((resolve) => {
    let helloSent = false;
    const finish = () => {
      input.socket.destroy();
      resolve();
    };
    attachJsonl(
      input.socket,
      (value) => {
        if (!helloSent) {
          const ack = relayLinkHelloAckSchema.safeParse(value);
          if (!ack.success) {
            finish();
            return;
          }
          helloSent = true;
          return;
        }
        const parsed = relayLinkRequestSchema.safeParse(value);
        if (!parsed.success) {
          finish();
          return;
        }
        void handleRelayLinkRequest({
          record: input.record,
          request: {
            requestId: parsed.data.requestId,
            deadlineMs: parsed.data.deadlineMs,
            route: parsed.data.route,
            body: parsed.data.body,
            ...(parsed.data.operationalClient
              ? { operationalClient: parsed.data.operationalClient }
              : {}),
            ...(parsed.data.oauthClientId ? { oauthClientId: parsed.data.oauthClientId } : {}),
            ...(parsed.data.dispatchGrant ? { dispatchGrant: parsed.data.dispatchGrant } : {}),
          },
          resolveUpstream: input.resolveUpstream,
          ...(input.clients ? { clients: input.clients } : {}),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }).then((reply) => {
          if (input.socket.destroyed) return;
          writeJsonl(input.socket, reply);
        });
      },
      finish,
    );
    input.socket.on("close", resolve);
    input.socket.on("error", finish);
    writeJsonl(input.socket, { v: RELAY_LINK_PROTOCOL_VERSION, secret: input.secret });
  });
}

export async function runEnrollmentRelayLink(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  output: Writable;
  connect?: (hop: string, port: number) => Promise<Socket>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const options = input.parsed.options;
  const clientOption = options.get("--client");
  if (!clientOption) {
    throw new DelegationControlError("INVALID_ARGUMENT", "--client is required");
  }
  const clientId = parseEnrollmentClientId(clientOption);
  if (clientId !== RELAY_ENROLLMENT_CLIENT_ID) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "enroll relay-link serves client muse only",
    );
  }
  const hop = assertHopAddress(options.get("--hop") ?? RELAY_DEFAULT_HOP_IPV4);
  const port = positivePort(options.get("--port"), RELAY_DEFAULT_LINK_PORT);
  const secretFile = options.get("--link-secret-file") ?? "";
  const secret = await readLinkSecret(secretFile);
  const record = await readEnrollmentStore(
    enrollmentStorePath(input.environment, clientId),
    Date.now(),
    clientId,
  );
  if (!record) throw new DelegationControlError("ENROLLMENT_INVALID", "Enroll this client first");
  const socket = input.connect
    ? await input.connect(hop, port)
    : await new Promise<Socket>((resolve, reject) => {
        const connection = createConnection({ host: hop, port }, () => resolve(connection));
        connection.once("error", reject);
      });
  input.output.write(
    `${JSON.stringify({ clientId, hop, port, pid: process.pid, state: "connected" })}\n`,
  );
  const stop = () => socket.destroy();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await serveRelayLinkSocket({
      socket,
      record,
      secret,
      clients: new ExternalClientRegistry(defaultExternalClientsPath(input.environment)),
      resolveUpstream: async () =>
        (await readLiveEnrollmentEndpoint(input.environment)) ?? record.endpoint,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    socket.destroy();
  }
}
