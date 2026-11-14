import { describe, expect, it } from "vitest";

import {
  PROBE_OUTCOMES,
  commandOwnsIsolatedCandidate,
  lookupListenerCommand,
  parseProbeArguments,
  probeIsolatedRuntimeEnable,
  readJsonWithDeadline,
  websocketMatchesVerifiedListener,
} from "./isolated-runtime-enable.mjs";

const isolatedApp = "/tmp/.codexhost/update-impact/26.1106.51428/bundle/ChatGPT.app";
const isolatedData = "/tmp/.codexhost/update-impact/26.1106.51428/electron-user-data";

describe("isolated Runtime.enable probe", () => {
  it("requires loopback endpoint plus owned isolated identity", () => {
    expect(parseProbeArguments(["http://127.0.0.1:9229"])).toEqual({
      ok: false,
      error: PROBE_OUTCOMES.invalidArgs,
    });
    expect(
      parseProbeArguments([
        "http://10.0.0.8:9229",
        "--app-path",
        isolatedApp,
        "--user-data",
        isolatedData,
      ]),
    ).toEqual({ ok: false, error: PROBE_OUTCOMES.endpointNotLoopback });
    expect(
      parseProbeArguments([
        "http://127.0.0.1:9229",
        "--app-path",
        "/Applications/ChatGPT.app",
        "--user-data",
        isolatedData,
      ]),
    ).toEqual({ ok: false, error: PROBE_OUTCOMES.productionIdentity });
    expect(
      commandOwnsIsolatedCandidate(
        `${isolatedApp}/Contents/MacOS/ChatGPT --user-data-dir=${isolatedData} --remote-debugging-port=60628`,
        isolatedApp,
        isolatedData,
      ),
    ).toBe(true);
    expect(
      commandOwnsIsolatedCandidate(
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=62533",
        isolatedApp,
        isolatedData,
      ),
    ).toBe(false);
    expect(
      parseProbeArguments([
        "http://127.0.0.1:9229",
        "--app-path",
        "C:\\Users\\user\\AppData\\Local\\ChatGPT\\app-26.1106\\ChatGPT.exe",
        "--user-data",
        isolatedData,
      ]),
    ).toEqual({ ok: false, error: PROBE_OUTCOMES.productionIdentity });
  });

  it("matches a loopback websocket only when it is the verified listener port", () => {
    expect(websocketMatchesVerifiedListener("ws://127.0.0.1:9229/devtools/page/ab", 9229)).toBe(
      true,
    );
    expect(websocketMatchesVerifiedListener("ws://[::1]:9229/devtools/page/ab", 9229)).toBe(true);
    expect(websocketMatchesVerifiedListener("ws://127.0.0.1:19999/devtools/page/ab", 9229)).toBe(
      false,
    );
    expect(websocketMatchesVerifiedListener("ws://10.0.0.8:9229/devtools/page/ab", 9229)).toBe(
      false,
    );
  });

  it("resolves a Windows loopback listener from netstat and process identity", () => {
    const spawnSync = (command) => {
      if (command === "netstat") {
        return {
          status: 0,
          stdout:
            "  TCP    0.0.0.0:9229    0.0.0.0:0    LISTENING    7\r\n  TCP    127.0.0.1:9229    0.0.0.0:0    LISTENING    4242\r\n",
        };
      }
      if (command === "powershell.exe") {
        return {
          status: 0,
          stdout: JSON.stringify({
            ExecutablePath: `${isolatedApp}\\ChatGPT.exe`,
            CommandLine: `"${isolatedApp}\\ChatGPT.exe" --user-data-dir=${isolatedData}`,
          }),
        };
      }
      return { status: 1, stdout: "" };
    };
    const listener = lookupListenerCommand(9229, { platform: "win32", spawnSync });
    expect(listener).toEqual({
      pid: 4242,
      commandLine: expect.stringContaining(isolatedData),
    });
    expect(commandOwnsIsolatedCandidate(listener.commandLine, isolatedApp, isolatedData)).toBe(
      true,
    );
    expect(
      lookupListenerCommand(9229, {
        platform: "win32",
        spawnSync: () => ({ status: 1, stdout: "" }),
      }),
    ).toBe(null);
  });

  it("rejects a mismatched listener without forwarding raw CDP errors", async () => {
    const result = await probeIsolatedRuntimeEnable({
      arguments: [
        "http://127.0.0.1:9229",
        "--app-path",
        isolatedApp,
        "--user-data",
        isolatedData,
        "--timeout-ms",
        "200",
      ],
      lookupListener: () => ({
        pid: 1,
        commandLine:
          "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9229",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PROBE_OUTCOMES.identityMismatch);
    expect(JSON.stringify(result)).not.toContain("ChatGPT.app/Contents");
  });

  it("aborts a stalled target-list body and returns a fixed timeout code", async () => {
    const result = await probeIsolatedRuntimeEnable({
      arguments: [
        "http://127.0.0.1:9229",
        "--app-path",
        isolatedApp,
        "--user-data",
        isolatedData,
        "--timeout-ms",
        "50",
      ],
      lookupListener: () => ({
        pid: 9,
        commandLine: `${isolatedApp}/Contents/MacOS/ChatGPT --user-data-dir=${isolatedData} --remote-debugging-port=9229`,
      }),
      fetchImpl: async () => ({
        ok: true,
        json: () => new Promise(() => {}),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PROBE_OUTCOMES.targetListTimeout);
    expect(result.error).not.toMatch(/ /);
  });

  it("readJsonWithDeadline rejects after abort without leaking payload text", async () => {
    const controller = new AbortController();
    const pending = readJsonWithDeadline({ json: () => new Promise(() => {}) }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ outcome: PROBE_OUTCOMES.targetListTimeout });
  });

  it("does not enable Runtime on a websocket that is not the verified listener", async () => {
    const opened = [];
    const result = await probeIsolatedRuntimeEnable({
      arguments: [
        "http://127.0.0.1:9229",
        "--app-path",
        isolatedApp,
        "--user-data",
        isolatedData,
        "--timeout-ms",
        "200",
      ],
      lookupListener: () => ({
        pid: 9,
        commandLine: `${isolatedApp}/Contents/MacOS/ChatGPT --user-data-dir=${isolatedData} --remote-debugging-port=9229`,
      }),
      fetchImpl: async () => ({
        ok: true,
        json: async () => [
          {
            type: "page",
            url: "app://-/index.html",
            webSocketDebuggerUrl: "ws://127.0.0.1:19999/devtools/page/ab",
          },
        ],
      }),
      socketFactory: (url) => {
        opened.push(url);
        throw new Error("socket factory must not run");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PROBE_OUTCOMES.listenerWebsocketMismatch);
    expect(opened).toEqual([]);
  });

  it("enables Runtime only on the websocket that matches the verified listener", async () => {
    const opened = [];
    const result = await probeIsolatedRuntimeEnable({
      arguments: [
        "http://127.0.0.1:9229",
        "--app-path",
        isolatedApp,
        "--user-data",
        isolatedData,
        "--timeout-ms",
        "200",
      ],
      lookupListener: () => ({
        pid: 9,
        commandLine: `${isolatedApp}/Contents/MacOS/ChatGPT --user-data-dir=${isolatedData} --remote-debugging-port=9229`,
      }),
      fetchImpl: async () => ({
        ok: true,
        json: async () => [
          {
            type: "page",
            url: "app://-/index.html",
            webSocketDebuggerUrl: "ws://127.0.0.1:19999/devtools/page/stale",
          },
          {
            type: "page",
            url: "app://-/index.html",
            webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/owned",
          },
        ],
      }),
      socketFactory: (url) => {
        opened.push(url);
        const listeners = { open: [], message: [], error: [] };
        queueMicrotask(() => {
          for (const listener of listeners.open) listener();
        });
        return {
          addEventListener(type, listener) {
            listeners[type].push(listener);
          },
          send() {
            for (const listener of listeners.message) {
              listener({ data: JSON.stringify({ id: 1, result: {} }) });
            }
          },
          close() {},
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(opened).toEqual(["ws://127.0.0.1:9229/devtools/page/owned"]);
  });
});
