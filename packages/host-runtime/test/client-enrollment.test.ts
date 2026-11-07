import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_PARENT_THREAD_ID,
  allowlistDigest,
  authorizeEnrollment,
  issuedAllowlist,
  parseAllowlistOption,
  verifyEnrollmentRecord,
  type EnrollmentRecord,
} from "../src/client-enrollment.js";
import { createStubEnrollmentConsent } from "../src/client-enrollment-consent.js";
import { EnrollmentAuthority } from "../src/client-enrollment-authority.js";
import {
  ENROLL_FROM_ENV_FILE_ENV,
  ENROLL_FROM_PID_ENV,
  enrollmentStorePath,
  loadEnrollmentCredentialsFromEnvFile,
  loadEnrollmentCredentialsFromPid,
  rejectForeignCredentialSources,
  writeEnrollmentStore,
} from "../src/client-enrollment-store.js";
import { DELEGATION_HELP, runDelegationCli } from "../src/delegation-cli.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DelegationControlError,
  type DelegationControlApi,
} from "../src/delegation-types.js";

const PARENT_TOKEN = "parent-runtime-token";
const directories: string[] = [];

async function tempDataDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-enroll-"));
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
  const threadId = overrides.threadId ?? "enrolled-thread";
  const allowlist = overrides.allowlist ?? issuedAllowlist(threadId, []);
  return {
    schemaVersion: 1,
    enrollmentId: "enrollment-1",
    threadId,
    token: "enrolled-token",
    endpoint: "http://127.0.0.1:9",
    clientId: "grok-bot",
    executablePath: "/synthetic/grok-bot",
    issuedAt: "2026-11-07T00:00:00.000Z",
    expiresAt: "2026-11-08T00:00:00.000Z",
    allowlist,
    allowlistDigest: allowlistDigest(allowlist),
    ...overrides,
    allowlistDigest: overrides.allowlistDigest ?? allowlistDigest(overrides.allowlist ?? allowlist),
  };
}

function controlApi(overrides: Partial<DelegationControlApi> = {}): DelegationControlApi {
  return {
    listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const] })),
    inspect: vi.fn(),
    start: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    read: vi.fn(async ({ threadId }) => ({
      threadId,
      harnessId: "codex" as const,
      status: "completed" as const,
      turn: null,
      progress: [],
      result: { availability: "available" as const, text: "ok" },
      nextCursor: null,
    })),
    wait: vi.fn(),
    list: vi.fn(async () => ({
      threads: [
        {
          threadId: FIXTURE_PARENT_THREAD_ID,
          harnessId: "codex" as const,
          deepLink: `codex://threads/${FIXTURE_PARENT_THREAD_ID}`,
          status: "completed" as const,
        },
        {
          threadId: "other",
          harnessId: "pi" as const,
          deepLink: "codex://threads/other",
          status: "completed" as const,
        },
      ],
      nextCursor: null,
    })),
    ...overrides,
  };
}

describe("client enrollment domain", () => {
  it("parses allowlists and keeps the parent fixture read/watch only unless send is listed", () => {
    expect(parseAllowlistOption(undefined)).toEqual([]);
    expect(parseAllowlistOption(`${FIXTURE_PARENT_THREAD_ID}:read,watch`)).toEqual([
      { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "watch"] },
    ]);
    expect(() => parseAllowlistOption("thread:delegate")).toThrow(/invalid/u);
  });

  it("authorizes allowlisted read and denies non-listed threads and send", () => {
    const issued = record({
      allowlist: issuedAllowlist("enrolled-thread", [
        { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "watch"] },
      ]),
    });
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    expect(() =>
      authorizeEnrollment(issued, { type: "read", threadId: FIXTURE_PARENT_THREAD_ID }, now),
    ).not.toThrow();
    expect(() =>
      authorizeEnrollment(issued, { type: "read", threadId: "other" }, now),
    ).toThrowError(DelegationControlError);
    try {
      authorizeEnrollment(issued, { type: "read", threadId: "other" }, now);
    } catch (error) {
      expect(error).toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    }
    try {
      authorizeEnrollment(issued, { type: "send", threadId: FIXTURE_PARENT_THREAD_ID }, now);
    } catch (error) {
      expect(error).toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    }
    try {
      authorizeEnrollment(issued, { type: "delegate" }, now);
    } catch (error) {
      expect(error).toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    }
  });

  it("fails closed on allowlist tamper, expiry, and clock skew", () => {
    const issued = record();
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    const tampered = {
      ...issued,
      allowlist: issuedAllowlist(issued.threadId, [
        { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "watch", "send"] },
      ]),
    };
    expect(() => verifyEnrollmentRecord(tampered, now)).toThrow(/digest/u);
    expect(() => verifyEnrollmentRecord(issued, Date.parse("2026-11-09T00:00:00.000Z"))).toThrow(
      /expired/u,
    );
    expect(() => verifyEnrollmentRecord(issued, Date.parse("2026-11-06T00:00:00.000Z"))).toThrow(
      /skew/u,
    );
    expect(() =>
      verifyEnrollmentRecord(record({ threadId: FIXTURE_PARENT_THREAD_ID }), now),
    ).toThrow(/impersonate/u);
  });

  it("rejects foreign pid environ and parent env files", () => {
    expect(() => loadEnrollmentCredentialsFromPid("1")).toThrow(/another process/u);
    expect(() => loadEnrollmentCredentialsFromEnvFile("/tmp/parent.env")).toThrow(
      /parent Runtime/u,
    );
    expect(() =>
      rejectForeignCredentialSources({ environment: { [ENROLL_FROM_PID_ENV]: "99" } }),
    ).toThrow(/another process/u);
    expect(() =>
      rejectForeignCredentialSources({
        environment: { [ENROLL_FROM_ENV_FILE_ENV]: "/tmp/parent.env" },
      }),
    ).toThrow(/parent Runtime/u);
    expect(() =>
      rejectForeignCredentialSources({
        environment: {},
        asThread: FIXTURE_PARENT_THREAD_ID,
      }),
    ).toThrow(/impersonate/u);
  });
});

describe("client enrollment store and Runtime", () => {
  it("issues distinct credentials on Approve and writes a mode-600 store from the CLI", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("approve"),
      bootstrapToken: "bootstrap-token",
      createId: (() => {
        let index = 0;
        return () => ["enrollment-id", "enrolled-thread"][index++] ?? "extra";
      })(),
      createToken: () => "enrolled-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const output = new PassThrough();
      const environment = {
        CODEXHOST_DATA_DIR: dataDir,
        [DELEGATION_RUNTIME_TOKEN_ENV]: PARENT_TOKEN,
      };
      expect(
        await runDelegationCli({
          arguments: [
            "enroll",
            "--client",
            "grok-bot",
            "--allow",
            `${FIXTURE_PARENT_THREAD_ID}:read,watch`,
            "--executable",
            "/synthetic/grok-bot",
          ],
          environment,
          output,
          now: () => Date.parse("2026-11-07T00:00:00.000Z"),
        }),
      ).toBe(0);
      const view = JSON.parse(outputText(output)) as {
        enrollmentId: string;
        threadId: string;
        token?: string;
        storePath: string;
      };
      expect(view.enrollmentId).toBe("enrollment-id");
      expect(view.threadId).toBe("enrolled-thread");
      expect(view.threadId).not.toBe(FIXTURE_PARENT_THREAD_ID);
      expect(view.token).toBeUndefined();
      const stored = JSON.parse(await readFile(view.storePath, "utf8")) as EnrollmentRecord;
      expect(stored.token).toBe("enrolled-token");
      expect(stored.token).not.toBe(PARENT_TOKEN);
      expect(stored.token).not.toBe("bootstrap-token");
      expect(stored.enrollmentId).not.toBe(stored.threadId);
      if (process.platform !== "win32") {
        expect((await stat(view.storePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("treats Host-session enroll as attended approve without Desktop timeout", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("timeout"),
      bootstrapToken: "bootstrap-token",
      createId: (() => {
        let index = 0;
        return () => ["enrollment-id", "enrolled-thread"][index++] ?? "extra";
      })(),
      createToken: () => "enrolled-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const output = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: [
            "enroll",
            "--client",
            "grok-bot",
            "--allow",
            `${FIXTURE_PARENT_THREAD_ID}:read,watch`,
            "--executable",
            "/synthetic/grok-bot",
          ],
          environment: {
            CODEXHOST_DATA_DIR: dataDir,
            [DELEGATION_RUNTIME_ENDPOINT_ENV]: server.endpoint,
            [DELEGATION_RUNTIME_TOKEN_ENV]: PARENT_TOKEN,
          },
          output,
          now: () => Date.parse("2026-11-07T00:00:00.000Z"),
        }),
      ).toBe(0);
      const stored = JSON.parse(
        await readFile(enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "grok-bot"), "utf8"),
      ) as EnrollmentRecord;
      expect(stored.token).toBe("enrolled-token");
      expect(stored.threadId).not.toBe(FIXTURE_PARENT_THREAD_ID);
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("writes no store on deny or timeout", async () => {
    for (const decision of ["deny", "timeout"] as const) {
      const dataDir = await tempDataDir();
      const enrollment = new EnrollmentAuthority({
        hostToken: PARENT_TOKEN,
        dataDirectory: dataDir,
        consent: createStubEnrollmentConsent(decision),
        bootstrapToken: "bootstrap-token",
        createToken: () => "enrolled-token",
      });
      const server = await startDelegationControlServer({
        token: PARENT_TOKEN,
        api: controlApi(),
        enrollment,
      });
      try {
        await enrollment.publishBootstrap(server.endpoint);
        const diagnosticOutput = new PassThrough();
        expect(
          await runDelegationCli({
            arguments: ["enroll", "--client", "grok-bot", "--executable", "/synthetic/grok-bot"],
            environment: { CODEXHOST_DATA_DIR: dataDir },
            diagnosticOutput,
          }),
        ).toBe(1);
        expect(JSON.parse(outputText(diagnosticOutput)).error.code).toBe("ENROLLMENT_DENIED");
        await expect(
          stat(enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "grok-bot")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await enrollment.close();
        await server.close();
      }
    }
  });

  it("keeps missing_runtime_environment when the store is absent", async () => {
    const dataDir = await tempDataDir();
    const diagnosticOutput = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: ["thread", "read", "thread-1"],
        environment: { PATH: "/synthetic", CODEXHOST_DATA_DIR: dataDir },
        diagnosticOutput,
      }),
    ).toBe(1);
    expect(JSON.parse(outputText(diagnosticOutput))).toMatchObject({
      error: {
        code: "RUNTIME_UNREACHABLE",
        message: expect.stringContaining(
          "CODEXHOST_RUNTIME_ENDPOINT and CODEXHOST_RUNTIME_TOKEN are required",
        ),
        details: {
          reason: "missing_runtime_environment",
          missingEnvironmentVariables: [
            DELEGATION_RUNTIME_ENDPOINT_ENV,
            DELEGATION_RUNTIME_TOKEN_ENV,
          ],
          nativeCodexRecovery: {
            recommendedPolicy: {
              inherit: "all",
              ignoreDefaultExcludes: true,
              includeOnlyMustContain: [
                DELEGATION_RUNTIME_ENDPOINT_ENV,
                DELEGATION_RUNTIME_TOKEN_ENV,
              ],
            },
          },
        },
      },
    });
  });

  it("authorizes allowlisted thread read and denies non-listed targets, send, and delegate", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("approve"),
      bootstrapToken: "bootstrap-token",
      createId: (() => {
        let index = 0;
        return () => ["enrollment-id", "enrolled-thread"][index++] ?? "extra";
      })(),
      createToken: () => "enrolled-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const api = controlApi();
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api,
      watchApi: {
        watch: vi.fn(),
        watches: vi.fn(async () => ({ watches: [] })),
      },
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const environment = { CODEXHOST_DATA_DIR: dataDir };
      expect(
        await runDelegationCli({
          arguments: [
            "enroll",
            "--client",
            "grok-bot",
            "--allow",
            `${FIXTURE_PARENT_THREAD_ID}:read,watch`,
            "--executable",
            "/synthetic/grok-bot",
          ],
          environment,
          output: new PassThrough(),
          now: () => Date.parse("2026-11-07T12:00:00.000Z"),
        }),
      ).toBe(0);

      const readOutput = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["thread", "read", FIXTURE_PARENT_THREAD_ID],
          environment,
          output: readOutput,
          now: () => Date.parse("2026-11-07T12:00:00.000Z"),
        }),
      ).toBe(0);
      expect(JSON.parse(outputText(readOutput)).threadId).toBe(FIXTURE_PARENT_THREAD_ID);

      const denied = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["thread", "read", "other"],
          environment,
          diagnosticOutput: denied,
          now: () => Date.parse("2026-11-07T12:00:00.000Z"),
        }),
      ).toBe(1);
      expect(JSON.parse(outputText(denied)).error.code).toBe("UNAUTHORIZED_TARGET");

      const sendDenied = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["thread", "send", FIXTURE_PARENT_THREAD_ID, "--message", "hi"],
          environment,
          diagnosticOutput: sendDenied,
          now: () => Date.parse("2026-11-07T12:00:00.000Z"),
        }),
      ).toBe(1);
      expect(JSON.parse(outputText(sendDenied)).error.code).toBe("UNAUTHORIZED_TARGET");

      const delegateDenied = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["delegate", "start", "--harness", "pi", "--task", "work"],
          environment,
          diagnosticOutput: delegateDenied,
          now: () => Date.parse("2026-11-07T12:00:00.000Z"),
        }),
      ).toBe(1);
      expect(JSON.parse(outputText(delegateDenied)).error.code).toBe("UNAUTHORIZED_TARGET");
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("still fails watch when the caller Thread is unknown", async () => {
    const diagnosticOutput = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: ["thread", "watch", "child"],
        environment: {
          [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
          [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
        },
        diagnosticOutput,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).toBe(1);
    expect(JSON.parse(outputText(diagnosticOutput)).error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("--notify"),
    });
  });

  it("revokes and then fails closed, including after allowlist tamper", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("approve"),
      bootstrapToken: "bootstrap-token",
      createId: (() => {
        let index = 0;
        return () => ["enrollment-id", "enrolled-thread"][index++] ?? "extra";
      })(),
      createToken: () => "enrolled-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const environment = { CODEXHOST_DATA_DIR: dataDir };
      const now = () => Date.parse("2026-11-07T12:00:00.000Z");
      await runDelegationCli({
        arguments: [
          "enroll",
          "--client",
          "grok-bot",
          "--allow",
          `${FIXTURE_PARENT_THREAD_ID}:read,watch`,
          "--executable",
          "/synthetic/grok-bot",
        ],
        environment,
        output: new PassThrough(),
        now,
      });
      const storePath = enrollmentStorePath(environment, "grok-bot");
      const stored = JSON.parse(await readFile(storePath, "utf8")) as EnrollmentRecord;
      stored.allowlist = issuedAllowlist(stored.threadId, [
        { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "watch", "send"] },
      ]);
      await writeFile(storePath, `${JSON.stringify(stored)}\n`);
      if (process.platform !== "win32") await chmod(storePath, 0o600);
      const tamper = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["thread", "read", FIXTURE_PARENT_THREAD_ID],
          environment,
          diagnosticOutput: tamper,
          now,
        }),
      ).toBe(1);
      expect(JSON.parse(outputText(tamper)).error.details.reason).toBe("allowlist_tamper");

      await writeEnrollmentStore(
        storePath,
        record({
          ...stored,
          allowlist: issuedAllowlist(stored.threadId, [
            { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "watch"] },
          ]),
          endpoint: server.endpoint,
          token: "enrolled-token",
          enrollmentId: "enrollment-id",
          threadId: "enrolled-thread",
        }),
      );
      expect(
        await runDelegationCli({
          arguments: ["enroll", "revoke", "--client", "grok-bot"],
          environment,
          output: new PassThrough(),
          now,
        }),
      ).toBe(0);
      const afterRevoke = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["thread", "read", FIXTURE_PARENT_THREAD_ID],
          environment,
          diagnosticOutput: afterRevoke,
          now,
        }),
      ).toBe(1);
      expect(JSON.parse(outputText(afterRevoke)).error.details.reason).toBe(
        "missing_runtime_environment",
      );
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("rejects enroll from a foreign pid, parent env file, or impersonating parent Thread", async () => {
    const dataDir = await tempDataDir();
    const environment = { CODEXHOST_DATA_DIR: dataDir };
    for (const arguments_ of [
      ["enroll", "--client", "grok-bot", "--from-pid", "1"],
      ["enroll", "--client", "grok-bot", "--from-env-file", "/tmp/parent.env"],
      ["enroll", "--client", "grok-bot", "--as-thread", FIXTURE_PARENT_THREAD_ID],
    ]) {
      const diagnosticOutput = new PassThrough();
      expect(await runDelegationCli({ arguments: arguments_, environment, diagnosticOutput })).toBe(
        1,
      );
      expect(JSON.parse(outputText(diagnosticOutput)).error.code).toBe("ENROLLMENT_INVALID");
    }
  });

  it("fails closed when the enrollment token is expired", async () => {
    const dataDir = await tempDataDir();
    const environment = { CODEXHOST_DATA_DIR: dataDir };
    const expired = record({
      issuedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-02T00:00:00.000Z",
    });
    await writeEnrollmentStore(enrollmentStorePath(environment, "grok-bot"), expired);
    const diagnosticOutput = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: ["thread", "read", FIXTURE_PARENT_THREAD_ID],
        environment,
        diagnosticOutput,
        now: () => Date.parse("2026-11-07T12:00:00.000Z"),
      }),
    ).toBe(1);
    expect(JSON.parse(outputText(diagnosticOutput)).error.details.reason).toBe("expired");
  });

  it("prints enroll, status, and revoke in help", async () => {
    expect(DELEGATION_HELP).toContain("codexhost enroll --client <id>");
    expect(DELEGATION_HELP).toContain("codexhost enroll status");
    expect(DELEGATION_HELP).toContain("codexhost enroll revoke");
    for (const arguments_ of [
      ["enroll", "--help"],
      ["enroll", "status", "--help"],
      ["enroll", "revoke", "--help"],
    ]) {
      const output = new PassThrough();
      expect(await runDelegationCli({ arguments: arguments_, output })).toBe(0);
      expect(outputText(output)).toContain("enroll");
    }
  });
});
