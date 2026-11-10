import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EnrollmentAuthority } from "../src/client-enrollment-authority.js";
import { createStubEnrollmentConsent } from "../src/client-enrollment-consent.js";
import {
  createEnrollmentTailnetServer,
  enrollmentServeExpiryDelayMs,
  MAX_ENROLLMENT_SERVE_TIMER_MS,
} from "../src/client-enrollment-tailnet.js";
import {
  assertTailnetHttpUrl,
  MACHINE_ENROLLMENT_TTL_MS,
  verifyEnrollmentRecord,
} from "../src/client-enrollment.js";
import {
  enrollmentBootstrapPath,
  enrollmentStorePath,
  readEnrollmentBootstrap,
  writeEnrollmentBootstrap,
  writeEnrollmentStore,
} from "../src/client-enrollment-store.js";
import { resolveCliRuntimeConnection } from "../src/delegation-cli-enrollment.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import type { DelegationControlApi } from "../src/delegation-types.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codexhost-tailnet-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture() {
  const dataDirectory = await directory();
  const authority = new EnrollmentAuthority({
    hostToken: "host-secret",
    dataDirectory,
    consent: createStubEnrollmentConsent("approve"),
    createThread: async () => "native-thread",
  });
  const read = vi.fn(async (body) => ({ threadId: body.threadId, status: "completed" }));
  const send = vi.fn(async () => ({ accepted: true }));
  const runtime = await startDelegationControlServer({
    token: "host-secret",
    enrollment: authority,
    api: { read, send } as unknown as DelegationControlApi,
  });
  cleanup.push(() => runtime.close());
  await authority.publishBootstrap(runtime.endpoint);
  const record = await authority.enroll({
    clientId: "cursor-box-grok",
    executablePath: "/test/grok",
    allowlist: [{ threadId: "reviewer", verbs: ["read", "send"] }],
  });
  const endpoint = await listen(createEnrollmentTailnetServer(record));
  const post = (route: string, body: unknown = {}, token = record.token) =>
    fetch(`${endpoint}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return { record, read, send, post, dataDirectory };
}

describe("tailnet enrollment transport", () => {
  it("arms a serve timer only for delays Node can represent", () => {
    const now = Date.parse("2026-11-09T00:00:00.000Z");
    expect(enrollmentServeExpiryDelayMs(new Date(now + 60_000).toISOString(), now)).toBe(60_000);
    expect(
      enrollmentServeExpiryDelayMs(
        new Date(now + MAX_ENROLLMENT_SERVE_TIMER_MS).toISOString(),
        now,
      ),
    ).toBe(MAX_ENROLLMENT_SERVE_TIMER_MS);
    expect(
      enrollmentServeExpiryDelayMs(
        new Date(now + MAX_ENROLLMENT_SERVE_TIMER_MS + 1).toISOString(),
        now,
      ),
    ).toBeUndefined();
    expect(
      enrollmentServeExpiryDelayMs(new Date(now + MACHINE_ENROLLMENT_TTL_MS).toISOString(), now),
    ).toBeUndefined();
    expect(enrollmentServeExpiryDelayMs(new Date(now - 1).toISOString(), now)).toBeUndefined();
  });

  it("forwards to the live bootstrap loopback when the stored endpoint is stale", async () => {
    const { record, read, dataDirectory } = await fixture();
    const live = (
      await readEnrollmentBootstrap(enrollmentBootstrapPath({ CODEXHOST_DATA_DIR: dataDirectory }))
    ).endpoint;
    const endpoint = await listen(
      createEnrollmentTailnetServer(
        { ...record, endpoint: "http://127.0.0.1:1" },
        async () => live,
      ),
    );
    const response = await fetch(`${endpoint}/v1/thread/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${record.token}` },
      body: JSON.stringify({ threadId: "reviewer" }),
    });
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith({
      threadId: "reviewer",
      callerThreadId: record.threadId,
    });
  });

  it.each([
    "http://0.0.0.0:4398",
    "http://127.0.0.1:4398",
    "http://192.168.1.2:4398",
    "http://100.63.255.255:4398",
    "http://100.128.0.1:4398",
    "http://8.8.8.8:4398",
    "http://mac.tailnet:4398",
    "http://user:secret@100.64.0.1:4398",
    "http://100.64.0.1:4398/route",
    "http://100.64.0.1:4398/?query=1",
    "http://100.64.0.1:4398/#fragment",
    "https://100.64.0.1:4398",
  ])("rejects unsafe or unsupported endpoint %s", (endpoint) => {
    expect(() => assertTailnetHttpUrl(endpoint)).toThrow();
  });

  it("requires explicit tailnet scope and ignores the box-local bootstrap for read and revoke", async () => {
    const { record } = await fixture();
    const dataDirectory = await directory();
    const environment = {
      CODEXHOST_DATA_DIR: dataDirectory,
      CODEXHOST_ENROLL_CLIENT: record.clientId,
    };
    const remote = {
      ...record,
      endpoint: "http://100.94.152.93:4398",
      networkScope: "tailnet" as const,
    };
    expect(() =>
      verifyEnrollmentRecord({ ...record, endpoint: remote.endpoint }, Date.now()),
    ).toThrow();
    await writeEnrollmentStore(enrollmentStorePath(environment, record.clientId), remote);
    await writeEnrollmentBootstrap(enrollmentBootstrapPath(environment), {
      schemaVersion: 1,
      endpoint: "http://127.0.0.1:9999",
      bootstrapToken: "box-bootstrap",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    expect(
      await resolveCliRuntimeConnection({
        environment,
        nowMs: Date.now(),
        parsed: { options: new Map(), positionals: [] },
      }),
    ).toMatchObject({
      endpoint: remote.endpoint,
      token: record.token,
      callerThreadId: record.threadId,
    });
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }),
    );
    const code = await runDelegationCli({
      arguments: ["enroll", "revoke", "--client", record.clientId],
      environment,
      fetchImpl,
      output: new PassThrough(),
    });
    expect(code).toBe(0);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${remote.endpoint}/v1/enroll/revoke`);
  });

  it("forwards only the enrolled authority and replaces a spoofed read caller", async () => {
    const { record, read, send, post } = await fixture();
    expect(
      (await post("/v1/thread/read", { threadId: "reviewer", callerThreadId: "parent" })).status,
    ).toBe(200);
    expect(read).toHaveBeenCalledWith({ threadId: "reviewer", callerThreadId: record.threadId });
    expect(
      (await post("/v1/thread/send", { threadId: "reviewer", message: "connectivity" })).status,
    ).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect((await post("/v1/thread/read", { threadId: "other" })).status).toBe(403);
    expect((await post("/v1/thread/read", { threadId: "reviewer", hostId: "box" })).status).toBe(
      403,
    );
    expect((await post("/v1/thread/read", {}, "host-secret")).status).toBe(401);
    expect((await post("/v1/thread/read", {}, "foreign-client")).status).toBe(401);
    for (const route of [
      "/v1/enroll",
      "/v1/harness/list",
      "/v1/delegate/start",
      "/v1/thread/cancel",
      "/v1/thread/watch",
    ]) {
      expect((await post(route)).status).toBe(403);
    }
    expect((await post("/v1/enroll/revoke")).status).toBe(200);
    expect((await post("/v1/thread/read", { threadId: "reviewer" })).status).toBe(401);
  });

  it("rejects malformed and oversized bodies without reaching Runtime", async () => {
    const { post, read } = await fixture();
    expect((await post("/v1/thread/read", [])).status).toBe(400);
    expect((await post("/v1/thread/read", { text: "x".repeat(2 * 1024 * 1024) })).status).toBe(413);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not follow an upstream redirect or accept expired records", async () => {
    const { record } = await fixture();
    let requests = 0;
    const redirect = await listen(
      createServer((_req, response) => {
        requests++;
        response.writeHead(307, { location: "/redirected" });
        response.end();
      }),
    );
    const endpoint = await listen(createEnrollmentTailnetServer({ ...record, endpoint: redirect }));
    const response = await fetch(`${endpoint}/v1/thread/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${record.token}` },
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(requests).toBe(1);
    expect(() =>
      createEnrollmentTailnetServer({
        ...record,
        expiresAt: record.issuedAt,
        issuedAt: new Date(Date.now() - 10000).toISOString(),
      }),
    ).toThrow(/expired/);
  });

  it("rejects non-tailnet serve binding before exporting credentials", async () => {
    const diagnostics = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: [
          "enroll",
          "serve",
          "--client",
          "cursor-box-grok",
          "--listen",
          "0.0.0.0",
          "--export-file",
          "/tmp/no-export.json",
        ],
        environment: {},
        diagnosticOutput: diagnostics,
      }),
    ).toBe(1);
    expect(diagnostics.read().toString()).toContain("Tailscale IPv4");
  });

  it("closes the listener when the exclusive handoff export fails", async () => {
    const { record, dataDirectory } = await fixture();
    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    await writeEnrollmentStore(enrollmentStorePath(environment, record.clientId), record);
    const exportFile = path.join(dataDirectory, "existing.json");
    await writeFile(exportFile, "preserve", { mode: 0o600 });
    const originalListen = Server.prototype.listen;
    const listeners: Server[] = [];
    const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      listeners.push(this);
      return Reflect.apply(originalListen, this, [0, "127.0.0.1", args.at(-1)]);
    });
    try {
      const diagnostics = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: [
            "enroll",
            "serve",
            "--client",
            record.clientId,
            "--listen",
            "100.64.0.1",
            "--export-file",
            exportFile,
          ],
          environment,
          diagnosticOutput: diagnostics,
        }),
      ).toBe(1);
      expect(diagnostics.read().toString()).toContain("EEXIST");
      expect(listeners).toHaveLength(1);
      expect(listeners[0]?.listening).toBe(false);
      expect(await readFile(exportFile, "utf8")).toBe("preserve");
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves an existing handoff when binding fails with EADDRINUSE", async () => {
    const { record, dataDirectory } = await fixture();
    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    await writeEnrollmentStore(enrollmentStorePath(environment, record.clientId), record);
    const exportFile = path.join(dataDirectory, "preserve.json");
    await writeFile(exportFile, "preserve", { mode: 0o600 });
    const occupied = createServer();
    await listen(occupied);
    const address = occupied.address() as AddressInfo;
    const originalListen = Server.prototype.listen;
    const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      return Reflect.apply(originalListen, this, [address.port, "127.0.0.1", args.at(-1)]);
    });
    try {
      const diagnosticOutput = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: [
            "enroll",
            "serve",
            "--client",
            record.clientId,
            "--listen",
            "100.64.0.1",
            "--export-file",
            exportFile,
          ],
          environment,
          diagnosticOutput,
        }),
      ).toBe(1);
      expect(String(diagnosticOutput.read())).toContain("EADDRINUSE");
      expect(await readFile(exportFile, "utf8")).toBe("preserve");
    } finally {
      spy.mockRestore();
    }
  });
});
