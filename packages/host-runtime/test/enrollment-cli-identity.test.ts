import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allowlistDigest,
  issuedAllowlist,
  type EnrollmentRecord,
} from "../src/client-enrollment.js";
import { EnrollmentAuthority } from "../src/client-enrollment-authority.js";
import { createStubEnrollmentConsent } from "../src/client-enrollment-consent.js";
import {
  enrollmentStorePath,
  readEnrollmentStore,
  writeEnrollmentStore,
} from "../src/client-enrollment-store.js";
import { parseDelegationArguments } from "../src/delegation-cli-options.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import {
  inspectCliAuthentication,
  resolveCliRuntimeConnection,
} from "../src/delegation-cli-enrollment.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import {
  DELEGATION_ENROLL_CLIENT_ENV,
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  NATIVE_CODEX_THREAD_ID_ENV,
  THREAD_BUSY_MESSAGE,
  threadBusyError,
  type DelegationControlApi,
} from "../src/delegation-types.js";

const directories: string[] = [];
const HOST_TOKEN = "parent-runtime-token";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

async function tempDataDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-enroll-id-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function outputText(stream: PassThrough): string {
  return stream.read()?.toString() ?? "";
}

function record(overrides: Partial<EnrollmentRecord> = {}): EnrollmentRecord {
  const threadId = overrides.threadId ?? "muse-thread";
  const allowlist = overrides.allowlist ?? issuedAllowlist(threadId, []);
  const { allowlistDigest: digestOverride, ...rest } = overrides;
  return {
    schemaVersion: 1,
    enrollmentId: "enrollment-muse",
    threadId,
    token: "muse-token",
    endpoint: "http://127.0.0.1:9",
    clientId: "muse",
    executablePath: "/synthetic/muse",
    issuedAt: "2026-11-07T00:00:00.000Z",
    expiresAt: "2026-11-08T00:00:00.000Z",
    allowlist,
    ...rest,
    allowlistDigest: digestOverride ?? allowlistDigest(rest.allowlist ?? allowlist),
  };
}

function controlApi(overrides: Partial<DelegationControlApi> = {}): DelegationControlApi {
  return {
    listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const] })),
    inspect: vi.fn(),
    start: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    read: vi.fn(),
    wait: vi.fn(),
    list: vi.fn(),
    ...overrides,
  };
}

describe("enrollment CLI identity", () => {
  it("uses --enrolled-client even when Host Runtime env is set", async () => {
    const dataDir = await tempDataDir();
    const issued = record();
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
      issued,
    );
    const connection = await resolveCliRuntimeConnection({
      environment: {
        CODEXHOST_DATA_DIR: dataDir,
        [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
        [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
        [DELEGATION_THREAD_ID_ENV]: "host-thread",
      },
      parsed: parseDelegationArguments(["--enrolled-client", "muse"]),
      nowMs: NOW,
    });
    expect(connection).toMatchObject({
      source: "enrollment",
      token: "muse-token",
      callerThreadId: "muse-thread",
    });
  });

  it("does not treat thread-list --client as enrollment identity", async () => {
    const dataDir = await tempDataDir();
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "grok-bot"),
      record({
        clientId: "grok-bot",
        token: "grok-token",
        threadId: "grok-thread",
        enrollmentId: "enrollment-grok",
      }),
    );
    const connection = await resolveCliRuntimeConnection({
      environment: { CODEXHOST_DATA_DIR: dataDir },
      parsed: parseDelegationArguments(["--client", "muse"]),
      nowMs: NOW,
    });
    expect(connection).toMatchObject({
      source: "enrollment",
      token: "grok-token",
      callerThreadId: "grok-thread",
    });
    await expect(
      resolveCliRuntimeConnection({
        environment: { CODEXHOST_DATA_DIR: await tempDataDir() },
        parsed: parseDelegationArguments(["--client", "grok-bot"]),
        nowMs: NOW,
      }),
    ).rejects.toMatchObject({
      details: { reason: "missing_runtime_environment" },
    });
  });

  it.each(["read", "wait"])(
    "uses enrollment credentials for thread %s despite inherited Host identity",
    async (command) => {
      const dataDir = await tempDataDir();
      await writeEnrollmentStore(
        enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
        record(),
      );
      const result = {
        threadId: "target-thread",
        status: "completed",
        ...(command === "wait" ? { timedOut: false } : {}),
      };
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(result));
      const output = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: [
            "thread",
            command,
            "target-thread",
            "--enrolled-client",
            "muse",
            ...(command === "wait" ? ["--timeout-ms", "1000"] : []),
          ],
          environment: {
            CODEXHOST_DATA_DIR: dataDir,
            [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
            [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
            [DELEGATION_THREAD_ID_ENV]: "host-thread",
            [NATIVE_CODEX_THREAD_ID_ENV]: "native-host-thread",
          },
          output,
          fetchImpl,
          now: () => NOW,
        }),
      ).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const call = fetchImpl.mock.calls[0];
      if (!call) throw new Error("Expected a Runtime request");
      const [url, init] = call;
      expect(String(url)).toBe(`http://127.0.0.1:9/v1/thread/${command}`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer muse-token");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ threadId: "target-thread", view: "result" });
      if (command === "read") {
        expect(body.callerThreadId).toBe("muse-thread");
      } else {
        expect(body.timeoutMs).toBeGreaterThan(0);
        expect(body.timeoutMs).toBeLessThanOrEqual(1000);
        expect(body).not.toHaveProperty("callerThreadId");
      }
      expect(JSON.parse(outputText(output))).toEqual(result);
    },
  );

  it("does not fall back to Host credentials when the selected enrollment store is missing", async () => {
    const dataDir = await tempDataDir();
    const diagnosticOutput = new PassThrough();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}));
    expect(
      await runDelegationCli({
        arguments: [
          "thread",
          "send",
          "63aadb58-8773-4a97-b72c-dcc2a1e38b5c",
          "--message",
          "connectivity",
          "--enrolled-client",
          "muse",
        ],
        environment: {
          CODEXHOST_DATA_DIR: dataDir,
          [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
          [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
        },
        output: new PassThrough(),
        diagnosticOutput,
        fetchImpl,
        now: () => NOW,
      }),
    ).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(outputText(diagnosticOutput)).error).toMatchObject({
      code: "ENROLLMENT_INVALID",
      details: {
        reason: "missing_store",
        clientId: "muse",
      },
    });
  });

  it("honors CODEXHOST_ENROLL_CLIENT for enroll status and reports host-session authentication", async () => {
    const dataDir = await tempDataDir();
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "grok-bot"),
      record({
        clientId: "grok-bot",
        token: "grok-token",
        threadId: "grok-thread",
        enrollmentId: "enrollment-grok",
        issuedAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-11-02T00:00:00.000Z",
      }),
    );
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
      record(),
    );
    const output = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: ["enroll", "status", "--format", "compact"],
        environment: {
          CODEXHOST_DATA_DIR: dataDir,
          [DELEGATION_ENROLL_CLIENT_ENV]: "muse",
          [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
          [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
          [DELEGATION_THREAD_ID_ENV]: "host-thread",
        },
        output,
        now: () => NOW,
      }),
    ).toBe(0);
    const view = JSON.parse(outputText(output)) as Record<string, unknown>;
    expect(view).toMatchObject({
      clientId: "muse",
      enrollmentId: "enrollment-muse",
      authentication: {
        source: "host-session",
        clientId: "muse",
        callerThreadId: "host-thread",
        ignoredAmbient: [],
      },
    });
    expect(JSON.stringify(view)).not.toContain("muse-token");
  });

  it.each([
    ["thread", "send", "target-thread", "--message", "connectivity", "--enrolled-client", "muse"],
    ["enroll", "status", "--enrolled-client", "muse"],
    ["enroll", "revoke", "--enrolled-client", "muse"],
    [
      "enroll",
      "serve",
      "--client",
      "muse",
      "--listen",
      "100.64.1.2",
      "--export-file",
      "/private/synthetic-handoff.json",
    ],
  ])("rejects a different client's record for %j", async (...arguments_) => {
    const dataDir = await tempDataDir();
    const storePath = enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse");
    await writeEnrollmentStore(
      storePath,
      record({
        clientId: "cursor-box-grok",
        expiresAt: "2030-11-08T00:00:00.000Z",
      }),
    );
    const diagnosticOutput = new PassThrough();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await runDelegationCli({
        arguments: arguments_,
        environment: {
          CODEXHOST_DATA_DIR: dataDir,
          [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
          [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
        },
        diagnosticOutput,
        fetchImpl,
        now: () => NOW,
      }),
    ).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(outputText(diagnosticOutput)).error).toMatchObject({
      code: "ENROLLMENT_INVALID",
      details: {
        reason: "client_mismatch",
        clientId: "muse",
        storedClientId: "cursor-box-grok",
        storePath,
      },
    });
    expect((await readEnrollmentStore(storePath, NOW))?.clientId).toBe("cursor-box-grok");
  });

  it.each([DELEGATION_RUNTIME_ENDPOINT_ENV, DELEGATION_RUNTIME_TOKEN_ENV])(
    "reports incomplete Host credentials when only %s is present",
    async (presentName) => {
      const dataDir = await tempDataDir();
      await writeEnrollmentStore(
        enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
        record(),
      );
      const environment = {
        CODEXHOST_DATA_DIR: dataDir,
        [DELEGATION_ENROLL_CLIENT_ENV]: "muse",
        [presentName]:
          presentName === DELEGATION_RUNTIME_ENDPOINT_ENV ? "http://127.0.0.1:4321" : HOST_TOKEN,
      };
      const output = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["enroll", "status"],
          environment,
          output,
          now: () => NOW,
        }),
      ).toBe(0);
      expect(JSON.parse(outputText(output)).authentication).toMatchObject({
        source: "incomplete-host-session",
        missingEnvironmentVariables: [
          presentName === DELEGATION_RUNTIME_ENDPOINT_ENV
            ? DELEGATION_RUNTIME_TOKEN_ENV
            : DELEGATION_RUNTIME_ENDPOINT_ENV,
        ],
      });
      const diagnosticOutput = new PassThrough();
      const fetchImpl = vi.fn<typeof fetch>();
      expect(
        await runDelegationCli({
          arguments: ["thread", "read", "target-thread"],
          environment,
          diagnosticOutput,
          fetchImpl,
          now: () => NOW,
        }),
      ).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(JSON.parse(outputText(diagnosticOutput)).error.details.reason).toBe(
        "missing_runtime_environment",
      );
    },
  );

  it.each(["expired", "insecure_store_mode"])(
    "does not use ambient Host credentials when the selected enrollment is %s",
    async (reason) => {
      if (reason === "insecure_store_mode" && process.platform === "win32") return;
      const dataDir = await tempDataDir();
      const storePath = enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse");
      await writeEnrollmentStore(
        storePath,
        record(
          reason === "expired"
            ? {
                issuedAt: "2026-11-01T00:00:00.000Z",
                expiresAt: "2026-11-02T00:00:00.000Z",
              }
            : {},
        ),
      );
      if (reason === "insecure_store_mode") await chmod(storePath, 0o644);
      const diagnosticOutput = new PassThrough();
      const fetchImpl = vi.fn<typeof fetch>();
      expect(
        await runDelegationCli({
          arguments: [
            "thread",
            "send",
            "target-thread",
            "--message",
            "connectivity",
            "--enrolled-client",
            "muse",
          ],
          environment: {
            CODEXHOST_DATA_DIR: dataDir,
            [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
            [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
          },
          diagnosticOutput,
          fetchImpl,
          now: () => NOW,
        }),
      ).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      const error = JSON.parse(outputText(diagnosticOutput)).error;
      expect(error).toMatchObject({
        code: "ENROLLMENT_INVALID",
        details: { reason, clientId: "muse", storePath },
      });
      expect(JSON.stringify(error)).not.toContain("muse-token");
      expect(JSON.stringify(error)).not.toContain(HOST_TOKEN);
    },
  );

  it("reports enrollment authentication when --enrolled-client is set", async () => {
    const dataDir = await tempDataDir();
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
      record(),
    );
    const output = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: ["enroll", "status", "--enrolled-client", "muse"],
        environment: {
          CODEXHOST_DATA_DIR: dataDir,
          [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
          [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
          [DELEGATION_THREAD_ID_ENV]: "host-thread",
        },
        output,
        now: () => NOW,
      }),
    ).toBe(0);
    expect(JSON.parse(outputText(output)).authentication).toEqual({
      source: "enrollment",
      clientId: "muse",
      callerThreadId: "muse-thread",
      ignoredAmbient: [
        DELEGATION_RUNTIME_ENDPOINT_ENV,
        DELEGATION_RUNTIME_TOKEN_ENV,
        DELEGATION_THREAD_ID_ENV,
      ],
    });
  });

  it("distinguishes expired stores without printing a token", async () => {
    const dataDir = await tempDataDir();
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
      record({
        issuedAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-11-02T00:00:00.000Z",
      }),
    );
    const diagnosticOutput = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: ["enroll", "status", "--client", "muse"],
        environment: { CODEXHOST_DATA_DIR: dataDir },
        diagnosticOutput,
        now: () => NOW,
      }),
    ).toBe(1);
    const error = JSON.parse(outputText(diagnosticOutput)).error as {
      details: Record<string, unknown>;
    };
    expect(error.details).toMatchObject({
      reason: "expired",
      clientId: "muse",
      expiresAt: "2026-11-02T00:00:00.000Z",
    });
    expect(JSON.stringify(error)).not.toContain("muse-token");
  });

  it("rejects a mode-644 store on read and writes a replacement as mode 600", async () => {
    if (process.platform === "win32") return;
    const dataDir = await tempDataDir();
    const storePath = enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse");
    const issued = record();
    await writeEnrollmentStore(storePath, issued);
    await chmod(storePath, 0o644);
    await expect(readEnrollmentStore(storePath, NOW)).rejects.toMatchObject({
      details: { reason: "insecure_store_mode", observedMode: "644", requiredMode: "600" },
    });
    expect((await stat(storePath)).mode & 0o777).toBe(0o644);
    await writeEnrollmentStore(storePath, issued);
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  });

  it("marks enrolled THREAD_BUSY as authorized after allowlist checks", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: HOST_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("approve"),
      bootstrapToken: "bootstrap-token",
      createId: () => "enrollment-muse",
      createThread: async () => "muse-thread",
      createToken: () => "muse-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const api = controlApi({
      send: vi.fn(async ({ threadId }) => {
        throw threadBusyError(threadId);
      }),
    });
    const server = await startDelegationControlServer({
      token: HOST_TOKEN,
      api,
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const issued = await enrollment.enroll({
        clientId: "muse",
        executablePath: "/synthetic/muse",
        allowlist: [{ threadId: "target-thread", verbs: ["read", "send"] }],
        attendedHostApprove: true,
      });
      await writeEnrollmentStore(
        enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
        issued,
      );
      const diagnosticOutput = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: [
            "thread",
            "send",
            "target-thread",
            "--message",
            "connectivity",
            "--enrolled-client",
            "muse",
          ],
          environment: {
            CODEXHOST_DATA_DIR: dataDir,
            [DELEGATION_RUNTIME_ENDPOINT_ENV]: server.endpoint,
            [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
          },
          diagnosticOutput,
          now: () => NOW,
        }),
      ).toBe(1);
      expect(JSON.parse(outputText(diagnosticOutput)).error).toMatchObject({
        code: "THREAD_BUSY",
        message: THREAD_BUSY_MESSAGE,
        details: {
          threadId: "target-thread",
          notStarted: true,
          authorized: true,
        },
      });
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("inspects Host vs enrollment without returning a token", () => {
    const view = inspectCliAuthentication({
      environment: {
        [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:9",
        [DELEGATION_RUNTIME_TOKEN_ENV]: "secret",
      },
      parsed: parseDelegationArguments(["--enrolled-client", "muse"]),
      clientId: "muse",
      enrollmentThreadId: "muse-thread",
    });
    expect(view.source).toBe("enrollment");
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it.each([false, true])(
    "enforces the cancel grant at the CLI/server boundary (granted=%s)",
    async (granted) => {
      const dataDir = await tempDataDir();
      const enrollment = new EnrollmentAuthority({
        hostToken: HOST_TOKEN,
        dataDirectory: dataDir,
        consent: createStubEnrollmentConsent("approve"),
        now: () => NOW,
        createThread: async () => "muse-thread",
      });
      const cancel = vi.fn<DelegationControlApi["cancel"]>(async ({ threadId }) => ({
        threadId,
        turnId: "active-turn",
        harnessId: "codex",
        cancelled: true,
      }));
      const server = await startDelegationControlServer({
        token: HOST_TOKEN,
        api: controlApi({ cancel }),
        enrollment,
      });
      try {
        await enrollment.publishBootstrap(server.endpoint);
        const issued = await enrollment.enroll({
          clientId: "muse",
          executablePath: "/synthetic/muse",
          allowlist: [
            { threadId: "target-thread", verbs: granted ? ["send", "cancel"] : ["send"] },
          ],
          attendedHostApprove: true,
        });
        await writeEnrollmentStore(
          enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "muse"),
          issued,
        );
        const output = new PassThrough();
        const diagnosticOutput = new PassThrough();
        expect(
          await runDelegationCli({
            arguments: ["thread", "cancel", "target-thread", "--enrolled-client", "muse"],
            environment: {
              CODEXHOST_DATA_DIR: dataDir,
              [DELEGATION_RUNTIME_ENDPOINT_ENV]: server.endpoint,
              [DELEGATION_RUNTIME_TOKEN_ENV]: HOST_TOKEN,
            },
            output,
            diagnosticOutput,
            now: () => NOW,
          }),
        ).toBe(granted ? 0 : 1);
        if (granted) {
          expect(cancel).toHaveBeenCalledExactlyOnceWith({ threadId: "target-thread" });
          expect(JSON.parse(outputText(output))).toMatchObject({ cancelled: true });
        } else {
          expect(cancel).not.toHaveBeenCalled();
          expect(JSON.parse(outputText(diagnosticOutput)).error).toMatchObject({
            code: "UNAUTHORIZED_TARGET",
            details: { verb: "cancel" },
          });
        }
      } finally {
        await enrollment.close();
        await server.close();
      }
    },
  );
});
