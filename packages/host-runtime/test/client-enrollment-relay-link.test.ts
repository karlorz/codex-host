import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RELAY_ENROLLMENT_CLIENT_ID } from "@codexhost/shared-contracts";

import { handleRelayLinkRequest } from "../src/client-enrollment-relay-link.js";
import {
  allowlistDigest,
  MACHINE_ENROLLMENT_TTL_MS,
  type EnrollmentVerb,
} from "../src/client-enrollment.js";
import { enrollmentStorePath } from "../src/client-enrollment-store.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { DELEGATION_HELP } from "../src/delegation-cli-help.js";
import { PassThrough } from "node:stream";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function record() {
  const issuedAt = Date.now();
  return {
    schemaVersion: 1 as const,
    enrollmentId: "enroll-1",
    threadId: "muse-own",
    token: "muse-token",
    endpoint: "http://127.0.0.1:9",
    clientId: RELAY_ENROLLMENT_CLIENT_ID,
    executablePath: "/test/codexhost",
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + MACHINE_ENROLLMENT_TTL_MS).toISOString(),
    pairing: "machine" as const,
    allowlist: [{ threadId: "target", verbs: ["read", "send"] as EnrollmentVerb[] }],
    allowlistDigest: "",
  };
}

describe("enroll relay-link Mac side", () => {
  it("lists the command in CLI help", () => {
    expect(DELEGATION_HELP).toContain("enroll relay-link");
  });

  it("stamps callerThreadId and rejects hostId", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ status: "completed" }), { status: 200 }),
    );
    const issued = record();
    issued.allowlistDigest = allowlistDigest(issued.allowlist);
    const read = await handleRelayLinkRequest({
      record: issued,
      request: {
        requestId: "r1",
        deadlineMs: Date.now() + 5_000,
        route: "/v1/thread/read",
        body: { threadId: "target", callerThreadId: "spoof", hostId: undefined },
      },
      resolveUpstream: async () => "http://127.0.0.1:9/",
      fetchImpl,
    });
    expect(read.status).toBe(200);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      threadId: "target",
      callerThreadId: "muse-own",
      view: "result",
    });

    const blocked = await handleRelayLinkRequest({
      record: issued,
      request: {
        requestId: "r2",
        deadlineMs: Date.now() + 5_000,
        route: "/v1/thread/read",
        body: { threadId: "target", hostId: "box" },
      },
      resolveUpstream: async () => "http://127.0.0.1:9/",
      fetchImpl,
    });
    expect(blocked.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not contact Runtime for revoke", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const issued = record();
    issued.allowlistDigest = allowlistDigest(issued.allowlist);
    const reply = await handleRelayLinkRequest({
      record: issued,
      request: {
        requestId: "r3",
        deadlineMs: Date.now() + 5_000,
        route: "/v1/enroll/revoke",
        body: {},
      },
      resolveUpstream: async () => "http://127.0.0.1:9/",
      fetchImpl,
    });
    expect(reply.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports outcome_unknown after a mutating POST starts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new Error("aborted")), 10);
        }),
    );
    const issued = record();
    issued.allowlistDigest = allowlistDigest(issued.allowlist);
    const reply = await handleRelayLinkRequest({
      record: issued,
      request: {
        requestId: "r4",
        deadlineMs: Date.now() + 5_000,
        route: "/v1/thread/send",
        body: { threadId: "target", message: "hi" },
      },
      resolveUpstream: async () => "http://127.0.0.1:9/",
      fetchImpl,
    });
    expect(reply.error?.code).toBe("outcome_unknown");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stamps callerThreadId on wait and send", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const issued = record();
    issued.allowlistDigest = allowlistDigest(issued.allowlist);
    await handleRelayLinkRequest({
      record: issued,
      request: {
        requestId: "w",
        deadlineMs: Date.now() + 5_000,
        route: "/v1/thread/wait",
        body: { threadId: "target", timeoutMs: 1000 },
      },
      resolveUpstream: async () => "http://127.0.0.1:9/",
      fetchImpl,
    });
    await handleRelayLinkRequest({
      record: issued,
      request: {
        requestId: "s",
        deadlineMs: Date.now() + 5_000,
        route: "/v1/thread/send",
        body: { threadId: "target", message: "hi" },
      },
      resolveUpstream: async () => "http://127.0.0.1:9/",
      fetchImpl,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).callerThreadId).toBe("muse-own");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).callerThreadId).toBe("muse-own");
  });

  it("refuses a non-muse client without reading Host env", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codexhost-relay-cli-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const output = new PassThrough();
    const diagnostic = new PassThrough();
    const code = await runDelegationCli({
      arguments: [
        "enroll",
        "relay-link",
        "--client",
        "grok-bot",
        "--hop",
        "127.0.0.1",
        "--link-secret-file",
        path.join(dir, "missing"),
      ],
      environment: {
        CODEXHOST_DATA_DIR: dir,
        CODEXHOST_RUNTIME_TOKEN: "host-secret",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
      },
      output,
      diagnosticOutput: diagnostic,
    });
    expect(code).toBe(1);
  });
});

describe("enroll relay-link store", () => {
  it("fails closed when the muse store is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codexhost-relay-missing-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const secret = path.join(dir, "secret");
    await writeFile(secret, "link-secret\n", { mode: 0o600 });
    await chmod(secret, 0o600);
    const diagnostic = new PassThrough();
    let err = "";
    diagnostic.on("data", (chunk) => {
      err += String(chunk);
    });
    const code = await runDelegationCli({
      arguments: [
        "enroll",
        "relay-link",
        "--client",
        "muse",
        "--hop",
        "127.0.0.1",
        "--link-secret-file",
        secret,
      ],
      environment: { CODEXHOST_DATA_DIR: dir },
      output: new PassThrough(),
      diagnosticOutput: diagnostic,
    });
    expect(code).toBe(1);
    expect(err).toContain("ENROLLMENT_INVALID");
    expect(enrollmentStorePath({ CODEXHOST_DATA_DIR: dir }, "muse")).toContain("muse.json");
  });
});
