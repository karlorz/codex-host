import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRODUCTION_HOST_DATA,
  PRODUCTION_RUNTIME_DESCRIPTOR,
  commandLineMatchesOwnedController,
  isolatedScratchHostChainEnvironment,
  parseRuntimeDescriptor,
  redactScratchHostChainEnvironment,
} from "./scratch-host-chain.mjs";

const temporaryDirectories = [];
const children = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-scratch-host-chain-"));
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

async function waitForOwned(chain) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return isolatedScratchHostChainEnvironment(chain);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
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

function fixtureFiles(root) {
  const file = (name) => {
    const target = path.join(root, name);
    writeFileSync(target, "fixture\n");
    chmodSync(target, 0o755);
    return realpathSync(target);
  };
  const dataDirectory = path.join(root, "host");
  mkdirSync(dataDirectory, { recursive: true });
  return {
    shim: file("codexhost-shim"),
    hostRuntime: file("host-runtime.mjs"),
    node: file("node"),
    stockCodex: file("codex"),
    dataDirectory: realpathSync(dataDirectory),
    runtimeDescriptor: path.join(root, "desktop-runtime-v1.json"),
  };
}

function liveChain(root, extra = {}) {
  const files = fixtureFiles(root);
  const launcher = spawnIdle();
  const nonce = extra.controlNonce ?? "ab".repeat(16);
  const controlPort = extra.controlPort ?? 61234;
  const controller = spawnIdle([
    "--attachment-port",
    String(controlPort),
    "--attachment-nonce",
    nonce,
    "--host-data",
    files.dataDirectory,
  ]);
  return {
    ...files,
    launcher: realpathSync(process.execPath),
    launcherPid: launcher.pid,
    controlPort,
    controlNonce: nonce,
    controllerPid: controller.pid,
  };
}

describe("isolated scratch Host chain", () => {
  it("requires an explicit live launcher PID matching the launcher executable", async () => {
    const chain = liveChain(temporaryDirectory());
    const environment = await waitForOwned(chain);
    expect(environment.CODEX_CLI_PATH).toBe(chain.shim);
    expect(environment.CODEXHOST_DATA_DIR).toBe(chain.dataDirectory);
    expect(environment.CODEXHOST_DATA_DIR).not.toBe(PRODUCTION_HOST_DATA);
    expect(environment.CODEXHOST_RUNTIME_DESCRIPTOR_PATH).not.toBe(PRODUCTION_RUNTIME_DESCRIPTOR);
    expect(environment.CODEXHOST_STOCK_CODEX_PATH).toBe(chain.stockCodex);
    expect(environment.CODEXHOST_LAUNCHER_EXECUTABLE).toBe(chain.launcher);
    expect(environment.CODEXHOST_LAUNCHER_PID).toBe(String(chain.launcherPid));
    expect(environment.CODEXHOST_CONTROL_NONCE).toBe(chain.controlNonce);
    expect(redactScratchHostChainEnvironment(environment).CODEXHOST_CONTROL_NONCE).toBe("(set)");
  });

  it("rejects omitted launcherPid instead of defaulting to this Node process", async () => {
    const chain = liveChain(temporaryDirectory());
    await waitForOwned(chain);
    expect(() => isolatedScratchHostChainEnvironment({ ...chain, launcherPid: undefined })).toThrow(
      "launcherPid is required",
    );
    expect(() =>
      isolatedScratchHostChainEnvironment({
        ...chain,
        launcher: chain.shim,
        launcherPid: process.pid,
      }),
    ).toThrow("not the native launcher executable");
  });

  it("rejects nonce values that are not exactly 32 lowercase hex characters", async () => {
    const chain = liveChain(temporaryDirectory());
    await waitForOwned(chain);
    expect(() =>
      isolatedScratchHostChainEnvironment({ ...chain, controlNonce: "AB".repeat(16) }),
    ).toThrow("32 lowercase hexadecimal");
    expect(() =>
      isolatedScratchHostChainEnvironment({ ...chain, controlNonce: "ab".repeat(8) }),
    ).toThrow("32 lowercase hexadecimal");
    expect(() =>
      isolatedScratchHostChainEnvironment({ ...chain, controlNonce: `AB${"ab".repeat(15)}` }),
    ).toThrow("32 lowercase hexadecimal");
  });

  it("refuses production Host data, production runtime descriptor, and Shim-as-stock-Codex aliases", async () => {
    const chain = liveChain(temporaryDirectory());
    await waitForOwned(chain);
    expect(() =>
      isolatedScratchHostChainEnvironment({ ...chain, dataDirectory: PRODUCTION_HOST_DATA }),
    ).toThrow("production Host data directory");
    expect(() =>
      isolatedScratchHostChainEnvironment({
        ...chain,
        runtimeDescriptor: PRODUCTION_RUNTIME_DESCRIPTOR,
      }),
    ).toThrow("production Desktop runtime descriptor");
    expect(() => isolatedScratchHostChainEnvironment({ ...chain, stockCodex: chain.shim })).toThrow(
      "stock Codex must not be the Shim",
    );

    const aliasRoot = temporaryDirectory();
    const dataAlias = path.join(aliasRoot, "host-alias");
    symlinkSync(PRODUCTION_HOST_DATA, dataAlias);
    expect(() =>
      isolatedScratchHostChainEnvironment({ ...chain, dataDirectory: dataAlias }),
    ).toThrow("production Host data directory");

    if (existsSync(PRODUCTION_RUNTIME_DESCRIPTOR)) {
      const descriptorAlias = path.join(aliasRoot, "desktop-runtime-v1.json");
      symlinkSync(PRODUCTION_RUNTIME_DESCRIPTOR, descriptorAlias);
      expect(() =>
        isolatedScratchHostChainEnvironment({ ...chain, runtimeDescriptor: descriptorAlias }),
      ).toThrow("production Desktop runtime descriptor");
    }
  });

  it("requires an owned Controller whose attachment identity matches the isolated Host data", async () => {
    const chain = liveChain(temporaryDirectory());
    await waitForOwned(chain);
    expect(() =>
      isolatedScratchHostChainEnvironment({ ...chain, controlPort: chain.controlPort + 1 }),
    ).toThrow("owned Desktop Controller");
    expect(
      commandLineMatchesOwnedController(
        `node --attachment-port ${chain.controlPort} --attachment-nonce ${chain.controlNonce} --host-data ${chain.dataDirectory}`,
        chain.controlPort,
        chain.controlNonce,
        chain.dataDirectory,
      ),
    ).toBe(true);
  });

  it("accepts an existing runtime descriptor only when it matches isolated control identity", async () => {
    const chain = liveChain(temporaryDirectory());
    await waitForOwned(chain);
    writeFileSync(
      chain.runtimeDescriptor,
      JSON.stringify({
        schema_version: 1,
        launcher_pid: chain.launcherPid,
        control_port: chain.controlPort,
        nonce: chain.controlNonce,
      }),
    );
    const environment = isolatedScratchHostChainEnvironment(chain);
    expect(environment.CODEXHOST_CONTROL_PORT).toBe(String(chain.controlPort));
    writeFileSync(
      chain.runtimeDescriptor,
      JSON.stringify({
        schema_version: 1,
        launcher_pid: chain.launcherPid,
        control_port: chain.controlPort,
        nonce: "cd".repeat(16),
      }),
    );
    expect(() => isolatedScratchHostChainEnvironment(chain)).toThrow(
      "runtime descriptor does not match isolated control identity",
    );
    expect(() =>
      parseRuntimeDescriptor(`{"schema_version":1,"nonce":"${"AB".repeat(16)}"}`),
    ).toThrow("invalid");
  });
});
