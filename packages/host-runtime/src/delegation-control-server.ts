import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { EnrollmentAuthority, EnrollmentPrincipal } from "./client-enrollment-authority.js";
import {
  parseEnrollmentPairing,
  type EnrollmentAllowlistEntry,
  type EnrollmentRequestAction,
} from "./client-enrollment.js";
import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationStartInput,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessListInput,
  type ThreadCancelInput,
  type ThreadListInput,
  type ThreadSendInput,
  type ThreadReadInput,
  type ThreadWaitInput,
  type ThreadWatchInput,
} from "./delegation-types.js";
import { matchesBearerToken } from "./bearer-token.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function annotateEnrollmentBusy(
  error: unknown,
  principal: EnrollmentPrincipal | undefined,
): unknown {
  if (
    !(error instanceof DelegationControlError) ||
    error.code !== "THREAD_BUSY" ||
    principal?.kind !== "enrollment"
  ) {
    return error;
  }
  return new DelegationControlError(error.code, error.message, {
    ...error.details,
    authorized: true,
  });
}

export function errorBody(error: unknown): {
  error: { code: string; message: string; details?: unknown };
} {
  if (error instanceof DelegationControlError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function enrollmentHttpStatus(error: unknown): number {
  if (!(error instanceof DelegationControlError)) return 500;
  if (error.code === "UNAUTHORIZED_TARGET" || error.code === "ENROLLMENT_DENIED") return 403;
  if (error.code === "ENROLLMENT_INVALID") return 401;
  return 400;
}

function enrollmentActionForRoute(
  url: string | undefined,
  body: Record<string, unknown>,
): EnrollmentRequestAction {
  switch (url) {
    case "/v1/thread/send":
      return { type: "send", threadId: String(body.threadId ?? "") };
    case "/v1/thread/cancel":
      return { type: "cancel", threadId: String(body.threadId ?? "") };
    case "/v1/thread/read":
      return { type: "read", threadId: String(body.threadId ?? "") };
    case "/v1/thread/wait":
      return { type: "wait", threadId: String(body.threadId ?? "") };
    case "/v1/thread/watch":
      return {
        type: "watch",
        threadId: String(body.threadId ?? ""),
        notifyThreadId: String(body.notifyThreadId ?? ""),
      };
    case "/v1/thread/watches":
      return { type: "watches" };
    case "/v1/thread/list":
      return { type: "list" };
    case "/v1/delegate/start":
      return { type: "delegate" };
    default:
      return { type: "harness" };
  }
}

function authenticateControlRequest(
  header: string | undefined,
  hostToken: string,
  enrollment: EnrollmentAuthority | undefined,
): EnrollmentPrincipal | undefined {
  if (enrollment) return enrollment.authenticate(header);
  return matchesBearerToken(header, hostToken) ? { kind: "host" } : undefined;
}

export async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES)
      throw new DelegationControlError("INVALID_ARGUMENT", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Request body must be a JSON object");
  }
}

export interface DelegationControlServer {
  endpoint: string;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function watchApi(api: DelegationWatchApi | undefined): DelegationWatchApi {
  if (!api)
    throw new DelegationControlError("INVALID_ARGUMENT", "This Runtime does not support watches");
  return api;
}

/** The Turn already started, so a watch failure is reported beside it, not thrown. */
function watchStartedTurn(watches: DelegationWatchApi, input: ThreadWatchInput) {
  return watches.watch(input).catch((error: unknown) => ({
    state: "notRegistered" as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
}

/** `delegate start --watch`: the Host-resolved parent is the notified Thread. */
async function startWithWatch(
  api: DelegationControlApi,
  watches: DelegationWatchApi,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { watchTimeoutMs, ...start } = body;
  const result = await api.start(start as unknown as DelegationStartInput);
  const watch = await watchStartedTurn(watches, {
    threadId: result.threadId,
    notifyThreadId: result.parentThreadId ?? "",
    timeoutMs: watchTimeoutMs as number,
  });
  return { ...result, watch };
}

/** The delegation routes shared by the Host control server and the external client listener. */
export async function routeDelegationRequest(
  handlers: { api: DelegationControlApi; watchApi?: DelegationWatchApi },
  route: string | undefined,
  body: Record<string, unknown>,
): Promise<unknown> {
  switch (route) {
    case "/v1/harness/list":
      return handlers.api.listHarnesses(body as HarnessListInput);
    case "/v1/harness/inspect":
      return handlers.api.inspect(body as unknown as HarnessInspectInput);
    case "/v1/delegate/start":
      return body.watchTimeoutMs === undefined
        ? handlers.api.start(body as unknown as DelegationStartInput)
        : startWithWatch(handlers.api, watchApi(handlers.watchApi), body);
    case "/v1/thread/send":
      return handlers.api.send(body as unknown as ThreadSendInput);
    case "/v1/thread/cancel":
      return handlers.api.cancel(body as unknown as ThreadCancelInput);
    case "/v1/thread/read":
      return handlers.api.read(body as unknown as ThreadReadInput);
    case "/v1/thread/wait":
      return handlers.api.wait(body as unknown as ThreadWaitInput);
    case "/v1/thread/watch":
      return watchApi(handlers.watchApi).watch(body as unknown as ThreadWatchInput);
    case "/v1/thread/watches":
      return watchApi(handlers.watchApi).watches();
    case "/v1/thread/list":
      return handlers.api.list(body as unknown as ThreadListInput);
    default:
      throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
  }
}

export async function startDelegationControlServer(input: {
  token: string;
  api: DelegationControlApi;
  watchApi?: DelegationWatchApi;
  enrollment?: EnrollmentAuthority;
}): Promise<DelegationControlServer> {
  const server = createServer((request, response) => {
    let principal: EnrollmentPrincipal | undefined;
    void (async () => {
      if (request.method !== "POST") {
        writeJson(response, 405, {
          error: { code: "INVALID_ARGUMENT", message: "POST is required" },
        });
        return;
      }
      if (request.url === "/v1/enroll") {
        if (!input.enrollment) {
          writeJson(response, 401, {
            error: { code: "RUNTIME_UNREACHABLE", message: "Runtime token is invalid" },
          });
          return;
        }
        const hostPrincipal =
          input.enrollment.authenticate(request.headers.authorization)?.kind === "host";
        const bootstrapOk = input.enrollment.matchesBootstrap(request.headers.authorization);
        if (!hostPrincipal && !bootstrapOk) {
          writeJson(response, 401, {
            error: { code: "RUNTIME_UNREACHABLE", message: "Runtime token is invalid" },
          });
          return;
        }
        const enrollBody = await jsonBody(request);
        const pairing = parseEnrollmentPairing(enrollBody.pairing);
        const record = await input.enrollment.enroll({
          clientId: String(enrollBody.clientId ?? ""),
          executablePath: String(enrollBody.executablePath ?? ""),
          ...(Array.isArray(enrollBody.allowlist)
            ? { allowlist: enrollBody.allowlist as EnrollmentAllowlistEntry[] }
            : {}),
          pairing,
          attendedHostApprove: hostPrincipal,
        });
        writeJson(response, 200, record);
        return;
      }
      principal = authenticateControlRequest(
        request.headers.authorization,
        input.token,
        input.enrollment,
      );
      if (!principal) {
        writeJson(response, 401, {
          error: { code: "RUNTIME_UNREACHABLE", message: "Runtime token is invalid" },
        });
        return;
      }
      const body = await jsonBody(request);
      if (request.url === "/v1/enroll/revoke") {
        if (!input.enrollment) {
          throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
        }
        const revoked = await input.enrollment.revoke(request.headers.authorization);
        writeJson(response, 200, { enrollmentId: revoked.enrollmentId, revoked: true });
        return;
      }
      if (request.url === "/v1/enroll/status") {
        if (!input.enrollment) {
          throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
        }
        writeJson(response, 200, input.enrollment.status(request.headers.authorization));
        return;
      }
      if (principal.kind === "enrollment") {
        if (!input.enrollment) {
          throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
        }
        input.enrollment.authorize(principal.record, enrollmentActionForRoute(request.url, body));
      }
      const result = await routeDelegationRequest(input, request.url, body);
      if (request.url === "/v1/thread/watches") {
        writeJson(
          response,
          200,
          principal.kind === "enrollment" && input.enrollment
            ? input.enrollment.filterWatches(principal.record, result as never)
            : result,
        );
        return;
      }
      if (request.url === "/v1/thread/list") {
        writeJson(
          response,
          200,
          principal.kind === "enrollment" && input.enrollment
            ? input.enrollment.filterList(principal.record, result as never)
            : result,
        );
        return;
      }
      writeJson(response, 200, result);
    })().catch((error) => {
      const annotated = annotateEnrollmentBusy(error, principal);
      writeJson(response, enrollmentHttpStatus(annotated), errorBody(annotated));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}
