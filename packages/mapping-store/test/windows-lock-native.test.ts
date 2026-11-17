import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MappingStore } from "../src/index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function traceIdentityQuery(query: string): string {
  const marker = (stage: string) =>
    `[Console]::Error.WriteLine('identity-stage ${stage} ' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())`;
  const stages = [
    ["$process = [Diagnostics.Process]::GetProcessById(", "get-process"],
    ["$startTime = $process.StartTime", "start-time"],
    ["$executablePath = $process.MainModule.FileName", "main-module"],
    ["if ($null -eq $startTime)", "direct-done"],
    ["$process = Get-CimInstance", "cim"],
    ["[Console]::OutputEncoding =", "output"],
  ] as const;
  for (const [statement, stage] of stages) {
    if (!query.includes(statement)) throw new Error(`Missing identity query stage: ${stage}`);
    query = query.replace(statement, `${marker(stage)}; ${statement}`);
  }
  return `${marker("script-start")}; ${query}; ${marker("script-done")}`;
}

async function nativeExecFileSync(): Promise<typeof execFileSync> {
  const actual = await vi.importActual<typeof ChildProcessModule>("node:child_process");
  return actual.execFileSync;
}

// Exercise the actual Windows PowerShell/CIM query, not the current-PID shortcut.
// Access to a protected system process is covered separately by simulated OS replies.
describe.skipIf(process.platform !== "win32")("Windows native Mapping Store lock ownership", () => {
  let directory: string;
  let owner: ChildProcess;
  let store: MappingStore;
  let processStartedAt: string;
  let queryPrelude: string;

  beforeEach(async () => {
    vi.mocked(execFileSync).mockReset();
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-windows-native-lock-"));
    queryPrelude = "";
    const execFile = await nativeExecFileSync();
    vi.mocked(execFileSync).mockImplementation((file, args, options) => {
      const originalQuery = Array.isArray(args) ? args.at(-1) : undefined;
      if (!Array.isArray(args) || typeof originalQuery !== "string") {
        throw new Error("Missing native identity query arguments");
      }
      const query = traceIdentityQuery(`${queryPrelude}${originalQuery}`);
      queryPrelude = "";
      // A file descriptor retains stage markers on both success and timeout;
      // stdout remains the identity response consumed by Mapping Store.
      const diagnosticsPath = path.join(directory, "identity-query.stderr");
      const diagnostics = openSync(diagnosticsPath, "w");
      const startedAt = Date.now();
      let failure: unknown;
      try {
        return execFile(file, [...args.slice(0, -1), query], {
          ...options,
          stdio: ["ignore", "pipe", diagnostics],
        });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        closeSync(diagnostics);
        const stages = readFileSync(diagnosticsPath, "utf8")
          .split(/\r?\n/)
          .filter((line) => line.startsWith("identity-stage "))
          .map((line) => {
            const [, stage, time] = line.split(" ");
            return { stage, elapsedMs: Number(time) - startedAt };
          });
        const timing = {
          elapsedMs: Date.now() - startedAt,
          stages,
          ...(failure && typeof failure === "object" && "code" in failure
            ? { errorCode: failure.code }
            : {}),
        };
        console.info("[windows-lock-query]", JSON.stringify(timing));
        if (failure instanceof Error) Object.assign(failure, { identityQueryTiming: timing });
      }
    });
    owner = spawn(
      process.execPath,
      [
        "-e",
        "process.send(new Date(Date.now() - process.uptime() * 1000).toISOString()); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const [startedAt] = await once(owner, "message");
    if (typeof startedAt !== "string") throw new Error("Missing fixture process start time");
    processStartedAt = startedAt;
    store = new MappingStore({ directory });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store?.close();
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit");
      owner.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function writeLock(startedAt: string | undefined, pid = owner.pid): Promise<string> {
    const content = JSON.stringify({
      pid,
      instanceId: "previous-owner",
      startedAt: new Date(0).toISOString(),
      executablePath: process.execPath,
      processStartedAt: startedAt,
    });
    await writeFile(path.join(directory, "store.lock"), content);
    return content;
  }

  function expectNativeIdentity(): void {
    expect(execFileSync).toHaveBeenCalledOnce();
    const result = vi.mocked(execFileSync).mock.results[0];
    if (result?.type !== "return") {
      throw new Error("Native identity lookup did not succeed", { cause: result?.value });
    }
    expect(Number.isFinite(Date.parse(String(result.value).split(/\r?\n/)[0] ?? ""))).toBe(true);
  }

  function prependQuery(script: string): void {
    queryPrelude = `${script}; `;
  }

  it("recovers a stale lock with the same PID and executable but a different creation time", async () => {
    // Ordinary owners must be identifiable even when the CIM service is unavailable.
    prependQuery("function Get-CimInstance { throw 'CIM unavailable' }");
    await writeLock(new Date(0).toISOString());
    try {
      await store.initialize();
    } catch (error) {
      // Mapping Store preserves live locks when metadata is unavailable. Surface the
      // real native query error here so runner failures retain their original cause.
      const queryFailure = vi.mocked(execFileSync).mock.results.find((r) => r.type === "throw");
      if (queryFailure) {
        throw new Error("Native Windows process identity query failed", {
          cause: queryFailure.value,
        });
      }
      throw error;
    }
    expect(JSON.parse(await readFile(path.join(directory, "store.lock"), "utf8"))).toMatchObject({
      pid: process.pid,
    });
    expectNativeIdentity();
    // Reclaiming the lock must not stop the unrelated process that reused the PID.
    if (owner.pid === undefined) throw new Error("Missing fixture process PID");
    expect(process.kill(owner.pid, 0)).toBe(true);
  });

  it("uses CIM creation time when direct process metadata is unavailable", async () => {
    // A missing PID makes the direct API fail; simulate the protected-process case
    // with a live probe and CIM reply while executing the real PowerShell fallback.
    const inaccessiblePid = 2_147_483_647;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    prependQuery(
      "function Get-CimInstance { [pscustomobject]@{ " +
        "ExecutablePath = $null; CreationDate = [DateTime]::UtcNow } }",
    );
    await writeLock(new Date(0).toISOString(), inaccessiblePid);
    await store.initialize();
    expect(JSON.parse(await readFile(path.join(directory, "store.lock"), "utf8"))).toMatchObject({
      pid: process.pid,
    });
    expectNativeIdentity();
    expect(kill).toHaveBeenCalledExactlyOnceWith(inaccessiblePid, 0);
  });

  it("returns a non-ASCII executable path from the native query without corruption", async () => {
    const inaccessiblePid = 2_147_483_647;
    vi.spyOn(process, "kill").mockReturnValue(true);
    const executablePath = "C:\\測試\\café\\node.exe";
    prependQuery(
      "function Get-CimInstance { [pscustomobject]@{ " +
        `ExecutablePath = '${executablePath}'; CreationDate = [DateTime]::UtcNow } }`,
    );
    await writeLock(new Date(0).toISOString(), inaccessiblePid);
    await store.initialize();
    expectNativeIdentity();
    const result = vi.mocked(execFileSync).mock.results[0];
    if (result?.type !== "return") throw new Error("Native identity lookup did not succeed");
    expect(String(result.value).split(/\r?\n/)[1]).toBe(executablePath);
  });

  it("preserves a real live owner's lock", async () => {
    const content = await writeLock(processStartedAt);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
    expectNativeIdentity();
  });

  it("preserves the live owner's lock when the native query times out", async () => {
    prependQuery("Start-Sleep -Seconds 6");
    const content = await writeLock(processStartedAt);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(vi.mocked(execFileSync).mock.results[0]).toMatchObject({
      type: "throw",
      value: {
        code: "ETIMEDOUT",
        identityQueryTiming: { stages: [{ stage: "script-start", elapsedMs: expect.any(Number) }] },
      },
    });
    if (owner.pid === undefined) throw new Error("Missing fixture process PID");
    expect(process.kill(owner.pid, 0)).toBe(true);
  });

  it("preserves a legacy lock without the process creation time", async () => {
    const content = await writeLock(undefined);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
    expectNativeIdentity();
  });
});
