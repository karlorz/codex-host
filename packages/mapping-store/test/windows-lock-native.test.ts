import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MappingStore } from "../src/index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// Exercise the actual Windows PowerShell/CIM query, not the current-PID shortcut.
// Access to a protected system process is covered separately by simulated OS replies.
describe.skipIf(process.platform !== "win32")("Windows native Mapping Store lock ownership", () => {
  let directory: string;
  let owner: ChildProcess;
  let store: MappingStore;
  let processStartedAt: string;

  beforeEach(async () => {
    vi.mocked(execFileSync).mockReset();
    const actual = await vi.importActual<typeof ChildProcessModule>("node:child_process");
    vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-windows-native-lock-"));
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

  async function prependQuery(script: string): Promise<void> {
    const actual = await vi.importActual<typeof ChildProcessModule>("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce((file, args, options) => {
      if (!Array.isArray(args)) throw new Error("Missing native query arguments");
      return actual.execFileSync(
        file,
        [...args.slice(0, -1), `${script}; ${args.at(-1)}`],
        options,
      );
    });
  }

  it("recovers a stale lock with the same PID and executable but a different creation time", async () => {
    // Ordinary owners must be identifiable even when the CIM service is unavailable.
    await prependQuery("function Get-CimInstance { throw 'CIM unavailable' }");
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
    // Reclaiming the lock must not stop the unrelated process that reused the PID.
    if (owner.pid === undefined) throw new Error("Missing fixture process PID");
    expect(process.kill(owner.pid, 0)).toBe(true);
  });

  it("uses CIM creation time when direct process metadata is unavailable", async () => {
    // A missing PID makes the direct API fail; simulate the protected-process case
    // with a live probe and CIM reply while executing the real PowerShell fallback.
    const inaccessiblePid = 2_147_483_647;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    await prependQuery(
      "function Get-CimInstance { [pscustomobject]@{ " +
        "ExecutablePath = $null; CreationDate = [DateTime]::UtcNow } }",
    );
    await writeLock(new Date(0).toISOString(), inaccessiblePid);
    await store.initialize();
    expect(JSON.parse(await readFile(path.join(directory, "store.lock"), "utf8"))).toMatchObject({
      pid: process.pid,
    });
    expect(kill).toHaveBeenCalledExactlyOnceWith(inaccessiblePid, 0);
  });

  it("preserves a real live owner's lock", async () => {
    const content = await writeLock(processStartedAt);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
  });

  it("preserves a legacy lock without the process creation time", async () => {
    const content = await writeLock(undefined);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
  });
});
