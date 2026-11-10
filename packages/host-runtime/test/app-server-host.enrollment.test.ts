import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { ENROLLMENT_LIST_METHOD, ENROLLMENT_REVOKE_METHOD } from "@codexhost/shared-contracts";
import { EnrollmentAuthority } from "../src/client-enrollment-authority.js";
import { createStubEnrollmentConsent } from "../src/client-enrollment-consent.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("lists and revokes enrollments on Desktop and console without returning tokens", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "enrollment-rpc-"));
  const enrollment = new EnrollmentAuthority({
    hostToken: "host-token",
    dataDirectory: directory,
    consent: createStubEnrollmentConsent("approve"),
    now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    createId: () => "enroll-host",
    createThread: async () => "thread-host",
    createToken: () => "host-listed-token",
  });
  const desktop = createFixture({
    environment: { CODEXHOST_DATA_DIR: directory },
    enrollment,
  });
  const consoleHost = createFixture({
    environment: { CODEXHOST_DATA_DIR: directory },
    enrollment,
  });
  try {
    await enrollment.publishBootstrap("http://127.0.0.1:9");
    await enrollment.enroll({
      clientId: "cursor-box-grok",
      executablePath: "/synthetic/grok",
      pairing: "machine",
      attendedHostApprove: true,
    });
    const listed = await consoleHost.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, {});
    expect(listed).toMatchObject({
      result: {
        enrollments: [
          {
            enrollmentId: "enroll-host",
            clientId: "cursor-box-grok",
            pairing: "machine",
          },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toContain("host-listed-token");
    expect(JSON.stringify(listed)).not.toMatch(/"token"/u);
    writeRequest(desktop.desktopInput, { id: 801, method: ENROLLMENT_LIST_METHOD, params: {} });
    expect(await desktop.collector.waitFor((message) => requestId(message, 801))).toMatchObject({
      result: { enrollments: [{ enrollmentId: "enroll-host" }] },
    });
    expect(
      await consoleHost.host.handleConsoleRequest(ENROLLMENT_REVOKE_METHOD, {
        enrollmentId: "enroll-host",
      }),
    ).toEqual({ result: { enrollmentId: "enroll-host", revoked: true } });
    expect(await consoleHost.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, {})).toEqual({
      result: { enrollments: [] },
    });
    expect(
      await consoleHost.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, { extra: true }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(await consoleHost.host.handleConsoleRequest(ENROLLMENT_REVOKE_METHOD, {})).toMatchObject(
      { error: { code: -32602 } },
    );
  } finally {
    await stopFixture(desktop);
    await stopFixture(consoleHost);
    await enrollment.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects enrollment RPCs when the Host has no enrollment authority", async () => {
  const fixture = createFixture();
  try {
    expect(await fixture.host.handleConsoleRequest(ENROLLMENT_LIST_METHOD, {})).toMatchObject({
      error: { code: -32000, message: "Enrollment is unavailable on this Host" },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it.each([false, true])(
  "issues only a native readable idle own Thread (creation fails=%s)",
  async (fail) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "enrollment-native-"));
    const registry = new DelegationControlRegistry();
    const enrollment = new EnrollmentAuthority({
      hostToken: "host-token",
      dataDirectory: directory,
      createThread: (clientId) => registry.createEnrollmentThread(clientId),
    });
    const fixture = createFixture({
      environment: { CODEXHOST_DATA_DIR: directory },
      enrollment,
      onDelegationApi: (api, extras) => registry.register(api, extras),
    });
    const nativeId = "11111111-1111-4111-8111-111111111111";
    const methods: string[] = [];
    let created = false;
    let buffer = "";
    fixture.official.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        methods.push(request.method);
        if (request.id === undefined) continue;
        const thread = { id: nativeId, cwd: directory, status: { type: "idle" }, turns: [] };
        if (request.method === "thread/start") {
          created = !fail;
          writeRequest(fixture.official.stdout, {
            id: request.id,
            ...(fail
              ? { error: { code: -32603, message: "Synthetic native creation failure" } }
              : { result: { thread } }),
          });
        } else if (request.method === "thread/read") {
          expect(created).toBe(true);
          expect(request.params.threadId).toBe(nativeId);
          writeRequest(fixture.official.stdout, { id: request.id, result: { thread } });
        } else {
          writeRequest(fixture.official.stdout, {
            id: request.id,
            result: { userAgent: "fixture" },
          });
        }
      }
    });
    const server = await startDelegationControlServer({
      token: "host-token",
      api: registry,
      enrollment,
    });
    try {
      await fixture.ready;
      await enrollment.publishBootstrap(server.endpoint);
      const output = new PassThrough();
      const diagnostics = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["enroll", "--client", "muse", "--machine"],
          environment: {
            CODEXHOST_DATA_DIR: directory,
            CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
            CODEXHOST_RUNTIME_TOKEN: "host-token",
          },
          output,
          diagnosticOutput: diagnostics,
        }),
      ).toBe(fail ? 1 : 0);
      if (fail) {
        expect(enrollment.listPublic()).toEqual([]);
        expect(JSON.parse(String(diagnostics.read())).error.code).toBe("INTERNAL_ERROR");
      } else {
        expect(JSON.parse(String(output.read())).threadId).toBe(nativeId);
        const readOutput = new PassThrough();
        expect(
          await runDelegationCli({
            arguments: ["thread", "read", nativeId, "--enrolled-client", "muse"],
            environment: { CODEXHOST_DATA_DIR: directory },
            output: readOutput,
          }),
        ).toBe(0);
        expect(JSON.parse(String(readOutput.read()))).toMatchObject({
          threadId: nativeId,
          harnessId: "codex",
          turn: null,
        });
      }
      expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
      expect(methods).not.toContain("turn/start");
    } finally {
      await server.close();
      registry.close();
      await enrollment.close();
      await stopFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
