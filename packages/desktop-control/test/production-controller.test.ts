import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopControllerArguments,
  runDesktopController,
  serializeDesktopControllerReadiness,
  type DesktopControllerDependencies,
} from "../src/production-controller.js";
import type { RendererCdpControlSession } from "../src/renderer-cdp-control-session.js";
import { CdpConnectionClosedError } from "../src/cdp-client.js";
import { connectControllerVoiceHost } from "../src/controller-voice-host.js";
import type { ControllerVoiceHost } from "../src/controller-voice-host.js";

vi.mock("../src/controller-voice-host.js", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    connectControllerVoiceHost: typeof connectControllerVoiceHost;
  };
  return {
    ...actual,
    connectControllerVoiceHost: vi.fn(actual.connectControllerVoiceHost),
  };
});

const attachmentNonce = "0123456789abcdef0123456789abcdef";

function controllerOptions() {
  return {
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    rendererPath: "/renderer.js",
    attachmentPort: 43124,
    attachmentNonce,
  };
}

function attachmentServer() {
  return { close: vi.fn(async () => {}) };
}

function controllerSnapshot(): RendererCdpControlSession["snapshot"] {
  return {} as RendererCdpControlSession["snapshot"];
}

async function withoutPinnedDesktopVersion<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEXHOST_DESKTOP_VERSION;
  delete process.env.CODEXHOST_DESKTOP_VERSION;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CODEXHOST_DESKTOP_VERSION;
    else process.env.CODEXHOST_DESKTOP_VERSION = previous;
  }
}

const DESKTOP_IDENTITY_ENV = [
  "CODEXHOST_CPA_LIVE_VOICE",
  "CODEXHOST_DESKTOP_VERSION",
  "CODEXHOST_DESKTOP_BUILD",
  "CODEXHOST_DESKTOP_ASAR_DIGEST",
  "CODEXHOST_DESKTOP_APP_PATH",
] as const;

async function withDesktopIdentityEnv<T>(
  values: Partial<Record<(typeof DESKTOP_IDENTITY_ENV)[number], string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    DESKTOP_IDENTITY_ENV.map((key) => [key, process.env[key]]),
  ) as Record<(typeof DESKTOP_IDENTITY_ENV)[number], string | undefined>;
  for (const key of DESKTOP_IDENTITY_ENV) {
    const value = values[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const key of DESKTOP_IDENTITY_ENV) {
      const value = previous[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

describe("production Desktop Controller", () => {
  it("accepts only a loopback Renderer CDP endpoint, absolute Renderer path, and strict attachment fields", () => {
    const rendererPath = path.resolve("fixtures/renderer-extension.js");
    expect(
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        attachmentNonce,
      ]),
    ).toEqual({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererPath,
      attachmentPort: 43124,
      attachmentNonce,
    });
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://example.com:43123",
        "--renderer",
        "/renderer.js",
      ]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        "renderer.js",
      ]),
    ).toThrow("absolute path");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        "bad",
      ]),
    ).toThrow("32 lowercase hexadecimal");
    expect(
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        attachmentNonce,
        "--host-data",
        "/tmp/isolated-host",
      ]),
    ).toMatchObject({ hostDataDirectory: path.normalize("/tmp/isolated-host") });
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        attachmentNonce,
        "--host-data",
        "relative-host",
      ]),
    ).toThrow("absolute path");
  });

  it("serializes only strict and bounded readiness results", () => {
    expect(
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "compatible",
        issues: [],
      }),
    ).toBe('{"schemaVersion":2,"state":"compatible","issues":[]}');
    expect(() =>
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "incompatible",
        issues: [],
      } as never),
    ).toThrow("readiness is invalid");
  });

  it("signals compatible readiness, serves attachment, and monitors recovery", async () => {
    await withoutPinnedDesktopVersion(async () => {
      const abort = new AbortController();
      const snapshot = controllerSnapshot();
      const ensureInstalled = vi.fn(async () => {
        abort.abort();
        return snapshot;
      });
      const activateDesktop = vi.fn(async () => 1);
      const close = vi.fn();
      const session: RendererCdpControlSession = {
        snapshot,
        ensureInstalled,
        activateDesktop,
        attachVoiceHost: vi.fn(async () => {}),
        executeRenderer: vi.fn(),
        close,
      };
      const ready = vi.fn();
      const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
      const server = attachmentServer();
      let attach: (() => Promise<void>) | undefined;
      const startAttachmentServer = vi.fn(async (options) => {
        attach = options.attach;
        return server;
      });
      const dependencies: DesktopControllerDependencies = {
        readRenderer: vi.fn(async () => "production renderer"),
        install,
        startAttachmentServer,
        ready,
        sleep: vi.fn(async () => {}),
        monitorIntervalMs: 1,
      };

      await runDesktopController(controllerOptions(), abort.signal, dependencies);

      expect(install).toHaveBeenCalledWith(
        expect.objectContaining({
          rendererCdpEndpoint: "http://127.0.0.1:43123",
          timeoutMs: 90_000,
          signal: abort.signal,
        }),
      );
      const source = install.mock.calls[0]?.[0].rendererSource;
      expect(source).toContain(
        "globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;",
      );
      expect(source).toContain("production renderer");
      expect(source).toContain("__codexhostCpaLiveVoiceHookV1");
      expect(install.mock.calls[0]?.[0].overlayHookSource).toContain(
        "__codexhostCpaLiveVoiceHookV1",
      );
      expect(install.mock.calls[0]?.[0].overlayHookSource).toMatch(
        /^globalThis\.__zod_globalConfig \?\?= \{\}; globalThis\.__zod_globalConfig\.jitless = true;\n/,
      );
      expect(startAttachmentServer).toHaveBeenCalledWith({
        port: 43124,
        nonce: attachmentNonce,
        attach: expect.any(Function),
        openLocalPage: expect.any(Function),
        remoteConnections: expect.any(Function),
      });
      expect(ready).toHaveBeenCalledWith({
        schemaVersion: 2,
        state: "compatible",
        issues: [],
      });
      expect(ensureInstalled).toHaveBeenCalledOnce();
      expect(server.close).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(attach).toEqual(expect.any(Function));
    });
  });

  it("prefixes the CPA live-voice hook by default", async () => {
    await withoutPinnedDesktopVersion(async () => {
      const previous = process.env.CODEXHOST_CPA_LIVE_VOICE;
      delete process.env.CODEXHOST_CPA_LIVE_VOICE;
      const abort = new AbortController();
      const snapshot = controllerSnapshot();
      const session: RendererCdpControlSession = {
        snapshot,
        ensureInstalled: vi.fn(async () => {
          abort.abort();
          return snapshot;
        }),
        activateDesktop: vi.fn(async () => 1),
        attachVoiceHost: vi.fn(async () => {}),
        executeRenderer: vi.fn(),
        close: vi.fn(),
      };
      const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
      try {
        await runDesktopController(controllerOptions(), abort.signal, {
          readRenderer: vi.fn(async (filePath: string) =>
            filePath.endsWith("cpa-live-voice-hook.js") ? "overlay hook" : "production renderer",
          ),
          install,
          startAttachmentServer: vi.fn(async () => attachmentServer()),
          ready: vi.fn(),
          sleep: vi.fn(async () => {}),
          monitorIntervalMs: 1,
        });
        const source = install.mock.calls[0]?.[0].rendererSource;
        expect(source).toContain("globalThis.__codexhostCpaLiveVoiceHookV1 = Object.freeze(");
        expect(source).toContain("26.1007.30912");
        expect(source?.endsWith("production renderer")).toBe(true);
        expect(install.mock.calls[0]?.[0].overlayHookSource).toContain("overlay hook");
        expect(install.mock.calls[0]?.[0].overlayHookSource).toContain(
          "globalThis.__codexhostCpaLiveVoiceHookV1 = Object.freeze(",
        );
      } finally {
        if (previous === undefined) delete process.env.CODEXHOST_CPA_LIVE_VOICE;
        else process.env.CODEXHOST_CPA_LIVE_VOICE = previous;
      }
    });
  });

  it("omits the CPA live-voice hook when CODEXHOST_CPA_LIVE_VOICE=0", async () => {
    const previous = process.env.CODEXHOST_CPA_LIVE_VOICE;
    process.env.CODEXHOST_CPA_LIVE_VOICE = "0";
    const abort = new AbortController();
    const snapshot = controllerSnapshot();
    const session: RendererCdpControlSession = {
      snapshot,
      ensureInstalled: vi.fn(async () => {
        abort.abort();
        return snapshot;
      }),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),
      executeRenderer: vi.fn(),
      close: vi.fn(),
    };
    const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
    try {
      await runDesktopController(controllerOptions(), abort.signal, {
        readRenderer: vi.fn(async (filePath: string) =>
          filePath.endsWith("cpa-live-voice-hook.js") ? "overlay hook" : "production renderer",
        ),
        install,
        startAttachmentServer: vi.fn(async () => attachmentServer()),
        ready: vi.fn(),
        sleep: vi.fn(async () => {}),
        monitorIntervalMs: 1,
      });
      const source = install.mock.calls[0]?.[0].rendererSource;
      expect(source).not.toContain("globalThis.__codexhostCpaLiveVoiceHookV1");
      expect(install.mock.calls[0]?.[0].overlayHookSource).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEXHOST_CPA_LIVE_VOICE;
      else process.env.CODEXHOST_CPA_LIVE_VOICE = previous;
    }
  });

  it("stops within its shutdown bound while an attachment operation never settles", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const snapshot = controllerSnapshot();
      const close = vi.fn();
      const session: RendererCdpControlSession = {
        snapshot,
        ensureInstalled: vi.fn(async () => snapshot),
        activateDesktop: vi.fn(() => new Promise<number>(() => undefined)),
        attachVoiceHost: vi.fn(async () => {}),
        executeRenderer: vi.fn(),
        close,
      };
      const server = attachmentServer();
      let attach: (() => Promise<void>) | undefined;
      const run = runDesktopController(controllerOptions(), abort.signal, {
        readRenderer: vi.fn(async () => "production renderer"),
        install: vi.fn(async () => session),
        startAttachmentServer: vi.fn(async (options) => {
          attach = options.attach;
          return server;
        }),
        ready: vi.fn(),
        sleep: vi.fn(async () => {
          void attach?.();
          abort.abort();
        }),
        monitorIntervalMs: 1,
      });
      let finished = false;
      void run.then(() => {
        finished = true;
      });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(server.close).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes readiness before a pending Renderer install finishes", async () => {
    const abort = new AbortController();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(async () => controllerSnapshot()),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),
      executeRenderer: vi.fn(),
      close,
    };
    let finishInstall!: (value: RendererCdpControlSession) => void;
    const install = vi.fn(
      () =>
        new Promise<RendererCdpControlSession>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    const run = runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {
        abort.abort();
      }),
      monitorIntervalMs: 1,
    });

    await vi.waitFor(() => {
      expect(ready).toHaveBeenCalledWith({
        schemaVersion: 2,
        state: "compatible",
        issues: [],
      });
    });
    expect(startAttachmentServer).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();

    finishInstall(session);
    await run;
    expect(install).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("Promise was collected"),
    new CdpConnectionClosedError("CDP WebSocket closed"),
  ])("retries a transient Renderer startup failure: %s", async (secondFailure) => {
    const abort = new AbortController();
    abort.abort();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(
        new Error("Renderer installation failed", {
          cause: new Error("Execution context was destroyed during Renderer reload"),
        }),
      )
      .mockRejectedValueOnce(secondFailure)
      .mockResolvedValueOnce(session);
    const ready = vi.fn();
    const sleep = vi.fn(async () => {});

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready,
      sleep,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("recovers an unclassified inspection failure after managed readiness", async () => {
    const abort = new AbortController();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(new Error("Inspector target is not ready"))
      .mockResolvedValueOnce(session);
    const ready = vi.fn();
    let currentTime = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      if (milliseconds === 1) currentTime += 30_000;
      if (install.mock.calls.length >= 2) abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready,
      sleep,
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses a structural installation failure and starts attachment", async () => {
    const abort = new AbortController();
    abort.abort();
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    const install = vi.fn(async () => {
      throw new Error("Production Renderer Adapter is unsupported: signature-mismatch");
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(JSON.stringify(ready.mock.calls)).not.toContain("signature-mismatch");
    expect(startAttachmentServer).toHaveBeenCalledOnce();
  });

  it("does not inject the Renderer on Windows Desktop 26.1106", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const previous = process.env.CODEXHOST_DESKTOP_VERSION;
    process.env.CODEXHOST_DESKTOP_VERSION = "26.1106.51428";
    const abort = new AbortController();
    const install = vi.fn<DesktopControllerDependencies["install"]>();
    const publishStatus = vi.fn();
    const readRenderer = vi.fn(async () => "production renderer");
    try {
      await runDesktopController(controllerOptions(), abort.signal, {
        readRenderer,
        install,
        startAttachmentServer: vi.fn(async () => attachmentServer()),
        ready: vi.fn(),
        publishStatus,
        sleep: vi.fn(async () => {
          abort.abort();
        }),
        monitorIntervalMs: 1,
      });
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      if (previous === undefined) delete process.env.CODEXHOST_DESKTOP_VERSION;
      else process.env.CODEXHOST_DESKTOP_VERSION = previous;
    }

    expect(install).not.toHaveBeenCalled();
    expect(readRenderer).not.toHaveBeenCalled();
    const states = publishStatus.mock.calls.map(([document]) => document.renderer);
    expect(states).toEqual([
      expect.objectContaining({
        state: "unavailable",
        error: "Desktop 26.1106.51428 is skipped until hashed Renderer bindings are requalified",
        failures: 1,
      }),
    ]);
  });

  it("installs the Renderer on an owned isolated Windows 26.1106.51428 Controller", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const overlayDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-overlay-win32-isolated-"));
    const scratchApp = path.join(overlayDir, "bundle", "app", "ChatGPT.exe");
    const identity = {
      path: "chat",
      run: "2026-11-15-isolated-win32",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      desktopVersion: "26.1106.51428",
      desktopBuild: "26605",
      desktopPlatform: "win32",
      asarDigest: `sha256:${"ab".repeat(32)}`,
      appPath: scratchApp,
      implementationRevision: "packaged-revision",
      label: "unqualified-isolated",
    };
    await writeFile(
      path.join(overlayDir, "voice-profile-pins.json"),
      JSON.stringify({
        hashedVersion: "26.1106.51428",
        overlayHookDesktopVersions: ["26.1106.51428"],
      }),
    );
    await writeFile(
      path.join(overlayDir, "voice-qualification.json"),
      JSON.stringify({ implementationRevision: "packaged-revision", reviewedEvidence: [] }),
    );
    await writeFile(
      path.join(overlayDir, "voice-isolated-qualification.json"),
      JSON.stringify(identity),
    );
    const abort = new AbortController();
    const snapshot = controllerSnapshot();
    const session: RendererCdpControlSession = {
      snapshot,
      ensureInstalled: vi.fn(async () => {
        abort.abort();
        return snapshot;
      }),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),
      executeRenderer: vi.fn(),
      close: vi.fn(),
    };
    const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
    try {
      await withDesktopIdentityEnv(
        {
          CODEXHOST_CPA_LIVE_VOICE: "1",
          CODEXHOST_DESKTOP_VERSION: identity.desktopVersion,
          CODEXHOST_DESKTOP_BUILD: identity.desktopBuild,
          CODEXHOST_DESKTOP_ASAR_DIGEST: identity.asarDigest,
          CODEXHOST_DESKTOP_APP_PATH: identity.appPath,
        },
        () =>
          runDesktopController(
            { ...controllerOptions(), rendererPath: path.join(overlayDir, "renderer.js") },
            abort.signal,
            {
              readRenderer: vi.fn(async (filePath: string) =>
                filePath.endsWith("overlay-voice-bootstrap.js")
                  ? "overlay voice bootstrap"
                  : filePath.endsWith("cpa-live-voice-hook.js")
                    ? "overlay hook"
                    : "production renderer",
              ),
              install,
              startAttachmentServer: vi.fn(async () => attachmentServer()),
              ready: vi.fn(),
              sleep: vi.fn(async () => {}),
              monitorIntervalMs: 1,
            },
          ),
      );
      expect(install).toHaveBeenCalledOnce();
      const injected = install.mock.calls[0]?.[0];
      expect(injected?.overlayHookSource).toContain('"isolatedQualification"');
      expect(injected?.overlayHookSource).toContain('"path":"chat"');
      expect(injected?.overlayHookSource).toContain('"voiceEvidence":[]');
      expect(injected?.overlayHookSource).not.toContain("WindowsApps");
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      await rm(overlayDir, { recursive: true, force: true });
    }
  });

  it("keeps the Windows production skip when the isolated marker names WindowsApps", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const overlayDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-overlay-win32-prod-"));
    const productionApp =
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
    await writeFile(
      path.join(overlayDir, "voice-profile-pins.json"),
      JSON.stringify({
        hashedVersion: "26.1106.51428",
        overlayHookDesktopVersions: ["26.1106.51428"],
      }),
    );
    await writeFile(
      path.join(overlayDir, "voice-qualification.json"),
      JSON.stringify({ implementationRevision: "packaged-revision", reviewedEvidence: [] }),
    );
    await writeFile(
      path.join(overlayDir, "voice-isolated-qualification.json"),
      JSON.stringify({
        path: "chat",
        run: "2026-11-15-isolated-win32",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: "26605",
        desktopPlatform: "win32",
        asarDigest: `sha256:${"ab".repeat(32)}`,
        appPath: productionApp,
        implementationRevision: "packaged-revision",
        label: "unqualified-isolated",
      }),
    );
    const abort = new AbortController();
    const install = vi.fn<DesktopControllerDependencies["install"]>();
    const publishStatus = vi.fn();
    try {
      await withDesktopIdentityEnv(
        {
          CODEXHOST_CPA_LIVE_VOICE: "1",
          CODEXHOST_DESKTOP_VERSION: "26.1106.51428",
          CODEXHOST_DESKTOP_BUILD: "26605",
          CODEXHOST_DESKTOP_ASAR_DIGEST: `sha256:${"ab".repeat(32)}`,
          CODEXHOST_DESKTOP_APP_PATH: productionApp,
        },
        () =>
          runDesktopController(
            { ...controllerOptions(), rendererPath: path.join(overlayDir, "renderer.js") },
            abort.signal,
            {
              readRenderer: vi.fn(async () => "production renderer"),
              install,
              startAttachmentServer: vi.fn(async () => attachmentServer()),
              ready: vi.fn(),
              publishStatus,
              sleep: vi.fn(async () => {
                abort.abort();
              }),
              monitorIntervalMs: 1,
            },
          ),
      );
      expect(install).not.toHaveBeenCalled();
      expect(publishStatus.mock.calls.map(([document]) => document.renderer)).toEqual([
        expect.objectContaining({
          state: "unavailable",
          error: "Desktop 26.1106.51428 is skipped until hashed Renderer bindings are requalified",
        }),
      ]);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      await rm(overlayDir, { recursive: true, force: true });
    }
  });

  it("installs and monitors the Renderer on macOS Desktop 26.1106.51428", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    const previous = process.env.CODEXHOST_DESKTOP_VERSION;
    process.env.CODEXHOST_DESKTOP_VERSION = "26.1106.51428";
    const overlayDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-overlay-"));
    await writeFile(
      path.join(overlayDir, "voice-profile-pins.json"),
      JSON.stringify({
        hashedVersion: "26.1106.51428",
        overlayHookDesktopVersions: ["26.1106.51428"],
      }),
    );
    const abort = new AbortController();
    const snapshot = controllerSnapshot();
    const session: RendererCdpControlSession = {
      snapshot,
      ensureInstalled: vi.fn(async () => {
        abort.abort();
        return snapshot;
      }),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),
      executeRenderer: vi.fn(),
      close: vi.fn(),
    };
    const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
    const publishStatus = vi.fn();
    let monitorCycles = 0;
    try {
      await runDesktopController(
        { ...controllerOptions(), rendererPath: path.join(overlayDir, "renderer.js") },
        abort.signal,
        {
          readRenderer: vi.fn(async (filePath: string) =>
            filePath.endsWith("overlay-voice-bootstrap.js")
              ? "overlay voice bootstrap"
              : filePath.endsWith("cpa-live-voice-hook.js")
                ? "overlay hook"
                : "production renderer",
          ),
          install,
          startAttachmentServer: vi.fn(async () => attachmentServer()),
          ready: vi.fn(),
          publishStatus,
          sleep: vi.fn(async () => {
            if (++monitorCycles >= 2) abort.abort();
          }),
          monitorIntervalMs: 1,
        },
      );
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      if (previous === undefined) delete process.env.CODEXHOST_DESKTOP_VERSION;
      else process.env.CODEXHOST_DESKTOP_VERSION = previous;
      await rm(overlayDir, { recursive: true, force: true });
    }

    expect(install).toHaveBeenCalledOnce();
    expect(session.ensureInstalled).toHaveBeenCalledOnce();
    expect(install.mock.calls[0]?.[0].overlayHookSource).toContain("overlay hook");
    expect(install.mock.calls[0]?.[0].overlayVoiceBootstrapSource).toContain(
      "overlay voice bootstrap",
    );
    expect(publishStatus.mock.calls.map(([document]) => document.renderer.state)).toEqual([
      "installing",
      "installed",
    ]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("injects overlay-dir isolated qualification only when launched identity matches", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    const overlayDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-overlay-isolated-"));
    const scratchApp = path.join(overlayDir, "scratch", "ChatGPT.app");
    const identity = {
      path: "work-codex",
      run: "2026-11-14-isolated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      desktopVersion: "26.1106.51428",
      desktopBuild: "26605",
      desktopPlatform: "darwin",
      asarDigest: `sha256:${"ab".repeat(32)}`,
      appPath: scratchApp,
      implementationRevision: "packaged-revision",
      label: "unqualified-isolated",
    };
    await writeFile(
      path.join(overlayDir, "voice-profile-pins.json"),
      JSON.stringify({
        hashedVersion: "26.1106.51428",
        overlayHookDesktopVersions: ["26.1106.51428"],
      }),
    );
    await writeFile(
      path.join(overlayDir, "voice-qualification.json"),
      JSON.stringify({ implementationRevision: "packaged-revision", reviewedEvidence: [] }),
    );
    await writeFile(
      path.join(overlayDir, "voice-isolated-qualification.json"),
      JSON.stringify(identity),
    );
    const abort = new AbortController();
    const snapshot = controllerSnapshot();
    const session: RendererCdpControlSession = {
      snapshot,
      ensureInstalled: vi.fn(async () => {
        abort.abort();
        return snapshot;
      }),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),
      executeRenderer: vi.fn(),
      close: vi.fn(),
    };
    const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
    try {
      await withDesktopIdentityEnv(
        {
          CODEXHOST_CPA_LIVE_VOICE: "1",
          CODEXHOST_DESKTOP_VERSION: "26.1106.51428",
        },
        () =>
          runDesktopController(
            { ...controllerOptions(), rendererPath: path.join(overlayDir, "renderer.js") },
            abort.signal,
            {
              readRenderer: vi.fn(async (filePath: string) =>
                filePath.endsWith("overlay-voice-bootstrap.js")
                  ? "overlay voice bootstrap"
                  : filePath.endsWith("cpa-live-voice-hook.js")
                    ? "overlay hook"
                    : "production renderer",
              ),
              install,
              startAttachmentServer: vi.fn(async () => attachmentServer()),
              ready: vi.fn(),
              sleep: vi.fn(async () => {}),
              monitorIntervalMs: 1,
            },
          ),
      );
      const incomplete = install.mock.calls[0]?.[0];
      expect(incomplete?.overlayHookSource).toContain("overlay hook");
      expect(incomplete?.overlayHookSource).not.toContain("isolatedQualification");
      expect(incomplete?.overlayVoiceBootstrapSource).toContain("overlay voice bootstrap");
      expect(incomplete?.overlayVoiceBootstrapSource).not.toContain("isolatedQualification");

      abort.abort();
      const matchedAbort = new AbortController();
      const matchedSession: RendererCdpControlSession = {
        snapshot,
        ensureInstalled: vi.fn(async () => {
          matchedAbort.abort();
          return snapshot;
        }),
        activateDesktop: vi.fn(async () => 1),
        attachVoiceHost: vi.fn(async () => {}),
        executeRenderer: vi.fn(),
        close: vi.fn(),
      };
      const matchedInstall = vi.fn<DesktopControllerDependencies["install"]>(
        async () => matchedSession,
      );
      await withDesktopIdentityEnv(
        {
          CODEXHOST_CPA_LIVE_VOICE: "1",
          CODEXHOST_DESKTOP_VERSION: identity.desktopVersion,
          CODEXHOST_DESKTOP_BUILD: identity.desktopBuild,
          CODEXHOST_DESKTOP_ASAR_DIGEST: identity.asarDigest,
          CODEXHOST_DESKTOP_APP_PATH: identity.appPath,
        },
        () =>
          runDesktopController(
            { ...controllerOptions(), rendererPath: path.join(overlayDir, "renderer.js") },
            matchedAbort.signal,
            {
              readRenderer: vi.fn(async (filePath: string) =>
                filePath.endsWith("overlay-voice-bootstrap.js")
                  ? "overlay voice bootstrap"
                  : filePath.endsWith("cpa-live-voice-hook.js")
                    ? "overlay hook"
                    : "production renderer",
              ),
              install: matchedInstall,
              startAttachmentServer: vi.fn(async () => attachmentServer()),
              ready: vi.fn(),
              sleep: vi.fn(async () => {}),
              monitorIntervalMs: 1,
            },
          ),
      );
      const matched = matchedInstall.mock.calls[0]?.[0];
      expect(matched?.overlayHookSource).toContain('"isolatedQualification"');
      expect(matched?.overlayHookSource).toContain('"path":"work-codex"');
      expect(matched?.overlayHookSource).toContain('"label":"unqualified-isolated"');
      expect(matched?.overlayHookSource).toContain('"voiceEvidence":[]');
      expect(matched?.overlayHookSource).not.toContain("/Applications/ChatGPT.app");
      expect(matched?.overlayVoiceBootstrapSource).toContain('"isolatedQualification"');
      expect(matched?.overlayVoiceBootstrapSource).toContain(JSON.stringify(scratchApp));
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      await rm(overlayDir, { recursive: true, force: true });
    }
  });

  it("skips overlay injection when packaged voice pins are missing", async () => {
    const previous = process.env.CODEXHOST_DESKTOP_VERSION;
    process.env.CODEXHOST_DESKTOP_VERSION = "26.1027.61615";
    const overlayDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-overlay-missing-"));
    const abort = new AbortController();
    const snapshot = controllerSnapshot();
    const session: RendererCdpControlSession = {
      snapshot,
      ensureInstalled: vi.fn(async () => {
        abort.abort();
        return snapshot;
      }),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),
      executeRenderer: vi.fn(),
      close: vi.fn(),
    };
    const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
    try {
      await runDesktopController(
        { ...controllerOptions(), rendererPath: path.join(overlayDir, "renderer.js") },
        abort.signal,
        {
          readRenderer: vi.fn(async () => "production renderer"),
          install,
          startAttachmentServer: vi.fn(async () => attachmentServer()),
          ready: vi.fn(),
          sleep: vi.fn(async () => {}),
          monitorIntervalMs: 1,
        },
      );
      expect(install.mock.calls[0]?.[0].overlayHookSource).toBeUndefined();
      expect(install.mock.calls[0]?.[0].overlayVoiceBootstrapSource).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEXHOST_DESKTOP_VERSION;
      else process.env.CODEXHOST_DESKTOP_VERSION = previous;
      await rm(overlayDir, { recursive: true, force: true });
    }
  });

  it("publishes Renderer integration failure and recovery for the console", async () => {
    const abort = new AbortController();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),

      executeRenderer: vi.fn(),
      close: vi.fn(),
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(
        new Error("Production Renderer Adapter is unsupported: signature-mismatch"),
      )
      .mockResolvedValueOnce(session);
    const publishStatus = vi.fn();
    let currentTime = 0;

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready: vi.fn(),
      publishStatus,
      sleep: vi.fn(async (milliseconds: number) => {
        if (milliseconds === 1) currentTime += 30_000;
        if (install.mock.calls.length >= 2) abort.abort();
      }),
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    const states = publishStatus.mock.calls.map(([document]) => document.renderer);
    expect(states.map((renderer) => renderer.state)).toEqual([
      "installing",
      "unavailable",
      "installing",
      "installed",
    ]);
    expect(states[1]).toMatchObject({
      error: "Production Renderer Adapter is unsupported: signature-mismatch",
      failures: 1,
    });
    expect(states[3]).toMatchObject({
      error: null,
      failures: 1,
      lastError: "Production Renderer Adapter is unsupported: signature-mismatch",
      lastFailedAt: 0,
      lastInstalledAt: 30_000,
    });
  });

  it("suppresses an unclassified inspection failure without leaking its error", async () => {
    const abort = new AbortController();
    abort.abort();
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => {
        throw new Error("/private/user/path and request details");
      }),
      install: vi.fn(),
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    });

    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(JSON.stringify(ready.mock.calls)).not.toContain("private/user");
    expect(startAttachmentServer).toHaveBeenCalledOnce();
  });

  it("installs on demand when attachment arrives during recovery", async () => {
    const abort = new AbortController();
    const activateDesktop = vi.fn(async () => 1);
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop,
      attachVoiceHost: vi.fn(async () => {}),

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(new Error("Composer is not ready"))
      .mockResolvedValueOnce(session);
    let attach: (() => Promise<void>) | undefined;
    const startAttachmentServer = vi.fn(async (options) => {
      attach = options.attach;
      return attachmentServer();
    });
    const sleep = vi.fn(async () => {
      await attach?.();
      abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready: vi.fn(),
      sleep,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(activateDesktop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("replaces a ready Session after Renderer recovery fails", async () => {
    const abort = new AbortController();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const first: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(async () => {
        throw new Error("Renderer binding disappeared");
      }),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),

      executeRenderer: vi.fn(),
      close: firstClose,
    };
    const second: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),
      attachVoiceHost: vi.fn(async () => {}),

      executeRenderer: vi.fn(),
      close: secondClose,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    let monitorCycles = 0;
    let currentTime = 0;
    const sleep = vi.fn(async () => {
      monitorCycles += 1;
      currentTime += 30_000;
      if (monitorCycles === 3) abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready: vi.fn(),
      sleep,
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("retries Voice Host bind until the Host client-hosts descriptor appears", async () => {
    await withoutPinnedDesktopVersion(async () => {
      const abort = new AbortController();
      const snapshot = controllerSnapshot();
      const session: RendererCdpControlSession = {
        snapshot,
        ensureInstalled: vi.fn(async () => {
          abort.abort();
          return snapshot;
        }),
        activateDesktop: vi.fn(async () => 1),
        attachVoiceHost: vi.fn(async () => {}),
        executeRenderer: vi.fn(),
        close: vi.fn(),
      };
      const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
      const host = {
        owner: "voice-host",
        generation: 1,
        close: vi.fn(),
      } as unknown as ControllerVoiceHost;
      const connect = vi.mocked(connectControllerVoiceHost);
      connect.mockReset();
      connect
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(host);
      const sleep = vi.fn(async () => {});
      await runDesktopController(
        { ...controllerOptions(), hostDataDirectory: path.normalize("/tmp/isolated-host") },
        abort.signal,
        {
          readRenderer: vi.fn(async () => "production renderer"),
          install,
          startAttachmentServer: vi.fn(async () => attachmentServer()),
          ready: vi.fn(),
          sleep,
          monitorIntervalMs: 1,
        },
      );
      expect(connect).toHaveBeenCalledTimes(3);
      expect(connect).toHaveBeenCalledWith(path.normalize("/tmp/isolated-host"));
      expect(sleep).toHaveBeenCalledWith(250);
      expect(install.mock.calls[0]?.[0].voiceHost).toBe(host);
    });
  });

  it("attaches a Voice Host that appears after startup without reinstalling the Renderer", async () => {
    await withoutPinnedDesktopVersion(async () => {
      const abort = new AbortController();
      const snapshot = controllerSnapshot();
      const attachVoiceHost = vi.fn(async () => {
        abort.abort();
      });
      const session: RendererCdpControlSession = {
        snapshot,
        ensureInstalled: vi.fn(async () => snapshot),
        attachVoiceHost,
        activateDesktop: vi.fn(async () => 1),
        executeRenderer: vi.fn(),
        close: vi.fn(),
      };
      const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
      const host = {
        owner: "voice-host",
        generation: 1,
        close: vi.fn(),
      } as unknown as ControllerVoiceHost;
      const connect = vi.mocked(connectControllerVoiceHost);
      connect.mockReset();
      let attempts = 0;
      connect.mockImplementation(async () => (++attempts < 10 ? undefined : host));
      let currentTime = 0;
      let cycles = 0;
      const sleep = vi.fn(async (milliseconds: number) => {
        if (milliseconds !== 1) return;
        currentTime += 500;
        if (++cycles > 12) abort.abort();
      });

      await runDesktopController(
        { ...controllerOptions(), hostDataDirectory: path.normalize("/tmp/isolated-host") },
        abort.signal,
        {
          readRenderer: vi.fn(async () => "production renderer"),
          install,
          startAttachmentServer: vi.fn(async () => attachmentServer()),
          ready: vi.fn(),
          sleep,
          now: () => currentTime,
          monitorIntervalMs: 1,
        },
      );

      // Eight startup attempts, one throttled retry, then the descriptor appears.
      expect(connect).toHaveBeenCalledTimes(10);
      expect(install).toHaveBeenCalledOnce();
      expect(install.mock.calls[0]?.[0].voiceHost).toBeUndefined();
      expect(attachVoiceHost).toHaveBeenCalledOnce();
      expect(attachVoiceHost).toHaveBeenCalledWith(host);
      expect(host.close).toHaveBeenCalledOnce();
    });
  });

  it("retries a failed late Voice Host attachment without replacing the Renderer Session", async () => {
    await withoutPinnedDesktopVersion(async () => {
      const abort = new AbortController();
      const snapshot = controllerSnapshot();
      const firstHost = {
        owner: "voice-host-1",
        generation: 1,
        close: vi.fn(),
      } as unknown as ControllerVoiceHost;
      const secondHost = {
        owner: "voice-host-2",
        generation: 1,
        close: vi.fn(),
      } as unknown as ControllerVoiceHost;
      const attachVoiceHost = vi
        .fn<RendererCdpControlSession["attachVoiceHost"]>()
        .mockRejectedValueOnce(new Error("Renderer voice binding failed"))
        .mockImplementationOnce(async () => {
          abort.abort();
        });
      const session: RendererCdpControlSession = {
        snapshot,
        ensureInstalled: vi.fn(async () => snapshot),
        attachVoiceHost,
        activateDesktop: vi.fn(async () => 1),
        executeRenderer: vi.fn(),
        close: vi.fn(),
      };
      const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
      const connect = vi.mocked(connectControllerVoiceHost);
      connect.mockReset();
      let attempts = 0;
      connect.mockImplementation(async () =>
        ++attempts < 9 ? undefined : attempts === 9 ? firstHost : secondHost,
      );
      let currentTime = 0;
      let cycles = 0;
      const sleep = vi.fn(async (milliseconds: number) => {
        if (milliseconds !== 1) return;
        currentTime += 500;
        if (++cycles > 12) abort.abort();
      });

      await runDesktopController(
        { ...controllerOptions(), hostDataDirectory: path.normalize("/tmp/isolated-host") },
        abort.signal,
        {
          readRenderer: vi.fn(async () => "production renderer"),
          install,
          startAttachmentServer: vi.fn(async () => attachmentServer()),
          ready: vi.fn(),
          sleep,
          now: () => currentTime,
          monitorIntervalMs: 1,
        },
      );

      expect(install).toHaveBeenCalledOnce();
      expect(attachVoiceHost).toHaveBeenCalledTimes(2);
      expect(attachVoiceHost).toHaveBeenLastCalledWith(secondHost);
      expect(firstHost.close).toHaveBeenCalledOnce();
      expect(secondHost.close).toHaveBeenCalledOnce();
    });
  });

  it("does not attach a Voice Host that resolves after shutdown begins", async () => {
    await withoutPinnedDesktopVersion(async () => {
      const abort = new AbortController();
      const snapshot = controllerSnapshot();
      const attachVoiceHost = vi.fn(async () => {});
      const session: RendererCdpControlSession = {
        snapshot,
        ensureInstalled: vi.fn(async () => snapshot),
        attachVoiceHost,
        activateDesktop: vi.fn(async () => 1),
        executeRenderer: vi.fn(),
        close: vi.fn(),
      };
      const install = vi.fn<DesktopControllerDependencies["install"]>(async () => session);
      const host = {
        owner: "voice-host",
        generation: 1,
        close: vi.fn(),
      } as unknown as ControllerVoiceHost;
      const connect = vi.mocked(connectControllerVoiceHost);
      connect.mockReset();
      let attempts = 0;
      connect.mockImplementation(async () => {
        attempts += 1;
        if (attempts < 9) return undefined;
        abort.abort();
        return host;
      });

      await runDesktopController(
        { ...controllerOptions(), hostDataDirectory: path.normalize("/tmp/isolated-host") },
        abort.signal,
        {
          readRenderer: vi.fn(async () => "production renderer"),
          install,
          startAttachmentServer: vi.fn(async () => attachmentServer()),
          ready: vi.fn(),
          sleep: vi.fn(async () => {}),
          monitorIntervalMs: 1,
        },
      );

      expect(connect).toHaveBeenCalledTimes(9);
      expect(attachVoiceHost).not.toHaveBeenCalled();
      expect(host.close).toHaveBeenCalledOnce();
    });
  });
});
