import { describe, expect, it } from "vitest";

import { rendererInjectionSkipReason } from "../src/renderer-injection-skip.js";

describe("rendererInjectionSkipReason", () => {
  it.each(["win32", "linux"] as const)("keeps the 26.1106 skip on %s", (platform) => {
    expect(rendererInjectionSkipReason("26.1106.51428", platform)).toContain("26.1106.51428");
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

  it("does not remove the Windows skip from environment path strings", () => {
    const previous = process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC;
    const previousApp = process.env.CODEXHOST_DESKTOP_APP_PATH;
    const previousData = process.env.CODEX_ELECTRON_USER_DATA_PATH;
    process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC = "1";
    process.env.CODEXHOST_DESKTOP_APP_PATH =
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
    process.env.CODEX_ELECTRON_USER_DATA_PATH =
      "C:\\Users\\karl\\AppData\\Local\\Temp\\codexhost-isolated-voice-20261114";
    try {
      expect(rendererInjectionSkipReason("26.1106.51428", "win32")).toContain("skipped");
    } finally {
      if (previous === undefined) delete process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC;
      else process.env.CODEXHOST_RENDERER_INJECTION_DIAGNOSTIC = previous;
      if (previousApp === undefined) delete process.env.CODEXHOST_DESKTOP_APP_PATH;
      else process.env.CODEXHOST_DESKTOP_APP_PATH = previousApp;
      if (previousData === undefined) delete process.env.CODEX_ELECTRON_USER_DATA_PATH;
      else process.env.CODEX_ELECTRON_USER_DATA_PATH = previousData;
    }
  });
});
