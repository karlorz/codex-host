#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RELAY_DEFAULT_LINK_LISTEN,
  RELAY_DEFAULT_LINK_PORT,
  RELAY_DEFAULT_MCP_LISTEN,
  RELAY_DEFAULT_MCP_PORT,
  RELAY_PUBLIC_ORIGIN,
} from "@codexhost/shared-contracts";

import { assertRelayBindAddresses, isLoopbackIPv4, publicRelayRequiresOauth } from "./listen.js";
import { hashPassword, isPasswordHashFormat } from "./oauth-password.js";
import { RelayOAuthStore } from "./oauth-store.js";
import { startEnrolledMcpRelay } from "./relay.js";

function option(argv: readonly string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1];
}

function positivePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = /^[0-9]+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${value} is not a TCP port`);
  }
  return port;
}

async function readMode600File(filePath: string, label: string): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
  const info = await stat(filePath);
  if ((info.mode & 0o777) !== 0o600 && process.platform !== "win32") {
    throw new Error(`${label} must be mode 600`);
  }
  return (await readFile(filePath, "utf8")).trim();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function requireAbsoluteStateDir(argv: readonly string[]): string {
  const dir = option(argv, "--oauth-state-dir");
  if (!dir || !path.isAbsolute(dir)) {
    throw new Error("--oauth-state-dir must be an absolute path");
  }
  return dir;
}

export async function runEnrolledMcpRelayCli(argv: readonly string[]): Promise<void> {
  if (argv[0] === "hash-password") {
    const password = await readStdin();
    if (!password) throw new Error("password is required on stdin");
    process.stdout.write(`${hashPassword(password)}\n`);
    return;
  }

  if (argv[0] === "list-clients") {
    const store = new RelayOAuthStore(requireAbsoluteStateDir(argv));
    process.stdout.write(`${JSON.stringify({ clients: store.listClients() })}\n`);
    return;
  }

  if (argv[0] === "revoke-client") {
    const store = new RelayOAuthStore(requireAbsoluteStateDir(argv));
    const all = argv.includes("--all");
    const clientId = option(argv, "--client-id");
    if (all === Boolean(clientId)) {
      throw new Error("revoke-client requires exactly one of --client-id or --all");
    }
    const revoked = all
      ? store
          .listClients()
          .flatMap((client) => (store.revokeClient(client.clientId) ? [client.clientId] : []))
      : clientId && store.revokeClient(clientId)
        ? [clientId]
        : [];
    if (revoked.length === 0) {
      throw new Error(
        all ? "no OAuth clients to revoke" : `OAuth client ${clientId} is not in the store`,
      );
    }
    process.stdout.write(`${JSON.stringify({ revoked })}\n`);
    return;
  }

  const sharedListen = option(argv, "--listen");
  if (sharedListen && (option(argv, "--mcp-listen") || option(argv, "--link-listen"))) {
    throw new Error("--listen cannot be combined with --mcp-listen or --link-listen");
  }
  if (sharedListen && !isLoopbackIPv4(sharedListen)) {
    throw new Error(
      "--listen is loopback-only; use --mcp-listen 127.0.0.1 and --link-listen <tailnet-ipv4>",
    );
  }
  const mcpListen =
    option(argv, "--mcp-listen", sharedListen ?? RELAY_DEFAULT_MCP_LISTEN) ??
    RELAY_DEFAULT_MCP_LISTEN;
  const linkListen =
    option(argv, "--link-listen", sharedListen ?? RELAY_DEFAULT_LINK_LISTEN) ??
    RELAY_DEFAULT_LINK_LISTEN;
  assertRelayBindAddresses(mcpListen, linkListen);

  const expectedNodeId = option(argv, "--node-id");
  const hashFile = option(argv, "--link-secret-hash-file");
  if (!expectedNodeId) throw new Error("--node-id is required");
  if (!hashFile) throw new Error("--link-secret-hash-file is required");
  const linkSecretHash = (await readMode600File(hashFile, "link secret hash file")).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(linkSecretHash)) {
    throw new Error("link secret hash file must contain a SHA-256 hex digest");
  }

  const publicOrigin = option(argv, "--public-origin");
  const passwordHashFile = option(argv, "--password-hash-file");
  const oauthStateDir = option(argv, "--oauth-state-dir");
  const needsOauth = publicRelayRequiresOauth(linkListen) || Boolean(publicOrigin);
  if (needsOauth) {
    if (!publicOrigin)
      throw new Error("--public-origin is required when the link listener is not loopback");
    if (!passwordHashFile) throw new Error("--password-hash-file is required for OAuth");
    if (!oauthStateDir || !path.isAbsolute(oauthStateDir)) {
      throw new Error("--oauth-state-dir must be an absolute path");
    }
  }

  let oauth: { issuer: string; passwordHash: string; store: RelayOAuthStore } | undefined;
  if (passwordHashFile) {
    const passwordHash = await readMode600File(passwordHashFile, "password hash file");
    if (!isPasswordHashFormat(passwordHash)) {
      throw new Error("password hash file must contain an scrypt hash");
    }
    if (!oauthStateDir || !path.isAbsolute(oauthStateDir)) {
      throw new Error("--oauth-state-dir must be an absolute path");
    }
    oauth = {
      issuer: (publicOrigin ?? RELAY_PUBLIC_ORIGIN).replace(/\/+$/u, ""),
      passwordHash,
      store: new RelayOAuthStore(oauthStateDir),
    };
  }

  const relay = await startEnrolledMcpRelay({
    mcpListen,
    linkListen,
    linkPort: positivePort(option(argv, "--link-port"), RELAY_DEFAULT_LINK_PORT),
    mcpPort: positivePort(option(argv, "--mcp-port"), RELAY_DEFAULT_MCP_PORT),
    expectedNodeId,
    linkSecretHash,
    ...(oauth ? { oauth } : {}),
  });
  const stop = () => {
    void relay.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(
    `${JSON.stringify({
      mcpListen: relay.mcpListen,
      linkListen: relay.linkListen,
      linkPort: relay.linkPort,
      mcpPort: relay.mcpPort,
      mcpOrigin: relay.mcpOrigin,
      issuer: relay.issuer,
      pid: process.pid,
    })}\n`,
  );
}

function isDirectCliInvocation(argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(path.resolve(argv1)).href === import.meta.url;
  }
}

if (isDirectCliInvocation(process.argv[1])) {
  runEnrolledMcpRelayCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: { code: "INVALID_ARGUMENT", message } })}\n`);
    process.exitCode = 1;
  });
}
