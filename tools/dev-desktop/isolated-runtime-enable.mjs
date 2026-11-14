#!/usr/bin/env node
/**
 * Bounded maintainer probe: Runtime.enable on one loopback Renderer page whose
 * listening process matches an owned isolated executable and user-data.
 * Does not inject the overlay, quit Desktop, or print page titles/transcripts.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROBE_OUTCOMES = Object.freeze({
  ok: "ok",
  invalidArgs: "invalid-args",
  endpointNotLoopback: "endpoint-not-loopback",
  productionIdentity: "production-identity",
  identityUnverified: "identity-unverified",
  identityMismatch: "identity-mismatch",
  noRendererPage: "no-renderer-page",
  targetListTimeout: "target-list-timeout",
  targetListHttp: "target-list-http",
  enableTimeout: "enable-timeout",
  enableError: "enable-error",
  socketError: "socket-error",
  listenerWebsocketMismatch: "listener-websocket-mismatch",
  aborted: "aborted",
});

function posixPath(value) {
  return value.replaceAll("\\", "/");
}

function isAbsolutePath(value) {
  return path.posix.isAbsolute(posixPath(value)) || path.win32.isAbsolute(value);
}

function isProductionDesktopAppPath(appPath) {
  const normalized = posixPath(appPath).replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  if (
    normalized === "/Applications/ChatGPT.app" ||
    normalized === "/Applications/Codex.app" ||
    normalized.endsWith("/Applications/ChatGPT.app") ||
    normalized.endsWith("/Applications/Codex.app")
  ) {
    return true;
  }
  if (lower.includes("/windowsapps/") && /openai\.(codex|chatgpt)/i.test(normalized)) {
    return true;
  }
  if (
    /\/chatgpt\.exe$/i.test(normalized) &&
    (lower.includes("/appdata/local/chatgpt/") ||
      lower.includes("/program files/") ||
      lower.includes("/program files (x86)/"))
  ) {
    return true;
  }
  return false;
}

function isProductionUserDataPath(userData) {
  const normalized = posixPath(userData);
  return (
    normalized.includes("/Library/Application Support/com.openai") ||
    normalized.includes("/Packages/OpenAI.")
  );
}

export function isOwnedIsolatedUserDataPath(userData) {
  const normalized = posixPath(userData);
  return (
    normalized.includes("/.codexhost/update-impact/") || normalized.includes("codexhost-isolated")
  );
}

export function commandOwnsIsolatedCandidate(commandLine, appPath, userData) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return false;
  const command = posixPath(commandLine);
  const app = posixPath(appPath);
  const data = posixPath(userData);
  if (!command.includes(data)) return false;
  return command.includes(app) || command.includes(posixPath(path.win32.normalize(appPath)));
}

export function parseProbeArguments(arguments_) {
  const options = { endpoint: undefined, appPath: undefined, userData: undefined, timeoutMs: 8000 };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(arguments_[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (argument === "--app-path") {
      options.appPath = arguments_[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--user-data") {
      options.userData = arguments_[index + 1];
      index += 1;
      continue;
    }
    if (!argument.startsWith("--") && !options.endpoint) {
      options.endpoint = argument;
      continue;
    }
    return { ok: false, error: PROBE_OUTCOMES.invalidArgs };
  }
  if (
    !options.endpoint ||
    !options.appPath ||
    !options.userData ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    return { ok: false, error: PROBE_OUTCOMES.invalidArgs };
  }
  if (!isAbsolutePath(options.appPath) || !isAbsolutePath(options.userData)) {
    return { ok: false, error: PROBE_OUTCOMES.invalidArgs };
  }
  if (isProductionDesktopAppPath(options.appPath) || isProductionUserDataPath(options.userData)) {
    return { ok: false, error: PROBE_OUTCOMES.productionIdentity };
  }
  if (!isOwnedIsolatedUserDataPath(options.userData)) {
    return { ok: false, error: PROBE_OUTCOMES.invalidArgs };
  }
  try {
    const parsed = new URL(options.endpoint);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
      return { ok: false, error: PROBE_OUTCOMES.endpointNotLoopback };
    }
    const port = Number.parseInt(parsed.port, 10);
    if (!Number.isFinite(port) || port <= 0)
      return { ok: false, error: PROBE_OUTCOMES.invalidArgs };
    return { ok: true, ...options, port };
  } catch {
    return { ok: false, error: PROBE_OUTCOMES.invalidArgs };
  }
}

function lookupPosixListenerCommand(port, spawn) {
  const lsof = spawn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (lsof.status !== 0) return null;
  const pidLine = String(lsof.stdout ?? "")
    .split("\n")
    .find((line) => line.startsWith("p"));
  const pid = pidLine ? Number.parseInt(pidLine.slice(1), 10) : NaN;
  if (!Number.isFinite(pid)) return null;
  const ps = spawn("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (ps.status !== 0) return null;
  const commandLine = String(ps.stdout ?? "").trim();
  return commandLine ? { pid, commandLine } : null;
}

function parseWindowsProcessIdentity(stdout) {
  const text = String(stdout ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const parts = [row?.ExecutablePath, row?.CommandLine].filter(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    return parts.length > 0 ? parts.join(" ") : null;
  } catch {
    let executablePath = "";
    let commandLine = "";
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("ExecutablePath="))
        executablePath = line.slice("ExecutablePath=".length).trim();
      if (line.startsWith("CommandLine=")) commandLine = line.slice("CommandLine=".length).trim();
    }
    const parts = [executablePath, commandLine].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  }
}

function lookupWindowsListenerCommand(port, spawn) {
  const netstat = spawn("netstat", ["-ano", "-p", "TCP"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (netstat.status !== 0) return null;
  const match = String(netstat.stdout ?? "").match(
    new RegExp(
      String.raw`^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):${port}\s+\S+\s+LISTENING\s+(\d+)\s*$`,
      "im",
    ),
  );
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const powershell = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  let commandLine = powershell.status === 0 ? parseWindowsProcessIdentity(powershell.stdout) : null;
  if (!commandLine) {
    const wmic = spawn(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "ExecutablePath,CommandLine", "/FORMAT:LIST"],
      { encoding: "utf8", timeout: 3000 },
    );
    commandLine = wmic.status === 0 ? parseWindowsProcessIdentity(wmic.stdout) : null;
  }
  return commandLine ? { pid, commandLine } : null;
}

export function lookupListenerCommand(port, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawnSync ?? spawnSync;
  if (platform === "darwin" || platform === "linux") {
    return lookupPosixListenerCommand(port, spawn);
  }
  if (platform === "win32") {
    return lookupWindowsListenerCommand(port, spawn);
  }
  return null;
}

export function websocketMatchesVerifiedListener(webSocketDebuggerUrl, port) {
  if (typeof webSocketDebuggerUrl !== "string") return false;
  try {
    const url = new URL(webSocketDebuggerUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) return false;
    const fallback = url.protocol === "wss:" ? "443" : "80";
    const wsPort = Number.parseInt(url.port || fallback, 10);
    return wsPort === port;
  } catch {
    return false;
  }
}

export function classifyProbeFailure(error) {
  if (
    error &&
    typeof error === "object" &&
    "outcome" in error &&
    typeof error.outcome === "string"
  ) {
    return error.outcome;
  }
  if (error && typeof error === "object" && error.name === "AbortError")
    return PROBE_OUTCOMES.aborted;
  return PROBE_OUTCOMES.aborted;
}

export async function readJsonWithDeadline(response, signal) {
  const aborted = new Promise((_, reject) => {
    const fail = () => {
      const error = new Error("aborted");
      error.outcome = PROBE_OUTCOMES.targetListTimeout;
      reject(error);
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([response.json(), aborted]);
}

function fail(outcome) {
  const error = new Error(outcome);
  error.outcome = outcome;
  throw error;
}

export function isPrimaryRendererPage(target) {
  return (
    Boolean(target) &&
    target.type === "page" &&
    typeof target.url === "string" &&
    target.url.startsWith("app://-/index.html") &&
    !target.url.includes("avatar-overlay") &&
    typeof target.webSocketDebuggerUrl === "string"
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function probeIsolatedRuntimeEnable(options) {
  const startedAt = Date.now();
  const parsed = parseProbeArguments(options.arguments);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, elapsedMs: Date.now() - startedAt };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), parsed.timeoutMs);
  let socket;
  let pageCount = 0;
  try {
    const listener = (options.lookupListener ?? lookupListenerCommand)(parsed.port);
    if (!listener?.commandLine) fail(PROBE_OUTCOMES.identityUnverified);
    if (!commandOwnsIsolatedCandidate(listener.commandLine, parsed.appPath, parsed.userData)) {
      fail(PROBE_OUTCOMES.identityMismatch);
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep = options.sleep ?? delay;
    const listUrl = `${parsed.endpoint.replace(/\/$/, "")}/json/list`;
    let pages = [];
    while (!controller.signal.aborted) {
      const response = await fetchImpl(listUrl, {
        signal: controller.signal,
      });
      if (!response.ok) fail(PROBE_OUTCOMES.targetListHttp);
      const targets = await readJsonWithDeadline(response, controller.signal);
      const rendererPages = (Array.isArray(targets) ? targets : []).filter(isPrimaryRendererPage);
      pageCount = rendererPages.length;
      pages = rendererPages.filter((target) =>
        websocketMatchesVerifiedListener(target.webSocketDebuggerUrl, parsed.port),
      );
      if (pages.length > 0) break;
      if (rendererPages.length > 0) fail(PROBE_OUTCOMES.listenerWebsocketMismatch);
      if (controller.signal.aborted) break;
      await sleep(250);
    }
    if (pages.length === 0) {
      return {
        ok: false,
        error: PROBE_OUTCOMES.noRendererPage,
        elapsedMs: Date.now() - startedAt,
        pageCount,
      };
    }
    const socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    socket = socketFactory(pages[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        const error = new Error(PROBE_OUTCOMES.enableTimeout);
        error.outcome = PROBE_OUTCOMES.enableTimeout;
        reject(error);
      };
      if (controller.signal.aborted) onAbort();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("error", () => {
        const error = new Error(PROBE_OUTCOMES.socketError);
        error.outcome = PROBE_OUTCOMES.socketError;
        reject(error);
      });
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      });
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data));
        if (payload.id !== 1) return;
        if (payload.error) {
          const error = new Error(PROBE_OUTCOMES.enableError);
          error.outcome = PROBE_OUTCOMES.enableError;
          reject(error);
          return;
        }
        resolve({ ok: true });
      });
    });
    return { ok: true, elapsedMs: Date.now() - startedAt, pageCount: pages.length };
  } catch (error) {
    const classified = classifyProbeFailure(error);
    if (classified === PROBE_OUTCOMES.aborted && pageCount === 0 && !socket) {
      return {
        ok: false,
        error: PROBE_OUTCOMES.noRendererPage,
        elapsedMs: Date.now() - startedAt,
        pageCount: 0,
      };
    }
    return {
      ok: false,
      error: classified,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  }
}

async function main(argv) {
  const result = await probeIsolatedRuntimeEnable({ arguments: argv });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) {
    process.stderr.write(
      "usage: node tools/dev-desktop/isolated-runtime-enable.mjs http://127.0.0.1:PORT --app-path <abs> --user-data <abs> [--timeout-ms 8000]\n",
    );
    process.exit(2);
  }
  await main(argv);
}
