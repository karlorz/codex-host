/**
 * Isolated scratch Desktop Host-chain environment. LaunchServices still owns
 * TCC; CODEX_CLI_PATH must be the Shim so local sendRequest reaches Host
 * `/v1/desktop`, not stock Codex AppServer. This is not the voice CDP binding.
 *
 * Native contracts: launcherPid is a live process whose executable identity
 * matches CODEXHOST_LAUNCHER_EXECUTABLE (Shim desktop_invocation); nonce is
 * exactly 32 lowercase hex; paths are canonical and must not alias production.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRODUCTION_HOST_DATA = path.join(os.homedir(), ".codexhost");
export const PRODUCTION_RUNTIME_DESCRIPTOR = path.join(
  os.homedir(),
  "Library/Application Support/codexhost/desktop-runtime-v1.json",
);
export const PRODUCTION_LAUNCHER = "/Applications/codexhost.app/Contents/MacOS/codexhost";

const REQUIRED_FILES = ["shim", "launcher", "hostRuntime", "node", "stockCodex"];
const REQUIRED_ABSOLUTE = [...REQUIRED_FILES, "dataDirectory", "runtimeDescriptor"];
const DESCRIPTOR_KEYS = ["schema_version", "launcher_pid", "control_port", "nonce"];
const PROC_PIDPATH_SCRIPT = `import ctypes, sys
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
PROC_PIDPATHINFO_MAXSIZE = 4096
buf = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
fn = lib.proc_pidpath
fn.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
fn.restype = ctypes.c_int
n = fn(int(sys.argv[1]), buf, ctypes.c_uint32(PROC_PIDPATHINFO_MAXSIZE))
if n <= 0:
    raise SystemExit(1)
sys.stdout.write(buf.value.decode())
`;

function requiredAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length === 0) {
    throw new Error(`scratch Host chain ${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function canonicalExistingFile(value, name) {
  const resolved = requiredAbsolute(value, name);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`scratch Host chain ${name} is missing`);
  }
  const real = realpathSync(resolved);
  if (!statSync(real).isFile()) {
    throw new Error(`scratch Host chain ${name} is missing`);
  }
  return real;
}

function canonicalExistingDirectory(value, name) {
  const resolved = requiredAbsolute(value, name);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`scratch Host chain ${name} is missing`);
  }
  return realpathSync(resolved);
}

function canonicalDescriptorPath(value) {
  const resolved = requiredAbsolute(value, "runtimeDescriptor");
  if (existsSync(resolved)) {
    if (!statSync(resolved).isFile()) {
      throw new Error("scratch Host chain runtimeDescriptor is not a file");
    }
    return realpathSync(resolved);
  }
  const parent = path.dirname(resolved);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error("scratch Host chain runtimeDescriptor directory is missing");
  }
  return path.join(realpathSync(parent), path.basename(resolved));
}

function canonicalIfExists(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function sameIdentity(left, right) {
  return canonicalIfExists(left) === canonicalIfExists(right);
}

function defaultProcessList() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error("scratch Host chain process list failed");
  return result.stdout.split("\n").filter(Boolean);
}

export function processExecutablePath(pid, run = spawnSync) {
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error("scratch Host chain launcherPid executable is unavailable");
  }
  if (process.platform === "darwin") {
    const result = run("python3", ["-c", PROC_PIDPATH_SCRIPT, String(pid)], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0) {
      throw new Error("scratch Host chain launcherPid executable is unavailable");
    }
    const value = String(result.stdout ?? "").trim();
    if (!value) throw new Error("scratch Host chain launcherPid executable is unavailable");
    return realpathSync(value);
  }
  if (process.platform === "linux") {
    return realpathSync(`/proc/${pid}/exe`);
  }
  throw new Error("scratch Host chain launcherPid verification requires macOS or Linux");
}

export function parseRuntimeDescriptor(bytes) {
  let descriptor;
  try {
    descriptor = JSON.parse(bytes);
  } catch {
    throw new Error("scratch Host chain runtime descriptor is invalid");
  }
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("scratch Host chain runtime descriptor is invalid");
  }
  const keys = Object.keys(descriptor);
  if (
    keys.length !== DESCRIPTOR_KEYS.length ||
    keys.some((key) => !DESCRIPTOR_KEYS.includes(key))
  ) {
    throw new Error("scratch Host chain runtime descriptor is invalid");
  }
  if (descriptor.schema_version !== 1) {
    throw new Error("scratch Host chain runtime descriptor is invalid");
  }
  const launcherPid = descriptor.launcher_pid;
  const controlPort = descriptor.control_port;
  const nonce = descriptor.nonce;
  if (!Number.isInteger(launcherPid) || launcherPid < 1) {
    throw new Error("scratch Host chain runtime descriptor is invalid");
  }
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error("scratch Host chain runtime descriptor is invalid");
  }
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error("scratch Host chain runtime descriptor is invalid");
  }
  return { schema_version: 1, launcher_pid: launcherPid, control_port: controlPort, nonce };
}

export function commandLineMatchesOwnedController(command, port, nonce, dataDirectory) {
  const parts = String(command)
    .trim()
    .replace(/^\d+\s+/u, "")
    .split(/\s+/u);
  let sawPort = false;
  let sawNonce = false;
  let sawHostData = false;
  const expectedData = canonicalIfExists(dataDirectory);
  for (let index = 0; index < parts.length; index += 1) {
    const argument = parts[index];
    const value = parts[index + 1];
    if (argument === "--attachment-port" && value === String(port)) sawPort = true;
    if (argument === "--attachment-nonce" && value === nonce) sawNonce = true;
    if (argument === "--host-data" && value && sameIdentity(value, expectedData))
      sawHostData = true;
  }
  return sawPort && sawNonce && sawHostData;
}

function liveOwnedController(port, nonce, dataDirectory, processList) {
  return processList().some((line) =>
    commandLineMatchesOwnedController(line, port, nonce, dataDirectory),
  );
}

export function isolatedScratchHostChainEnvironment(input, inspect = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("scratch Host chain requires an object");
  }
  for (const name of REQUIRED_ABSOLUTE) {
    if (typeof input[name] !== "string" || input[name].length === 0) {
      throw new Error(`scratch Host chain ${name} is required`);
    }
  }
  const files = Object.fromEntries(
    REQUIRED_FILES.map((name) => [name, canonicalExistingFile(input[name], name)]),
  );
  const dataDirectory = canonicalExistingDirectory(input.dataDirectory, "dataDirectory");
  const runtimeDescriptorFile = canonicalDescriptorPath(input.runtimeDescriptor);
  if (sameIdentity(dataDirectory, PRODUCTION_HOST_DATA)) {
    throw new Error("scratch Host chain must not use the production Host data directory");
  }
  if (sameIdentity(runtimeDescriptorFile, PRODUCTION_RUNTIME_DESCRIPTOR)) {
    throw new Error("scratch Host chain must not use the production Desktop runtime descriptor");
  }
  if (sameIdentity(files.stockCodex, files.shim)) {
    throw new Error("scratch Host chain stock Codex must not be the Shim");
  }
  const controlPort = Number(input.controlPort);
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error("scratch Host chain controlPort must be an integer 1–65535");
  }
  const controlNonce = input.controlNonce;
  if (typeof controlNonce !== "string" || !/^[0-9a-f]{32}$/u.test(controlNonce)) {
    throw new Error("scratch Host chain controlNonce must be 32 lowercase hexadecimal characters");
  }
  if (input.launcherPid === undefined || input.launcherPid === null) {
    throw new Error("scratch Host chain launcherPid is required");
  }
  const launcherPid = Number(input.launcherPid);
  if (!Number.isInteger(launcherPid) || launcherPid < 1) {
    throw new Error("scratch Host chain launcherPid must be a positive integer");
  }
  const executableFor = inspect.processExecutablePath ?? processExecutablePath;
  const liveLauncher = executableFor(launcherPid);
  if (liveLauncher !== files.launcher) {
    throw new Error("scratch Host chain launcherPid is not the native launcher executable");
  }
  if (existsSync(PRODUCTION_LAUNCHER) && sameIdentity(liveLauncher, PRODUCTION_LAUNCHER)) {
    throw new Error("scratch Host chain must not use the production launcher");
  }
  if (existsSync(runtimeDescriptorFile) && statSync(runtimeDescriptorFile).isFile()) {
    const descriptor = parseRuntimeDescriptor(readFileSync(runtimeDescriptorFile, "utf8"));
    if (
      descriptor.launcher_pid !== launcherPid ||
      descriptor.control_port !== controlPort ||
      descriptor.nonce !== controlNonce
    ) {
      throw new Error(
        "scratch Host chain runtime descriptor does not match isolated control identity",
      );
    }
  }
  const processList = inspect.processList ?? defaultProcessList;
  if (!liveOwnedController(controlPort, controlNonce, dataDirectory, processList)) {
    throw new Error(
      "scratch Host chain control identity does not match an owned Desktop Controller",
    );
  }
  return {
    CODEX_CLI_PATH: files.shim,
    CODEXHOST_STOCK_CODEX_PATH: files.stockCodex,
    CODEXHOST_HOST_NODE_PATH: files.node,
    CODEXHOST_HOST_RUNTIME_PATH: files.hostRuntime,
    CODEXHOST_LAUNCHER_EXECUTABLE: files.launcher,
    CODEXHOST_LAUNCHER_PID: String(launcherPid),
    CODEXHOST_DATA_DIR: dataDirectory,
    CODEXHOST_RUNTIME_DESCRIPTOR_PATH: runtimeDescriptorFile,
    CODEXHOST_CONTROL_PORT: String(controlPort),
    CODEXHOST_CONTROL_NONCE: controlNonce,
  };
}

export function redactScratchHostChainEnvironment(environment) {
  if (!environment || typeof environment !== "object") return environment;
  const redacted = { ...environment };
  if (typeof redacted.CODEXHOST_CONTROL_NONCE === "string") {
    redacted.CODEXHOST_CONTROL_NONCE = "(set)";
  }
  return redacted;
}
