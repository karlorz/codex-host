#!/usr/bin/env node
/**
 * Launch a disposable Sparkle-candidate ChatGPT.app without stopping production.
 * Never targets /Applications/ChatGPT.app or ~/Applications/ChatGPT.app.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMPACT = path.join(ROOT, ".codexhost", "update-impact");
const PRODUCTION_APP = "/Applications/ChatGPT.app";
const PRODUCTION_EXECUTABLE = `${PRODUCTION_APP}/Contents/MacOS/ChatGPT`;
const HOST_APP = "/Applications/codexhost.app";
const OPEN = "/usr/bin/open";
const RESPONSIBLE_PID_SCRIPT = `import ctypes, sys
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
fn = lib.responsibility_get_pid_responsible_for_pid
fn.argtypes = [ctypes.c_int]
fn.restype = ctypes.c_int
print(fn(int(sys.argv[1])))
`;

export const DISCOVERY_APPS = [
  PRODUCTION_APP,
  "/Applications/Codex.app",
  path.join(os.homedir(), "Applications/ChatGPT.app"),
  path.join(os.homedir(), "Applications/Codex.app"),
];

export function usage() {
  return `usage: npm run scratch:candidate -- [--print|--launch] [--bundle <ChatGPT.app>]

Launch or describe a scratch Sparkle candidate. Does not stop production Desktop.

options:
  --print             print paths, production PIDs, and the launch plan
  --launch            start the scratch executable with an isolated user-data dir
  --bundle <app>      ChatGPT.app under .codexhost/update-impact (default: newest)
  --help              show this help`;
}

export function parseArguments(arguments_) {
  const options = { help: false, print: false, launch: false, bundle: undefined };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--print") {
      if (options.print) throw new Error("--print may only be provided once");
      options.print = true;
      continue;
    }
    if (argument === "--launch") {
      if (options.launch) throw new Error("--launch may only be provided once");
      options.launch = true;
      continue;
    }
    if (argument === "--bundle") {
      if (options.bundle) throw new Error("--bundle may only be provided once");
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--bundle requires a ChatGPT.app path");
      options.bundle = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (options.print && options.launch) throw new Error("choose --print or --launch");
  if (!options.help && !options.print && !options.launch) options.print = true;
  return options;
}

export function isDiscoveryApp(appPath) {
  const resolved = path.resolve(appPath);
  return DISCOVERY_APPS.some((candidate) => path.resolve(candidate) === resolved);
}

function newestScratchBundle(impactRoot = IMPACT) {
  if (!existsSync(impactRoot)) return undefined;
  const versions = readdirSync(impactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/u.test(entry.name))
    .map((entry) => {
      const app = path.join(impactRoot, entry.name, "bundle", "ChatGPT.app");
      return existsSync(path.join(app, "Contents/MacOS/ChatGPT"))
        ? { app, mtime: statSync(app).mtimeMs }
        : undefined;
    })
    .filter(Boolean)
    .sort((left, right) => right.mtime - left.mtime);
  return versions[0]?.app;
}

export function resolveBundle(bundleArgument, impactRoot = IMPACT) {
  const app = bundleArgument ? path.resolve(bundleArgument) : newestScratchBundle(impactRoot);
  if (!app) {
    throw new Error("no scratch ChatGPT.app under .codexhost/update-impact/*/bundle/");
  }
  if (isDiscoveryApp(app)) {
    throw new Error(`refusing discovery-path bundle: ${app}`);
  }
  if (!app.includes(`${path.sep}.codexhost${path.sep}update-impact${path.sep}`)) {
    throw new Error(`scratch bundle must live under .codexhost/update-impact: ${app}`);
  }
  const executable = path.join(app, "Contents/MacOS/ChatGPT");
  if (!existsSync(executable)) throw new Error(`missing executable: ${executable}`);
  return { app, executable };
}

export function productionDesktopPids(listProcesses = defaultProcessList) {
  return listProcesses()
    .filter(
      (line) => line.includes(`${PRODUCTION_EXECUTABLE} `) || line.endsWith(PRODUCTION_EXECUTABLE),
    )
    .map((line) => Number.parseInt(line.trim().split(/\s+/u)[0], 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function defaultProcessList() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error("ps failed");
  return result.stdout.split("\n").filter(Boolean);
}

function versionDirectory(app) {
  return path.dirname(path.dirname(app));
}

export function layoutForBundle(app) {
  const root = versionDirectory(app);
  return {
    app,
    executable: path.join(app, "Contents/MacOS/ChatGPT"),
    userData: path.join(root, "electron-user-data"),
    pidFile: path.join(root, "scratch-desktop.pid"),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

export function launchPlan(bundle, port) {
  const layout = layoutForBundle(bundle.app);
  return {
    launchMethod: "launch-services",
    installRoot: layout.app,
    executable: layout.executable,
    userData: layout.userData,
    pidFile: layout.pidFile,
    arguments: [
      `--user-data-dir=${layout.userData}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
    ],
    environment: {
      CODEXHOST_INSTALL_ROOT: layout.app,
      CODEX_ELECTRON_USER_DATA_PATH: layout.userData,
    },
  };
}

export function launchServicesInvocation(plan) {
  const envArgs = Object.entries(plan.environment).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);
  return {
    command: OPEN,
    arguments: ["-n", "-F", ...envArgs, plan.installRoot, "--args", ...plan.arguments],
  };
}

export function isScratchMainCommand(command, executable, userData) {
  const trimmed = command.trim();
  if (!(trimmed === executable || trimmed.startsWith(`${executable} `))) return false;
  return trimmed.includes(`--user-data-dir=${userData}`);
}

export function classifyPrivacyResponsible(command, scratchApp) {
  const trimmed = command.trim();
  if (trimmed.includes(`${HOST_APP}/Contents/MacOS/`)) return "host-launcher";
  if (trimmed.includes(`${PRODUCTION_APP}/Contents/MacOS/`)) return "production-desktop";
  if (trimmed.includes(`${scratchApp}/Contents/MacOS/`)) return "scratch-desktop";
  return "unknown";
}

export function parseResponsiblePid(stdout) {
  const pid = Number.parseInt(String(stdout).trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function responsiblePidFor(pid, run = spawnSync) {
  const result = run("python3", ["-c", RESPONSIBLE_PID_SCRIPT, String(pid)], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) {
    throw new Error("responsibility_get_pid_responsible_for_pid probe failed");
  }
  const responsible = parseResponsiblePid(result.stdout);
  if (!responsible) throw new Error("responsibility_get_pid_responsible_for_pid returned no pid");
  return responsible;
}

function commandForPid(pid, listProcesses = defaultProcessList) {
  const prefix = `${pid} `;
  const line = listProcesses().find((entry) => entry.trimStart().startsWith(prefix));
  if (!line) return undefined;
  return line.trim().replace(/^\d+\s+/u, "");
}

function scratchMainPid(executable, userData, listProcesses = defaultProcessList) {
  const matches = listProcesses()
    .map((line) => {
      const trimmed = line.trim();
      const pid = Number.parseInt(trimmed.split(/\s+/u)[0], 10);
      const command = trimmed.replace(/^\d+\s+/u, "");
      return { pid, command };
    })
    .filter(
      (entry) =>
        Number.isInteger(entry.pid) &&
        entry.pid > 0 &&
        isScratchMainCommand(entry.command, executable, userData),
    );
  if (matches.length === 1) return matches[0].pid;
  if (matches.length > 1) {
    throw new Error(
      `multiple scratch Desktop mains matched (${matches.map((entry) => entry.pid).join(",")})`,
    );
  }
  return undefined;
}

function clearQuarantine(app) {
  spawnSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app], { timeout: 10_000 });
}

function readPidFile(pidFile) {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function describeScratch(options, listProcesses = defaultProcessList) {
  const bundle = resolveBundle(options.bundle);
  const port = await freePort();
  const plan = launchPlan(bundle, port);
  return {
    productionApp: PRODUCTION_APP,
    productionPids: productionDesktopPids(listProcesses),
    scratch: plan,
  };
}

export async function launchScratch(options, listProcesses = defaultProcessList) {
  if (process.platform !== "darwin") {
    throw new Error("scratch candidate launch is macOS-only");
  }
  const before = productionDesktopPids(listProcesses);
  const description = await describeScratch(options, listProcesses);
  const existing = readPidFile(description.scratch.pidFile);
  if (existing && processAlive(existing)) {
    throw new Error(`scratch Desktop already running as PID ${existing}`);
  }
  mkdirSync(description.scratch.userData, { recursive: true });
  clearQuarantine(description.scratch.installRoot);
  const invocation = launchServicesInvocation(description.scratch);
  const opened = spawnSync(invocation.command, invocation.arguments, {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (opened.status !== 0) {
    throw new Error(
      `LaunchServices open failed (${opened.status ?? "null"}): ${(opened.stderr || opened.stdout || "").trim()}`,
    );
  }
  let scratchPid;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    scratchPid = scratchMainPid(
      description.scratch.executable,
      description.scratch.userData,
      listProcesses,
    );
    if (scratchPid) break;
    await wait(250);
  }
  if (!scratchPid) throw new Error("scratch Desktop did not appear after LaunchServices open");
  writeFileSync(description.scratch.pidFile, `${scratchPid}\n`);
  const after = productionDesktopPids(listProcesses);
  const productionLost = before.filter((pid) => !after.includes(pid));
  if (productionLost.length > 0) {
    try {
      process.kill(scratchPid, "SIGTERM");
    } catch {
      // Scratch process may have already exited.
    }
    throw new Error(
      `aborting scratch launch: production Desktop PIDs disappeared (${productionLost.join(",")})`,
    );
  }
  if (!processAlive(scratchPid)) {
    throw new Error("scratch Desktop exited immediately");
  }
  const responsiblePid = responsiblePidFor(scratchPid);
  const responsibleCommand = commandForPid(responsiblePid, listProcesses) ?? "";
  const privacyResponsible =
    responsiblePid === scratchPid
      ? "scratch-desktop"
      : classifyPrivacyResponsible(responsibleCommand, description.scratch.installRoot);
  if (privacyResponsible !== "scratch-desktop") {
    try {
      process.kill(scratchPid, "SIGTERM");
    } catch {
      // Scratch process may have already exited.
    }
    throw new Error(
      `aborting scratch launch: TCC responsible process is ${privacyResponsible} (pid ${responsiblePid}), not the scratch bundle`,
    );
  }
  return {
    ...description,
    productionPidsBefore: before,
    productionPidsAfter: after,
    scratchPid,
    responsiblePid,
    privacyResponsible,
    launchInvocation: invocation,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = options.launch ? await launchScratch(options) : await describeScratch(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
