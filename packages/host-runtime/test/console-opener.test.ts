import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  consoleEntrypoint,
  createHostConsoleOpener,
  isolatedHostConsolePort,
  parseConsoleAddress,
} from "../src/console-opener.js";

function fakeChild(stdout: string, stderr: string, code: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  setImmediate(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    setImmediate(() => child.emit("exit", code));
  });
  return child;
}

describe("Host console opener", () => {
  it("ensures the console without opening a browser and sends bounded settings operations", async () => {
    const received: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        path: request.url,
        header: request.headers["x-codexhost-console"],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ settings: "fixture" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const spawnProcess = vi.fn(() =>
      fakeChild(`codexhost console: http://127.0.0.1:${address.port}/\n`, "", 0),
    );
    const opener = createHostConsoleOpener({
      entrypoint: "/console.mjs",
      environment: {},
      spawnProcess: spawnProcess as never,
    });
    try {
      await expect(opener.voiceSettings?.({ operation: "get" })).resolves.toEqual({
        settings: "fixture",
      });
      await opener.voiceSettings?.({ operation: "migrate", routes: {} });
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(spawnProcess.mock.calls[0]).toEqual([
        process.execPath,
        ["/console.mjs", "ensure"],
        expect.any(Object),
      ]);
      expect(received).toEqual([
        { path: "/api/voice-settings", header: "1", body: { operation: "get" } },
        { path: "/api/voice-settings", header: "1", body: { operation: "migrate", routes: {} } },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("finds the console beside a release Host Runtime or in a source checkout", () => {
    expect(consoleEntrypoint("/opt/codexhost/app/host-runtime.mjs", () => true)).toBe(
      path.join("/opt/codexhost/app", "console-server.mjs"),
    );
    expect(consoleEntrypoint("/repo/packages/host-runtime/dist/main.js", () => true)).toBe(
      path.resolve("/repo/packages/console-server/dist/main.js"),
    );
    expect(consoleEntrypoint("/opt/codexhost/app/host-runtime.mjs", () => false)).toBeNull();
  });

  it("reports the console root address", () => {
    expect(
      parseConsoleAddress("codexhost console: http://127.0.0.1:4399/?view=diagnostics\n"),
    ).toBe("http://127.0.0.1:4399/");
    expect(parseConsoleAddress("codexhost console: https://evil.example/\n")).toBeNull();
    expect(parseConsoleAddress("nothing\n")).toBeNull();
  });

  it("runs console-server open with the Host environment", async () => {
    const spawnProcess = vi.fn(() =>
      fakeChild("codexhost console: http://127.0.0.1:4399/\n", "", 0),
    );
    const opener = createHostConsoleOpener({
      entrypoint: "/opt/codexhost/app/console-server.mjs",
      environment: { CODEXHOST_LAUNCHER_EXECUTABLE: "/opt/codexhost/bin/codexhost" },
      nodePath: "/opt/codexhost/runtime/node",
      spawnProcess: spawnProcess as never,
    });
    await expect(opener.open()).resolves.toEqual({ url: "http://127.0.0.1:4399/" });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/codexhost/runtime/node",
      ["/opt/codexhost/app/console-server.mjs", "open"],
      expect.objectContaining({
        env: { CODEXHOST_LAUNCHER_EXECUTABLE: "/opt/codexhost/bin/codexhost" },
      }),
    );
  });

  it("surfaces the console's error", async () => {
    const opener = createHostConsoleOpener({
      entrypoint: "/console.mjs",
      environment: {},
      spawnProcess: (() =>
        fakeChild("", "codexhost console: port 4399 is used by another program\n", 1)) as never,
    });
    await expect(opener.open()).rejects.toThrow("port 4399 is used by another program");
  });

  it("pins a unique console port for an isolated Host data directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "codexhost-isolated-console-"));
    const spawnProcess = vi.fn(() =>
      fakeChild("codexhost console: http://127.0.0.1:54321/\n", "", 0),
    );
    const opener = createHostConsoleOpener({
      entrypoint: "/console.mjs",
      environment: { CODEXHOST_DATA_DIR: data },
      spawnProcess: spawnProcess as never,
    });
    await opener.open();
    const port = isolatedHostConsolePort(data);
    expect(port).not.toBe("4399");
    expect(Number(port)).toBeGreaterThanOrEqual(49152);
    expect(Number(port)).toBeLessThanOrEqual(65535);
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["/console.mjs", "open"],
      expect.objectContaining({ env: expect.objectContaining({ CODEXHOST_CONSOLE_PORT: port }) }),
    );
    expect(await readFile(path.join(data, "console", "listen-port"), "utf8")).toBe(`${port}\n`);
  });

  it("keeps an explicit console port and the default shared-Host port", async () => {
    const spawnIsolated = vi.fn(() =>
      fakeChild("codexhost console: http://127.0.0.1:51234/\n", "", 0),
    );
    await createHostConsoleOpener({
      entrypoint: "/console.mjs",
      environment: {
        CODEXHOST_DATA_DIR: "/tmp/codexhost-isolated-host",
        CODEXHOST_CONSOLE_PORT: "51234",
      },
      spawnProcess: spawnIsolated as never,
    }).open();
    expect(spawnIsolated).toHaveBeenCalledWith(
      process.execPath,
      ["/console.mjs", "open"],
      expect.objectContaining({
        env: expect.objectContaining({ CODEXHOST_CONSOLE_PORT: "51234" }),
      }),
    );
    const spawnDefault = vi.fn(() =>
      fakeChild("codexhost console: http://127.0.0.1:4399/\n", "", 0),
    );
    await createHostConsoleOpener({
      entrypoint: "/console.mjs",
      environment: { CODEXHOST_DATA_DIR: path.join(homedir(), ".codexhost") },
      spawnProcess: spawnDefault as never,
    }).open();
    expect(spawnDefault).toHaveBeenCalledWith(
      process.execPath,
      ["/console.mjs", "open"],
      expect.objectContaining({
        env: { CODEXHOST_DATA_DIR: path.join(homedir(), ".codexhost") },
      }),
    );
  });
});
