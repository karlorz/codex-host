import { createServer, type Server } from "node:http";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { matchesBearerToken } from "./bearer-token.js";
import {
  assertEnrollmentBindings,
  assertLoopbackHttpUrl,
  assertTailnetHttpUrl,
  isDecoratedHttpOrigin,
  parseEnrollmentClientId,
  verifyEnrollmentRecord,
  type EnrollmentRecord,
} from "./client-enrollment.js";
import { enrollmentStorePath, readEnrollmentStore } from "./client-enrollment-store.js";
import {
  readLiveEnrollmentEndpoint,
  rejectEnrollmentAttackOptions,
} from "./delegation-cli-enrollment.js";
import type { DelegationCliArguments } from "./delegation-cli-options.js";
import { DelegationControlError } from "./delegation-types.js";

const ROUTES = new Set([
  "/v1/thread/read",
  "/v1/thread/send",
  "/v1/enroll/status",
  "/v1/enroll/revoke",
]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_ENROLLMENT_SERVE_TIMER_MS = 2_147_483_647;

function assertServeLoopbackOrigin(value: string): URL {
  const upstream = assertLoopbackHttpUrl(value);
  if (isDecoratedHttpOrigin(upstream)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Serve requires a local enrollment endpoint",
    );
  }
  return upstream;
}

/** `undefined` means do not arm a timer: already expired, or longer than Node's 32-bit delay. */
export function enrollmentServeExpiryDelayMs(
  expiresAt: string,
  nowMs = Date.now(),
): number | undefined {
  const remaining = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > MAX_ENROLLMENT_SERVE_TIMER_MS) {
    return undefined;
  }
  return remaining;
}

/** One client bearer; upstream is the live loopback Runtime, not Host or bootstrap authority. */
export function createEnrollmentTailnetServer(
  record: EnrollmentRecord,
  resolveUpstream?: () => Promise<string>,
): Server {
  verifyEnrollmentRecord(record, Date.now());
  if (record.networkScope) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Serve requires a local enrollment endpoint",
    );
  }
  assertServeLoopbackOrigin(record.endpoint);
  const server = createServer((request, response) => {
    const fail = (status: number, code: string, message: string) => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ error: { code, message } }));
    };
    void (async () => {
      if (!matchesBearerToken(request.headers.authorization, record.token)) {
        fail(401, "ENROLLMENT_INVALID", "Client enrollment token is required");
        return;
      }
      verifyEnrollmentRecord(record, Date.now());
      const route = request.url ?? "";
      if (request.method !== "POST" || !ROUTES.has(route)) {
        fail(403, "UNAUTHORIZED_TARGET", "This route is unavailable over tailnet enrollment");
        return;
      }
      request.setTimeout(15_000, () => request.destroy());
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          fail(413, "INVALID_ARGUMENT", "Request body is too large");
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        fail(400, "INVALID_ARGUMENT", "Request body must be a JSON object");
        return;
      }
      if (route === "/v1/thread/read") {
        if (body.hostId !== undefined) {
          fail(403, "UNAUTHORIZED_TARGET", "Tailnet enrollment reads only this Mac Runtime");
          return;
        }
        body.callerThreadId = record.threadId;
      }
      const upstream = assertServeLoopbackOrigin(
        resolveUpstream ? await resolveUpstream() : record.endpoint,
      );
      const result = await fetch(new URL(route, upstream), {
        method: "POST",
        headers: { authorization: `Bearer ${record.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      if (result.body) await pipeline(result.body, response);
      else response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else if (error instanceof DelegationControlError) fail(401, error.code, error.message);
      else fail(502, "RUNTIME_UNREACHABLE", "The enrolled Mac Runtime could not be reached");
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

export async function runEnrollmentTailnetServe(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  output: Writable;
}): Promise<void> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const options = input.parsed.options;
  const clientId = parseEnrollmentClientId(options.get("--client") ?? "");
  const listen = options.get("--listen") ?? "";
  const portValue = options.get("--port") ?? "4398";
  const port = /^[0-9]+$/u.test(portValue) ? Number(portValue) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--port must be a positive integer no greater than 65535",
    );
  }
  const endpoint = assertTailnetHttpUrl(`http://${listen}:${port}`).origin;
  const exportFile = options.get("--export-file");
  if (!exportFile || !path.isAbsolute(exportFile)) {
    throw new DelegationControlError("INVALID_ARGUMENT", "--export-file must be an absolute path");
  }
  const record = await readEnrollmentStore(
    enrollmentStorePath(input.environment, clientId),
    Date.now(),
    clientId,
  );
  if (!record) throw new DelegationControlError("ENROLLMENT_INVALID", "Enroll this client first");
  const server = createEnrollmentTailnetServer(
    record,
    async () => (await readLiveEnrollmentEndpoint(input.environment)) ?? record.endpoint,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, listen, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  try {
    await mkdir(path.dirname(exportFile), { recursive: true, mode: 0o700 });
    const owner = process.getuid?.();
    if (owner !== undefined) {
      const parent = await stat(path.dirname(exportFile));
      if ((parent.mode & 0o777) !== 0o700 || parent.uid !== owner) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Export directory must be owned by this user with mode 700",
        );
      }
    }
    const handoff: EnrollmentRecord = { ...record, endpoint, networkScope: "tailnet" };
    assertEnrollmentBindings(handoff);
    await writeFile(exportFile, `${JSON.stringify(handoff, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const delay = enrollmentServeExpiryDelayMs(record.expiresAt);
    if (delay !== undefined) expiry = setTimeout(stop, delay);
    input.output.write(
      `${JSON.stringify({ clientId, endpoint, exportFile, expiresAt: record.expiresAt, pid: process.pid })}\n`,
    );
    await closed;
  } finally {
    clearTimeout(expiry);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    stop();
    await closed;
  }
}
