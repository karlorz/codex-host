import { describe, expect, it } from "vitest";

import {
  hashedRendererWaitsForDocumentLoad,
  rendererInjectionSkipReason,
} from "../src/renderer-injection-skip.js";
import type { IsolatedVoiceQualificationFile } from "../src/cpa-live-voice-hook.js";

const isolatedWindowsApp =
  "C:\\Users\\karlchow\\AppData\\Local\\.codexhost\\update-impact\\26.1106.51428\\bundle\\app\\ChatGPT.exe";
const productionWindowsApp =
  "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";

function isolatedWindowsMarker(
  overrides: Partial<IsolatedVoiceQualificationFile> = {},
): IsolatedVoiceQualificationFile {
  return {
    path: "chat",
    run: "2026-11-15-isolated-win32",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    desktopVersion: "26.1106.51428",
    desktopBuild: "26605",
    desktopPlatform: "win32",
    asarDigest: `sha256:${"ab".repeat(32)}`,
    appPath: isolatedWindowsApp,
    implementationRevision: "packaged-revision",
    label: "unqualified-isolated",
    ...overrides,
  };
}

function isolatedWindowsIdentity(
  overrides: Partial<{
    desktopPlatform: string;
    desktopVersion: string;
    desktopBuild: string;
    asarDigest: string;
    appPath: string;
    implementationRevision: string;
  }> = {},
) {
  const isolated = isolatedWindowsMarker();
  return {
    desktopPlatform: "win32",
    desktopVersion: isolated.desktopVersion,
    desktopBuild: isolated.desktopBuild,
    asarDigest: isolated.asarDigest,
    appPath: isolated.appPath,
    implementationRevision: isolated.implementationRevision,
    ...overrides,
  };
}

describe("rendererInjectionSkipReason", () => {
  it("keeps the 26.1106 skip on linux", () => {
    expect(rendererInjectionSkipReason("26.1106.51428", "linux")).toContain("26.1106.51428");
  });

  it("allows Renderer installation on Windows 26.1106.51428", () => {
    expect(rendererInjectionSkipReason("26.1106.51428", "win32")).toBeNull();
    expect(rendererInjectionSkipReason(" 26.1106.51428 ", "win32")).toBeNull();
  });

  it("allows Renderer installation on macOS 26.1106.51428", () => {
    expect(rendererInjectionSkipReason("26.1106.51428", "darwin")).toBeNull();
    expect(rendererInjectionSkipReason(" 26.1106.51428 ", "darwin")).toBeNull();
  });

  it.each(["darwin", "win32", "linux"] as const)("keeps other skipped builds on %s", (platform) => {
    expect(rendererInjectionSkipReason(" 26.1103.41825 ", platform)).toContain("26.1103.41825");
    expect(rendererInjectionSkipReason("26.1106.99999", platform)).toContain("26.1106.99999");
  });

  it("uses the Controller process platform by default", () => {
    expect(rendererInjectionSkipReason("26.1106.51428")).toBe(
      rendererInjectionSkipReason("26.1106.51428", process.platform),
    );
  });

  it("keeps 26.1027 Renderer injection", () => {
    expect(rendererInjectionSkipReason("26.1027.51404")).toBeNull();
    expect(rendererInjectionSkipReason("26.1027.61615")).toBeNull();
    expect(rendererInjectionSkipReason(undefined)).toBeNull();
    expect(rendererInjectionSkipReason("")).toBeNull();
  });

  it("does not treat environment path strings as a hashed Windows skip", () => {
    const previous = process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC;
    const previousApp = process.env.CODEXHOST_DESKTOP_APP_PATH;
    const previousData = process.env.CODEX_ELECTRON_USER_DATA_PATH;
    process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC = "1";
    process.env.CODEXHOST_DESKTOP_APP_PATH =
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
    process.env.CODEX_ELECTRON_USER_DATA_PATH =
      "C:\\Users\\karl\\AppData\\Local\\Temp\\codexhost-isolated-voice-20261114";
    try {
      expect(rendererInjectionSkipReason("26.1106.51428", "win32")).toBeNull();
      expect(hashedRendererWaitsForDocumentLoad("26.1106.51428", "win32")).toBe(true);
      expect(hashedRendererWaitsForDocumentLoad("26.1106.51428", "darwin")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC;
      else process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC = previous;
      if (previousApp === undefined) delete process.env.CODEXHOST_DESKTOP_APP_PATH;
      else process.env.CODEXHOST_DESKTOP_APP_PATH = previousApp;
      if (previousData === undefined) delete process.env.CODEX_ELECTRON_USER_DATA_PATH;
      else process.env.CODEX_ELECTRON_USER_DATA_PATH = previousData;
    }
  });

  it("allows an owned isolated Windows 26.1106.51428 Controller when the marker matches", () => {
    expect(
      rendererInjectionSkipReason("26.1106.51428", "win32", {
        isolated: isolatedWindowsMarker(),
        identity: isolatedWindowsIdentity(),
      }),
    ).toBeNull();
  });

  it("keeps the Windows skip for other 26.1106 builds", () => {
    expect(
      rendererInjectionSkipReason("26.1106.51428", "linux", {
        isolated: isolatedWindowsMarker({ desktopPlatform: "linux" }),
        identity: isolatedWindowsIdentity({ desktopPlatform: "linux" }),
      }),
    ).toContain("skipped");
    expect(
      rendererInjectionSkipReason("26.1106.99999", "win32", {
        isolated: isolatedWindowsMarker({ desktopVersion: "26.1106.99999" }),
        identity: isolatedWindowsIdentity({ desktopVersion: "26.1106.99999" }),
      }),
    ).toContain("skipped");
  });

  it("rejects a skip identity whose platform or version contradicts the Controller arguments", () => {
    expect(
      rendererInjectionSkipReason("26.1106.99999", "win32", {
        isolated: isolatedWindowsMarker({ desktopVersion: "26.1106.99999" }),
        identity: isolatedWindowsIdentity({
          desktopPlatform: "darwin",
          desktopVersion: "26.1106.99999",
        }),
      }),
    ).toContain("skipped");
    expect(
      rendererInjectionSkipReason("26.1106.51428", "win32", {
        isolated: isolatedWindowsMarker(),
        identity: isolatedWindowsIdentity(),
      }),
    ).toBeNull();
  });
});
