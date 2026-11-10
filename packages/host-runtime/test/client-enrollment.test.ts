import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ENROLLMENT_TTL_MS,
  FIXTURE_PARENT_THREAD_ID,
  MACHINE_ENROLLMENT_TTL_MS,
  allowlistDigest,
  authorizeEnrollment,
  issuedAllowlist,
  parseAllowlistOption,
  enrollPairingFromOptions,
  parseEnrollmentPairing,
  verifyEnrollmentRecord,
  type EnrollmentAllowlistEntry,
  type EnrollmentRecord,
} from "../src/client-enrollment.js";
import { createStubEnrollmentConsent } from "../src/client-enrollment-consent.js";
import { EnrollmentAuthority } from "../src/client-enrollment-authority.js";
import {
  ENROLL_FROM_ENV_FILE_ENV,
  ENROLL_FROM_PID_ENV,
  enrollmentBootstrapPath,
  enrollmentStorePath,
  loadEnrollmentCredentialsFromEnvFile,
  readEnrollmentBootstrap,
  loadEnrollmentCredentialsFromPid,
  rejectForeignCredentialSources,
  writeEnrollmentBootstrap,
  writeEnrollmentStore,
} from "../src/client-enrollment-store.js";
import { resolveCliRuntimeConnection, runEnrollStatus } from "../src/delegation-cli-enrollment.js";
import { parseDelegationArguments } from "../src/delegation-cli-options.js";
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

function sequentialIds(ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index++];
    if (!id) throw new Error("unexpected enrollment id");
    return id;
  };
}

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
  const { allowlistDigest: digestOverride, ...rest } = overrides;
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
  it("parses session and machine pairing", () => {
    expect(parseEnrollmentPairing(undefined)).toBe("machine");
    expect(parseEnrollmentPairing("session")).toBe("session");
    expect(parseEnrollmentPairing("machine")).toBe("machine");
    expect(() => parseEnrollmentPairing("ssh")).toThrow(/pairing/u);
    expect(enrollPairingFromOptions(new Map())).toBe("machine");
    expect(enrollPairingFromOptions(new Map([["--machine", "true"]]))).toBe("machine");
    expect(enrollPairingFromOptions(new Map([["--machine", "false"]]))).toBe("machine");
    expect(enrollPairingFromOptions(new Map([["--session", "true"]]))).toBe("session");
    expect(() =>
      enrollPairingFromOptions(
        new Map([
          ["--machine", "true"],
          ["--session", "true"],
        ]),
      ),
    ).toThrow(/cannot both be set/u);
  });

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

  it("does not treat send as cancel on existing allowlists", () => {
    const allowlist: EnrollmentAllowlistEntry[] = [
      { threadId: "enrolled-thread", verbs: ["read", "watch", "send"] },
      { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "watch", "send"] },
    ];
    const issued = record({
      allowlist: [...allowlist],
      allowlistDigest: allowlistDigest(allowlist),
    });
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    expect(() =>
      authorizeEnrollment(issued, { type: "send", threadId: FIXTURE_PARENT_THREAD_ID }, now),
    ).not.toThrow();
    expect(() => {
      authorizeEnrollment(issued, { type: "cancel", threadId: FIXTURE_PARENT_THREAD_ID }, now);
    }).toThrowError(
      expect.objectContaining({
        code: "UNAUTHORIZED_TARGET",
        details: expect.objectContaining({ verb: "cancel" }),
      }),
    );
    expect(() => {
      authorizeEnrollment(issued, { type: "cancel", threadId: "enrolled-thread" }, now);
    }).toThrowError(
      expect.objectContaining({
        code: "UNAUTHORIZED_TARGET",
        details: expect.objectContaining({ verb: "cancel" }),
      }),
    );
  });

  it("authorizes cancel only when the grant is listed", () => {
    const issued = record({
      allowlist: issuedAllowlist("enrolled-thread", [
        { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "send", "cancel"] },
      ]),
    });
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    expect(() =>
      authorizeEnrollment(issued, { type: "cancel", threadId: FIXTURE_PARENT_THREAD_ID }, now),
    ).not.toThrow();
    expect(() =>
      authorizeEnrollment(issued, { type: "cancel", threadId: "enrolled-thread" }, now),
    ).not.toThrow();
    expect(parseAllowlistOption(`${FIXTURE_PARENT_THREAD_ID}:read,send,cancel`)).toEqual([
      { threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "send", "cancel"] },
    ]);
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
      createId: () => "enrollment-id",
      createThread: async () => "enrolled-thread",
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

  it("prefers live bootstrap endpoint over a stale enrollment store port", async () => {
    const dataDir = await tempDataDir();
    const stale = record({ endpoint: "http://127.0.0.1:49702" });
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "grok-bot"),
      stale,
    );
    await writeEnrollmentBootstrap(enrollmentBootstrapPath({ CODEXHOST_DATA_DIR: dataDir }), {
      schemaVersion: 1,
      endpoint: "http://127.0.0.1:50843",
      bootstrapToken: "bootstrap-token",
      pid: 9,
      startedAt: "2026-11-07T00:00:00.000Z",
    });
    const connection = await resolveCliRuntimeConnection({
      environment: { CODEXHOST_DATA_DIR: dataDir },
      parsed: { positionals: ["read"], options: new Map() },
      nowMs: Date.parse("2026-11-07T00:00:00.000Z"),
    });
    expect(connection.endpoint).toBe("http://127.0.0.1:50843");
    expect(connection.token).toBe("enrolled-token");
    expect(connection.source).toBe("enrollment");
  });

  it("reports the live bootstrap endpoint from enroll status without rotating the store", async () => {
    const dataDir = await tempDataDir();
    const stale = record({ endpoint: "http://127.0.0.1:49702" });
    const storePath = enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "grok-bot");
    await writeEnrollmentStore(storePath, stale);
    await writeEnrollmentBootstrap(enrollmentBootstrapPath({ CODEXHOST_DATA_DIR: dataDir }), {
      schemaVersion: 1,
      endpoint: "http://127.0.0.1:50843",
      bootstrapToken: "bootstrap-token",
      pid: 9,
      startedAt: "2026-11-07T00:00:00.000Z",
    });
    const result = await runEnrollStatus({
      environment: { CODEXHOST_DATA_DIR: dataDir },
      parsed: parseDelegationArguments(["enroll", "status"]),
      nowMs: Date.parse("2026-11-07T00:00:00.000Z"),
    });
    expect(result.view.endpoint).toBe("http://127.0.0.1:50843");
    expect(result.view.enrollmentId).toBe(stale.enrollmentId);
    const stored = JSON.parse(await readFile(storePath, "utf8")) as EnrollmentRecord;
    expect(stored.endpoint).toBe("http://127.0.0.1:49702");
  });

  it("refuses to issue enrollment without native Thread creation", async () => {
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: await tempDataDir(),
      consent: createStubEnrollmentConsent("approve"),
    });
    await enrollment.publishBootstrap("http://127.0.0.1:9");
    await expect(
      enrollment.enroll({
        clientId: "muse",
        executablePath: "/synthetic/muse",
        attendedHostApprove: true,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_UNREACHABLE",
    });
    await enrollment.close();
  });

  it("keeps a valid pairing when replacement native Thread creation fails", async () => {
    const createThread = vi.fn(async () => "native-own-thread");
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: await tempDataDir(),
      createThread,
    });
    await enrollment.publishBootstrap("http://127.0.0.1:9");
    try {
      const request = {
        clientId: "muse",
        executablePath: "/synthetic/muse",
        attendedHostApprove: true,
      };
      const first = await enrollment.enroll(request);
      createThread.mockRejectedValueOnce(new Error("native unavailable"));
      await expect(
        enrollment.enroll({ ...request, allowlist: [{ threadId: "new-target", verbs: ["read"] }] }),
      ).rejects.toThrow("native unavailable");
      expect(enrollment.status(`Bearer ${first.token}`).enrollmentId).toBe(first.enrollmentId);
      expect(enrollment.listPublic()).toHaveLength(1);
    } finally {
      await enrollment.close();
    }
  });

  it("reuses one native Thread for concurrent equivalent machine enrollment requests", async () => {
    const createThread = vi.fn(async () => "native-own-thread");
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: await tempDataDir(),
      createThread,
    });
    await enrollment.publishBootstrap("http://127.0.0.1:9");
    try {
      const request = {
        clientId: "muse",
        executablePath: "/synthetic/muse",
        attendedHostApprove: true,
      };
      const [first, second] = await Promise.all([
        enrollment.enroll(request),
        enrollment.enroll(request),
      ]);
      expect(first.enrollmentId).toBe(second.enrollmentId);
      expect(first.token).toBe(second.token);
      expect(createThread).toHaveBeenCalledExactlyOnceWith("muse");
    } finally {
      await enrollment.close();
    }
  });

  it("keeps a tailnet status endpoint even when local bootstrap is present", async () => {
    const environment = { CODEXHOST_DATA_DIR: await tempDataDir() };
    const storePath = enrollmentStorePath(environment, "grok-bot");
    const tailnet = record({ networkScope: "tailnet", endpoint: "http://100.64.0.1:4397" });
    await writeEnrollmentStore(storePath, tailnet);
    await writeEnrollmentBootstrap(enrollmentBootstrapPath(environment), {
      schemaVersion: 1,
      endpoint: "http://127.0.0.1:50843",
      bootstrapToken: "bootstrap-token",
      pid: 9,
      startedAt: "2026-11-07T00:00:00.000Z",
    });
    const { view } = await runEnrollStatus({
      environment,
      parsed: parseDelegationArguments(["enroll", "status"]),
      nowMs: Date.parse("2026-11-07T12:00:00.000Z"),
    });
    expect(view.endpoint).toBe(tailnet.endpoint);
    expect(JSON.parse(await readFile(storePath, "utf8"))).toEqual(tailnet);
  });

  it("preserves newer Runtime discovery when an older Runtime closes", async () => {
    const dataDirectory = await tempDataDir();
    const first = new EnrollmentAuthority({ hostToken: "first-host", dataDirectory });
    const second = new EnrollmentAuthority({ hostToken: "second-host", dataDirectory });
    await first.publishBootstrap("http://127.0.0.1:50001");
    await second.publishBootstrap("http://127.0.0.1:50002");
    const bootstrapPath = enrollmentBootstrapPath({ CODEXHOST_DATA_DIR: dataDirectory });
    const published = await readEnrollmentBootstrap(bootstrapPath);
    await first.close();
    expect(await readEnrollmentBootstrap(bootstrapPath)).toEqual(published);
    await second.close();
    expect(await readEnrollmentBootstrap(bootstrapPath)).toEqual(published);
  });

  it("reloads persisted enrollments onto a new Runtime listen port", async () => {
    const dataDir = await tempDataDir();
    const first = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("approve"),
      bootstrapToken: "bootstrap-token",
      createId: () => "enrollment-id",
      createThread: async () => "enrolled-thread",
      createToken: () => "enrolled-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const firstServer = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment: first,
    });
    try {
      await first.publishBootstrap(firstServer.endpoint);
      await first.enroll({
        clientId: "grok-bot",
        executablePath: "/synthetic/grok-bot",
        allowlist: [{ threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "watch"] }],
        attendedHostApprove: true,
      });
    } finally {
      await first.close();
      await firstServer.close();
    }
    const second = new EnrollmentAuthority({
      hostToken: "new-host-token",
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("timeout"),
      bootstrapToken: "new-bootstrap-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const secondServer = await startDelegationControlServer({
      token: "new-host-token",
      api: controlApi(),
      enrollment: second,
    });
    try {
      await second.publishBootstrap(secondServer.endpoint);
      const principal = second.authenticate("Bearer enrolled-token");
      expect(principal?.kind).toBe("enrollment");
      if (principal?.kind === "enrollment") {
        expect(principal.record.endpoint).toBe(secondServer.endpoint);
      }
    } finally {
      await second.close();
      await secondServer.close();
    }
  });

  it("treats Host-session enroll as attended approve without Desktop timeout", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("timeout"),
      bootstrapToken: "bootstrap-token",
      createId: () => "enrollment-id",
      createThread: async () => "enrolled-thread",
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

  it("reuses a machine pairing for the same client and allowlist without a second consent", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("timeout"),
      bootstrapToken: "bootstrap-token",
      createId: sequentialIds(["enroll-a", "enroll-b"]),
      createThread: (() => {
        const next = sequentialIds(["thread-a", "thread-b"]);
        return async () => next();
      })(),
      createToken: (() => {
        let index = 0;
        return () => {
          const token = ["machine-token", "replacement-token"][index++];
          if (!token) throw new Error("unexpected new enrollment token");
          return token;
        };
      })(),
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
    });
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const first = await enrollment.enroll({
        clientId: "cursor-box-grok",
        executablePath: "/synthetic/grok",
        allowlist: [{ threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "send"] }],
        pairing: "machine",
        attendedHostApprove: true,
      });
      expect(first.pairing).toBe("machine");
      expect(Date.parse(first.expiresAt) - Date.parse(first.issuedAt)).toBe(
        MACHINE_ENROLLMENT_TTL_MS,
      );
      await expect(
        enrollment.enroll({
          clientId: "cursor-box-grok",
          executablePath: "/synthetic/stolen",
          allowlist: [{ threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "send"] }],
          pairing: "machine",
        }),
      ).rejects.toThrow(/timed out/u);
      expect(enrollment.status("Bearer machine-token").enrollmentId).toBe("enroll-a");
      const output = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: [
            "enroll",
            "--machine",
            "--client",
            "cursor-box-grok",
            "--allow",
            `${FIXTURE_PARENT_THREAD_ID}:read,send`,
            "--executable",
            "/synthetic/cli-grok",
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
      const view = JSON.parse(outputText(output)) as { pairing?: string; enrollmentId: string };
      expect(view.pairing).toBe("machine");
      expect(view.enrollmentId).toBe("enroll-a");
      const stored = JSON.parse(
        await readFile(
          enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "cursor-box-grok"),
          "utf8",
        ),
      ) as EnrollmentRecord;
      expect(stored.token).toBe("machine-token");
      const replaced = await enrollment.enroll({
        clientId: "cursor-box-grok",
        executablePath: "/synthetic/grok",
        allowlist: [{ threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read"] }],
        pairing: "machine",
        attendedHostApprove: true,
      });
      expect(replaced.token).toBe("replacement-token");
      expect(replaced.enrollmentId).toBe("enroll-b");
      expect(enrollment.authenticate("Bearer machine-token")?.kind).toBe("enrollment");
      expect(() => enrollment.status("Bearer machine-token")).toThrow(/revoked/u);
      expect(enrollment.status("Bearer replacement-token").pairing).toBe("machine");
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("does not reuse a machine pairing for a bootstrap caller", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("timeout"),
      bootstrapToken: "bootstrap-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
      createThread: async () => "native-thread",
    });
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const first = await enrollment.enroll({
        clientId: "cursor-box-grok",
        executablePath: "/synthetic/grok",
        allowlist: [{ threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "send"] }],
        pairing: "machine",
        attendedHostApprove: true,
      });
      const response = await fetch(new URL("/v1/enroll", server.endpoint), {
        method: "POST",
        headers: {
          authorization: "Bearer bootstrap-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId: "cursor-box-grok",
          executablePath: "/synthetic/stolen",
          allowlist: [{ threadId: FIXTURE_PARENT_THREAD_ID, verbs: ["read", "send"] }],
          pairing: "machine",
        }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error?: { code?: string }; token?: string };
      expect(body.error?.code).toBe("ENROLLMENT_DENIED");
      expect(body.token).toBeUndefined();
      expect(enrollment.status(`Bearer ${first.token}`).enrollmentId).toBe(first.enrollmentId);
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("defaults enrollment to revoke-only machine pairing", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("approve"),
      bootstrapToken: "bootstrap-token",
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
      createThread: async () => "native-thread",
    });
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      const issued = await enrollment.enroll({
        clientId: "grok-bot",
        executablePath: "/synthetic/grok-bot",
        attendedHostApprove: true,
      });
      expect(issued.pairing).toBe("machine");
      expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt)).toBe(
        MACHINE_ENROLLMENT_TTL_MS,
      );
      const session = await enrollment.enroll({
        clientId: "grok-bot-session",
        executablePath: "/synthetic/grok-bot",
        pairing: "session",
        attendedHostApprove: true,
      });
      expect(session.pairing).toBe("session");
      expect(Date.parse(session.expiresAt) - Date.parse(session.issuedAt)).toBe(
        DEFAULT_ENROLLMENT_TTL_MS,
      );
    } finally {
      await enrollment.close();
      await server.close();
    }
  });

  it("does not store an enrollment when Runtime ignores the requested pairing", async () => {
    const dataDir = await tempDataDir();
    const diagnosticOutput = new PassThrough();
    const issued = record();
    expect(issued.pairing).toBeUndefined();
    expect(
      await runDelegationCli({
        arguments: [
          "enroll",
          "--machine",
          "--client",
          "grok-bot",
          "--executable",
          "/synthetic/grok-bot",
        ],
        environment: {
          CODEXHOST_DATA_DIR: dataDir,
          [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:9",
          [DELEGATION_RUNTIME_TOKEN_ENV]: PARENT_TOKEN,
        },
        output: new PassThrough(),
        diagnosticOutput,
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(issued), { status: 200 })),
        now: () => Date.parse("2026-11-07T12:00:00.000Z"),
      }),
    ).toBe(1);
    expect(JSON.parse(outputText(diagnosticOutput)).error).toMatchObject({
      code: "ENROLLMENT_INVALID",
      message: "Host issued a different enrollment pairing",
      details: { reason: "pairing_mismatch" },
    });
    await expect(
      readFile(enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "grok-bot")),
    ).rejects.toThrow();
  });

  it("fails unmanaged enroll immediately when Desktop has no consent UI", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      bootstrapToken: "bootstrap-token",
    });
    const server = await startDelegationControlServer({
      token: PARENT_TOKEN,
      api: controlApi(),
      enrollment,
    });
    try {
      await enrollment.publishBootstrap(server.endpoint);
      await expect(
        enrollment.enroll({
          clientId: "grok-bot",
          executablePath: "/synthetic/grok-bot",
        }),
      ).rejects.toMatchObject({
        code: "ENROLLMENT_DENIED",
        details: { reason: "consent_ui_unavailable" },
      });
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
      createId: () => "enrollment-id",
      createThread: async () => "enrolled-thread",
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
      createId: () => "enrollment-id",
      createThread: async () => "enrolled-thread",
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

  it("lists active public enrollments without tokens and revokes by id", async () => {
    const dataDir = await tempDataDir();
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: dataDir,
      consent: createStubEnrollmentConsent("approve"),
      now: () => Date.parse("2026-11-07T00:00:00.000Z"),
      createId: () => "enroll-list",
      createThread: async () => "thread-list",
      createToken: () => "listed-token",
    });
    await enrollment.publishBootstrap("http://127.0.0.1:9");
    const issued = await enrollment.enroll({
      clientId: "cursor-box-grok",
      executablePath: "/synthetic/grok",
      pairing: "machine",
      attendedHostApprove: true,
    });
    await writeEnrollmentStore(
      enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "cursor-box-grok"),
      issued,
    );
    const listed = enrollment.listPublic();
    expect(listed).toEqual([
      expect.objectContaining({
        enrollmentId: "enroll-list",
        clientId: "cursor-box-grok",
        pairing: "machine",
        executablePath: "/synthetic/grok",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("listed-token");
    expect(JSON.stringify(listed)).not.toMatch(/"token"/u);
    await expect(enrollment.revokeEnrollment("missing")).rejects.toThrow(/not active/u);
    expect(await enrollment.revokeEnrollment("enroll-list")).toEqual({
      enrollmentId: "enroll-list",
      revoked: true,
    });
    expect(enrollment.listPublic()).toEqual([]);
    await expect(
      readFile(enrollmentStorePath({ CODEXHOST_DATA_DIR: dataDir }, "cursor-box-grok"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await enrollment.close();
  });

  it("omits expired enrollments from the Host list", async () => {
    let nowMs = Date.parse("2026-11-07T00:00:00.000Z");
    const enrollment = new EnrollmentAuthority({
      hostToken: PARENT_TOKEN,
      dataDirectory: await tempDataDir(),
      consent: createStubEnrollmentConsent("approve"),
      now: () => nowMs,
      createToken: () => "session-token",
      createThread: async () => "session-thread",
    });
    await enrollment.publishBootstrap("http://127.0.0.1:9");
    await enrollment.enroll({
      clientId: "grok-bot",
      executablePath: "/synthetic/grok-bot",
      pairing: "session",
      attendedHostApprove: true,
    });
    expect(enrollment.listPublic()).toHaveLength(1);
    nowMs += DEFAULT_ENROLLMENT_TTL_MS + 1;
    expect(enrollment.listPublic()).toEqual([]);
    await enrollment.close();
  });

  it("prints enroll, status, and revoke in help", async () => {
    expect(DELEGATION_HELP).toContain("codexhost enroll --client <id>");
    expect(DELEGATION_HELP).toContain("codexhost enroll status");
    expect(DELEGATION_HELP).toContain("codexhost enroll revoke");
    const enrollHelp = new PassThrough();
    expect(await runDelegationCli({ arguments: ["enroll", "--help"], output: enrollHelp })).toBe(0);
    const enrollHelpText = outputText(enrollHelp);
    expect(enrollHelpText).toContain("--machine");
    expect(enrollHelpText).toContain("--session");
    expect(enrollHelpText).toContain("consent_ui_unavailable");
    const sendHelp = new PassThrough();
    expect(
      await runDelegationCli({ arguments: ["thread", "send", "--help"], output: sendHelp }),
    ).toBe(0);
    const sendHelpText = outputText(sendHelp);
    expect(sendHelpText).toContain("--enrolled-client");
    expect(sendHelpText).toContain("No new Turn started");
    expect(sendHelpText).not.toContain("wait or cancel before sending");
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
