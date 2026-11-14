import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: vi.fn(),
}));

import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  CPA_LIVE_VOICE_ENV,
  DESKTOP_APP_PATH_ENV,
  DESKTOP_ASAR_DIGEST_ENV,
  DESKTOP_BUILD_ENV,
  DESKTOP_VERSION_ENV,
  OVERLAY_VOICE_HOOK_DESKTOP_VERSIONS,
  cpaLiveVoiceHookBootstrap,
  cpaLiveVoiceHookEnabled,
  cpaLiveVoiceOverlayHookAllowed,
  detectInstalledDesktopVersion,
  isolatedQualificationMatchesRuntime,
  overlayVoiceBootstrapPreferred,
  readVoiceIsolatedQualification,
  readVoiceProfilePins,
  readVoiceQualification,
} from "../src/cpa-live-voice-hook.js";

let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-inject-"));
  environment = { CODEXHOST_DATA_DIR: directory };
});

describe("installed Desktop version detection", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platformDescriptor) throw new Error("process.platform descriptor is missing");

  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    vi.mocked(existsSync).mockReset().mockReturnValue(false);
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
  });

  it.each([
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    "/test-home/Applications/ChatGPT.app",
    "/test-home/Applications/Codex.app",
  ])("reads the short version from %s/Contents/Info.plist", (app) => {
    const plist = path.join(app, "Contents/Info.plist");
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === plist);
    vi.mocked(execFileSync).mockReturnValue("26.1021.31345\n");

    const version = detectInstalledDesktopVersion({ HOME: "/test-home" });

    expect(version).toBe("26.1021.31345");
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/defaults",
      ["read", plist, "CFBundleShortVersionString"],
      { encoding: "utf8", timeout: 2000 },
    );
    expect(cpaLiveVoiceHookBootstrap(environment, version)).toContain(
      '"desktopVersion":"26.1021.31345"',
    );
    expect(cpaLiveVoiceHookBootstrap({ ...environment, HOME: "/test-home" })).toContain(
      '"desktopVersion":"26.1021.31345"',
    );
  });

  it("does not read installed apps when the hook is disabled", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue("26.1021.31345\n");
    expect(cpaLiveVoiceHookBootstrap({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe("");
    expect(existsSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("uses the trimmed env override without reading installed apps", () => {
    expect(detectInstalledDesktopVersion({ [DESKTOP_VERSION_ENV]: " 26.1021.31345 " })).toBe(
      "26.1021.31345",
    );
    expect(existsSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("tries the next installed app when a plist read fails", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => {
        throw new Error("unreadable plist");
      })
      .mockReturnValueOnce("26.1021.31345\n");

    expect(detectInstalledDesktopVersion({ HOME: "/test-home" })).toBe("26.1021.31345");
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/defaults",
      [
        "read",
        path.join("/Applications/Codex.app", "Contents/Info.plist"),
        "CFBundleShortVersionString",
      ],
      { encoding: "utf8", timeout: 2000 },
    );
  });

  it("returns undefined when no installed plist exists", () => {
    expect(detectInstalledDesktopVersion({ HOME: "/test-home" })).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("passes Windows product identity and platform to the renderer without using plist discovery", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const source = cpaLiveVoiceHookBootstrap(environment, "26.1021.31345");
    expect(source).toContain('"desktopVersion":"26.1021.31345"');
    expect(source).toContain('"desktopPlatform":"win32"');
    expect(existsSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not run defaults on other platforms", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    expect(detectInstalledDesktopVersion({})).toBeUndefined();
    expect(existsSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("CPA live-voice controller bootstrap", () => {
  it("defaults on when no setting exists, and accepts explicit env overrides", () => {
    expect(cpaLiveVoiceHookEnabled(environment)).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ ...environment, [CPA_LIVE_VOICE_ENV]: "1" })).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe(false);
    expect(cpaLiveVoiceHookBootstrap({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe("");
  });

  it("reads the inject file when the env is unset, and env still wins", async () => {
    await writeFile(
      path.join(directory, "live-voice-inject-v1.json"),
      JSON.stringify({ version: 1, inject: false }),
    );
    expect(cpaLiveVoiceHookEnabled(environment)).toBe(false);
    expect(cpaLiveVoiceHookBootstrap(environment)).toBe("");
    expect(cpaLiveVoiceHookEnabled({ ...environment, [CPA_LIVE_VOICE_ENV]: "1" })).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ ...environment, [CPA_LIVE_VOICE_ENV]: "0" })).toBe(false);
  });

  it.each([
    "invalid json",
    "null",
    "{}",
    '{"version":2,"inject":false}',
    '{"version":1,"inject":"false"}',
  ])("defaults on for malformed or unsupported settings: %s", async (content) => {
    await writeFile(path.join(directory, "live-voice-inject-v1.json"), content);
    expect(cpaLiveVoiceHookEnabled(environment)).toBe(true);
  });

  it("emits a frozen enable record by default", () => {
    const source = cpaLiveVoiceHookBootstrap(environment);
    expect(source.startsWith("globalThis.__codexhostCpaLiveVoiceHookV1 = Object.freeze(")).toBe(
      true,
    );
    expect(source).toContain(`"auditedDesktopVersion":"${AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION}"`);
    expect(source).toContain(
      `"auditedAppInitialAsset":"${AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET}"`,
    );
    expect(source).toContain('"enabled":true');
    expect(source).not.toContain("clientOwnsCall");
    expect(source).not.toContain("function pa");
    expect(source).not.toContain("desktopVersion");
  });

  it("includes the Desktop short version from env", () => {
    const source = cpaLiveVoiceHookBootstrap({
      ...environment,
      [DESKTOP_VERSION_ENV]: "26.1021.31345",
    });
    expect(source).toContain('"desktopVersion":"26.1021.31345"');
  });

  it("keeps overlay CDP injection when Desktop version is unset", () => {
    expect(cpaLiveVoiceOverlayHookAllowed(environment)).toBe(true);
  });

  it.each(["26.1027.61615", "26.1027.30824", "26.1021.31345", "26.1007.30912", "26.1106.51428"])(
    "keeps overlay CDP injection on allowed Desktop %s",
    (version) => {
      expect(
        cpaLiveVoiceOverlayHookAllowed({ ...environment, [DESKTOP_VERSION_ENV]: version }),
      ).toBe(true);
    },
  );

  it("skips overlay CDP injection when voice injection is off", () => {
    expect(cpaLiveVoiceOverlayHookAllowed({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe(false);
  });

  it("prefers the small overlay voice bootstrap only on macOS 26.1106.51428", () => {
    expect(overlayVoiceBootstrapPreferred(environment)).toBe(false);
    expect(
      overlayVoiceBootstrapPreferred({
        ...environment,
        [DESKTOP_VERSION_ENV]: "26.1106.51428",
      }),
    ).toBe(true);
    expect(
      overlayVoiceBootstrapPreferred({
        ...environment,
        [DESKTOP_VERSION_ENV]: "26.1027.61615",
      }),
    ).toBe(false);
  });

  it("consumes renderer voice pins when the overlay directory has them", async () => {
    expect(OVERLAY_VOICE_HOOK_DESKTOP_VERSIONS).toContain("26.1106.51428");
    await writeFile(
      path.join(directory, "voice-profile-pins.json"),
      JSON.stringify({
        hashedVersion: "26.1106.51428",
        overlayHookDesktopVersions: ["26.1200.1"],
      }),
    );
    expect(readVoiceProfilePins(directory)?.overlayHookDesktopVersions).toEqual(["26.1200.1"]);
    expect(
      cpaLiveVoiceOverlayHookAllowed(
        { ...environment, [DESKTOP_VERSION_ENV]: "26.1200.1" },
        directory,
      ),
    ).toBe(true);
    expect(
      cpaLiveVoiceOverlayHookAllowed(
        { ...environment, [DESKTOP_VERSION_ENV]: "26.1027.61615" },
        directory,
      ),
    ).toBe(false);
  });

  it("does not fall back to in-process pins when overlay artifacts are missing or corrupt", async () => {
    const versioned = { ...environment, [DESKTOP_VERSION_ENV]: "26.1027.61615" };
    expect(cpaLiveVoiceOverlayHookAllowed(versioned)).toBe(true);
    expect(cpaLiveVoiceOverlayHookAllowed(versioned, directory)).toBe(false);
    await writeFile(path.join(directory, "voice-profile-pins.json"), "{");
    expect(readVoiceProfilePins(directory)).toBeUndefined();
    expect(cpaLiveVoiceOverlayHookAllowed(versioned, directory)).toBe(false);
    await writeFile(
      path.join(directory, "voice-profile-pins.json"),
      JSON.stringify({ hashedVersion: 26, overlayHookDesktopVersions: ["26.1027.61615"] }),
    );
    expect(readVoiceProfilePins(directory)).toBeUndefined();
    expect(cpaLiveVoiceOverlayHookAllowed(versioned, directory)).toBe(false);
  });

  it("injects packaged qualification without fabricating reviewed evidence", async () => {
    await writeFile(
      path.join(directory, "voice-qualification.json"),
      JSON.stringify({ implementationRevision: "packaged-revision", reviewedEvidence: [] }),
    );
    expect(readVoiceQualification(directory)?.implementationRevision).toBe("packaged-revision");
    const source = cpaLiveVoiceHookBootstrap(environment, "26.1027.61615", directory);
    expect(source).toContain('"implementationRevision":"packaged-revision"');
    expect(source).toContain('"voiceEvidence":[]');
  });

  it("threads launcher native identity into bootstrap instead of evidence records", () => {
    const source = cpaLiveVoiceHookBootstrap({
      ...environment,
      [DESKTOP_VERSION_ENV]: "26.1106.51428",
      [DESKTOP_BUILD_ENV]: "26605",
      [DESKTOP_ASAR_DIGEST_ENV]: `sha256:${"ab".repeat(32)}`,
      [DESKTOP_APP_PATH_ENV]: "/tmp/candidate/ChatGPT.app",
    });
    expect(source).toContain('"desktopBuild":"26605"');
    expect(source).toContain(`"asarDigest":"sha256:${"ab".repeat(32)}"`);
    expect(source).toContain('"desktopAppPath":"/tmp/candidate/ChatGPT.app"');
  });

  it("injects overlay-scoped isolated qualification only for the matching launched app", async () => {
    const identity = {
      path: "chat",
      run: "2026-11-14-isolated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      desktopVersion: "26.1106.51428",
      desktopBuild: "26605",
      asarDigest: `sha256:${"ab".repeat(32)}`,
      appPath: "/tmp/candidate/ChatGPT.app",
      implementationRevision: "packaged-revision",
      label: "unqualified-isolated",
    };
    await writeFile(
      path.join(directory, "voice-qualification.json"),
      JSON.stringify({ implementationRevision: "packaged-revision", reviewedEvidence: [] }),
    );
    await writeFile(
      path.join(directory, "voice-isolated-qualification.json"),
      JSON.stringify(identity),
    );
    const matched = cpaLiveVoiceHookBootstrap(
      {
        ...environment,
        [DESKTOP_VERSION_ENV]: "26.1106.51428",
        [DESKTOP_BUILD_ENV]: "26605",
        [DESKTOP_ASAR_DIGEST_ENV]: identity.asarDigest,
        [DESKTOP_APP_PATH_ENV]: identity.appPath,
      },
      "26.1106.51428",
      directory,
    );
    expect(matched).toContain('"isolatedQualification"');
    expect(matched).toContain('"label":"unqualified-isolated"');
    expect(matched).toContain('"voiceEvidence":[]');
    const production = cpaLiveVoiceHookBootstrap(
      {
        ...environment,
        [DESKTOP_VERSION_ENV]: "26.1106.51428",
        [DESKTOP_BUILD_ENV]: "26605",
        [DESKTOP_ASAR_DIGEST_ENV]: identity.asarDigest,
        [DESKTOP_APP_PATH_ENV]: "/Applications/ChatGPT.app",
      },
      "26.1106.51428",
      directory,
    );
    expect(production).not.toContain("isolatedQualification");
    expect(readVoiceIsolatedQualification(directory)?.run).toBe("2026-11-14-isolated");
  });

  it("does not grant isolated permission when discovered production identity overrides inherited candidate fields", async () => {
    const isolated = {
      path: "chat" as const,
      run: "2026-11-14-isolated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      desktopVersion: "26.1106.51428",
      desktopBuild: "26605",
      asarDigest: `sha256:${"ab".repeat(32)}`,
      appPath: "/tmp/scratch-candidate/ChatGPT.app",
      implementationRevision: "packaged-revision",
      label: "unqualified-isolated" as const,
    };
    await writeFile(
      path.join(directory, "voice-qualification.json"),
      JSON.stringify({ implementationRevision: "packaged-revision", reviewedEvidence: [] }),
    );
    await writeFile(
      path.join(directory, "voice-isolated-qualification.json"),
      JSON.stringify(isolated),
    );
    const inheritedCandidate = {
      ...environment,
      [DESKTOP_VERSION_ENV]: isolated.desktopVersion,
      [DESKTOP_BUILD_ENV]: "99999",
      [DESKTOP_ASAR_DIGEST_ENV]: "sha256:candidate",
      [DESKTOP_APP_PATH_ENV]: isolated.appPath,
    };
    const discoveredProduction = {
      [DESKTOP_VERSION_ENV]: isolated.desktopVersion,
      [DESKTOP_BUILD_ENV]: isolated.desktopBuild,
      [DESKTOP_ASAR_DIGEST_ENV]: isolated.asarDigest,
      [DESKTOP_APP_PATH_ENV]: "/Applications/ChatGPT.app",
    };
    const source = cpaLiveVoiceHookBootstrap(
      { ...inheritedCandidate, ...discoveredProduction },
      isolated.desktopVersion,
      directory,
    );
    expect(source).toContain('"/Applications/ChatGPT.app"');
    expect(source).not.toContain("/tmp/scratch-candidate/ChatGPT.app");
    expect(source).not.toContain("isolatedQualification");
    expect(
      isolatedQualificationMatchesRuntime(isolated, {
        desktopVersion: discoveredProduction[DESKTOP_VERSION_ENV],
        desktopBuild: discoveredProduction[DESKTOP_BUILD_ENV],
        asarDigest: discoveredProduction[DESKTOP_ASAR_DIGEST_ENV],
        appPath: discoveredProduction[DESKTOP_APP_PATH_ENV],
        implementationRevision: "packaged-revision",
      }),
    ).toBe(false);
  });

  it("expires and removes an isolated qualification marker", async () => {
    await writeFile(
      path.join(directory, "voice-isolated-qualification.json"),
      JSON.stringify({
        path: "chat",
        run: "expired",
        expiresAt: new Date(Date.now() - 1).toISOString(),
        desktopVersion: "26.1106.51428",
        desktopBuild: "26605",
        asarDigest: `sha256:${"ab".repeat(32)}`,
        appPath: "/tmp/candidate/ChatGPT.app",
        implementationRevision: "packaged-revision",
        label: "unqualified-isolated",
      }),
    );
    expect(readVoiceIsolatedQualification(directory, Date.now())).toBeUndefined();
    await expect(
      readFile(path.join(directory, "voice-isolated-qualification.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
