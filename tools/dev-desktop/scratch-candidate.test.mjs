import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DISCOVERY_APPS,
  classifyPrivacyResponsible,
  isDiscoveryApp,
  isScratchMainCommand,
  launchPlan,
  launchServicesInvocation,
  packagedCodexCliFromBundle,
  parseArguments,
  parseResponsiblePid,
  productionDesktopPids,
  resolveBundle,
  sanitizedScratchLaunchEnvironment,
  usage,
} from "./scratch-candidate.mjs";

const temporaryDirectories = [];
const children = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-scratch-candidate-"));
  temporaryDirectories.push(directory);
  return directory;
}

function spawnIdle(args = []) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", ...args], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Fixture process may have already exited.
    }
  }
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
      hostChain: undefined,
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
    expect(plan.launchMethod).toBe("launch-services");
    expect(plan.environment.CODEXHOST_INSTALL_ROOT).toBe(app);
    expect(plan.environment.CODEX_ELECTRON_USER_DATA_PATH).toContain("electron-user-data");
    expect(plan.environment.CODEX_CLI_PATH).toBeUndefined();
    expect(plan.environment.CODEXHOST_DATA_DIR).toBeUndefined();
    expect(plan.environment.CODEXHOST_CONTROL_PORT).toBeUndefined();
    expect(plan.environment.CODEXHOST_CONTROL_NONCE).toBeUndefined();
    expect(plan.environment.CODEXHOST_LAUNCHER_PID).toBeUndefined();
    expect(plan.arguments.some((argument) => argument.startsWith("--user-data-dir="))).toBe(true);
    expect(plan.arguments).toContain("--remote-debugging-port=57321");
    expect(plan.installRoot).not.toBe("/Applications/ChatGPT.app");

    const invocation = launchServicesInvocation(plan);
    expect(invocation.command).toBe("/usr/bin/open");
    expect(invocation.arguments[0]).toBe("-n");
    expect(invocation.arguments).toContain("-F");
    expect(invocation.arguments).not.toContain("-W");
    expect(invocation.arguments).toContain(app);
    expect(invocation.arguments).not.toContain(executable);
    expect(
      invocation.arguments.includes("--env") &&
        invocation.arguments.some((argument) => argument.startsWith("CODEXHOST_INSTALL_ROOT=")),
    ).toBe(true);
    const argsIndex = invocation.arguments.indexOf("--args");
    expect(argsIndex).toBeGreaterThan(-1);
    expect(invocation.arguments.slice(argsIndex + 1)).toEqual(plan.arguments);
    expect(invocation.arguments[argsIndex - 1]).toBe(app);
  });

  it("attributes TCC responsibility to the scratch bundle, not the host launcher", () => {
    const scratchApp = "/tmp/.codexhost/update-impact/26.1106.51428/bundle/ChatGPT.app";
    const scratchMain = `${scratchApp}/Contents/MacOS/ChatGPT --user-data-dir=/tmp/electron-user-data`;
    const helper = `${scratchApp}/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)`;
    expect(classifyPrivacyResponsible(scratchMain, scratchApp)).toBe("scratch-desktop");
    expect(
      classifyPrivacyResponsible(
        "/Applications/codexhost.app/Contents/MacOS/codexhost",
        scratchApp,
      ),
    ).toBe("host-launcher");
    expect(
      classifyPrivacyResponsible(
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=62533",
        scratchApp,
      ),
    ).toBe("production-desktop");
    expect(classifyPrivacyResponsible(helper, scratchApp)).toBe("unknown");
    expect(
      isScratchMainCommand(
        scratchMain,
        `${scratchApp}/Contents/MacOS/ChatGPT`,
        "/tmp/electron-user-data",
      ),
    ).toBe(true);
    expect(
      isScratchMainCommand(
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=/tmp/electron-user-data",
        `${scratchApp}/Contents/MacOS/ChatGPT`,
        "/tmp/electron-user-data",
      ),
    ).toBe(false);
    expect(parseResponsiblePid("11927\n")).toBe(11927);
    expect(parseResponsiblePid("nope")).toBeUndefined();
  });

  it("does not declare microphone usage on the LSUIElement host packaging template", () => {
    const packaging = readFileSync(
      new URL("../../scripts/release/macos/package.sh", import.meta.url),
      "utf8",
    );
    expect(packaging).toContain("com.codexhost.app");
    expect(packaging).toContain("LSUIElement");
    expect(packaging).not.toContain("NSMicrophoneUsageDescription");
    expect(packaging).not.toContain("NSCameraUsageDescription");
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

  it("adds an isolated Shim Host chain without using production Host data", async () => {
    const root = temporaryDirectory();
    const impact = path.join(root, ".codexhost", "update-impact");
    const app = path.join(impact, "26.1106.51428", "bundle", "ChatGPT.app");
    const executable = path.join(app, "Contents/MacOS/ChatGPT");
    const stockCodex = path.join(app, "Contents/Resources/codex");
    mkdirSync(path.dirname(executable), { recursive: true });
    mkdirSync(path.dirname(stockCodex), { recursive: true });
    writeFileSync(executable, "fixture\n");
    writeFileSync(stockCodex, "fixture-cli\n");
    chmodSync(executable, 0o755);
    chmodSync(stockCodex, 0o755);
    const file = (name) => {
      const target = path.join(root, name);
      writeFileSync(target, "fixture\n");
      chmodSync(target, 0o755);
      return realpathSync(target);
    };
    const dataDirectory = path.join(root, "isolated-host");
    mkdirSync(dataDirectory, { recursive: true });
    const nonce = "ab".repeat(16);
    const launcher = spawnIdle();
    spawnIdle([
      "--attachment-port",
      "62947",
      "--attachment-nonce",
      nonce,
      "--host-data",
      realpathSync(dataDirectory),
    ]);
    const hostChain = {
      shim: file("codexhost-shim"),
      launcher: realpathSync(process.execPath),
      hostRuntime: file("host-runtime.mjs"),
      node: file("node"),
      stockCodex: realpathSync(stockCodex),
      dataDirectory,
      runtimeDescriptor: path.join(root, "desktop-runtime-v1.json"),
      controlPort: 62947,
      controlNonce: nonce,
      launcherPid: launcher.pid,
    };
    const deadline = Date.now() + 5000;
    let plan;
    let lastError;
    while (Date.now() < deadline) {
      try {
        plan = launchPlan(resolveBundle(app, impact), 62343, hostChain);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!plan) throw lastError;
    expect(plan.environment.CODEX_CLI_PATH).toBe(hostChain.shim);
    expect(plan.environment.CODEXHOST_DATA_DIR).toBe(realpathSync(dataDirectory));
    expect(plan.environment.CODEXHOST_DATA_DIR).not.toBe(path.join(os.homedir(), ".codexhost"));
    expect(plan.environment.CODEXHOST_CONTROL_PORT).toBe("62947");
    expect(plan.environment.CODEXHOST_LAUNCHER_PID).toBe(String(launcher.pid));
    expect(plan.environment.CODEXHOST_STOCK_CODEX_PATH).toBe(packagedCodexCliFromBundle(app));
    const invocation = launchServicesInvocation(plan);
    expect(invocation.arguments.some((argument) => argument.startsWith("CODEX_CLI_PATH="))).toBe(
      true,
    );
    expect(
      invocation.arguments.some((argument) =>
        argument.startsWith(`CODEXHOST_DATA_DIR=${realpathSync(dataDirectory)}`),
      ),
    ).toBe(true);
  });

  it("strips inherited Shim/Host control variables from the LaunchServices child environment", () => {
    const cleaned = sanitizedScratchLaunchEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CODEX_CLI_PATH: "/Applications/codexhost.app/Contents/Resources/libexec/codexhost-shim",
      CODEXHOST_DATA_DIR: path.join(os.homedir(), ".codexhost"),
      CODEXHOST_CONTROL_NONCE: "ab".repeat(16),
      CODEXHOST_CONTROL_PORT: "62534",
      CODEXHOST_LAUNCHER_PID: "11927",
      USER: "fixture",
    });
    expect(cleaned.PATH).toBe("/usr/bin");
    expect(cleaned.USER).toBe("fixture");
    expect(cleaned.CODEX_CLI_PATH).toBeUndefined();
    expect(cleaned.CODEXHOST_DATA_DIR).toBeUndefined();
    expect(cleaned.CODEXHOST_CONTROL_NONCE).toBeUndefined();
    expect(cleaned.CODEXHOST_LAUNCHER_PID).toBeUndefined();
  });
});
