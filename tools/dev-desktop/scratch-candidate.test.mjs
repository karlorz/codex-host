import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DISCOVERY_APPS,
  isDiscoveryApp,
  launchPlan,
  parseArguments,
  productionDesktopPids,
  resolveBundle,
  usage,
} from "./scratch-candidate.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-scratch-candidate-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("scratch candidate Desktop", () => {
  it("defaults to print and rejects mixed or unknown options", () => {
    expect(parseArguments([])).toEqual({
      help: false,
      print: true,
      launch: false,
      bundle: undefined,
    });
    expect(parseArguments(["--launch"])).toMatchObject({ launch: true, print: false });
    expect(() => parseArguments(["--print", "--launch"])).toThrow("choose --print or --launch");
    expect(() => parseArguments(["--desktop"])).toThrow("unknown option");
    expect(usage()).toContain("Does not stop production Desktop");
  });

  it("refuses discovery-path bundles and accepts a scratch ChatGPT.app", () => {
    expect(isDiscoveryApp("/Applications/ChatGPT.app")).toBe(true);
    expect(DISCOVERY_APPS[0]).toBe("/Applications/ChatGPT.app");
    expect(() => resolveBundle("/Applications/ChatGPT.app")).toThrow("discovery-path");

    const impact = path.join(temporaryDirectory(), ".codexhost", "update-impact");
    const app = path.join(impact, "26.1103.32239", "bundle", "ChatGPT.app");
    const executable = path.join(app, "Contents/MacOS/ChatGPT");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "fixture\n");
    chmodSync(executable, 0o755);

    const resolved = resolveBundle(app, impact);
    expect(resolved.app).toBe(app);
    expect(resolved.executable).toBe(executable);

    const plan = launchPlan(resolved, 57321);
    expect(plan.environment.CODEXHOST_INSTALL_ROOT).toBe(app);
    expect(plan.environment.CODEX_ELECTRON_USER_DATA_PATH).toContain("electron-user-data");
    expect(plan.arguments.some((argument) => argument.startsWith("--user-data-dir="))).toBe(true);
    expect(plan.installRoot).not.toBe("/Applications/ChatGPT.app");
  });

  it("lists only production Desktop PIDs", () => {
    expect(
      productionDesktopPids(() => [
        "95840 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=53242",
        "12 /tmp/.codexhost/update-impact/26.1103.32239/bundle/ChatGPT.app/Contents/MacOS/ChatGPT",
        "99 /usr/bin/true",
      ]),
    ).toEqual([95840]);
  });
});
