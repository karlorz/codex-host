import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runEnrolledMcpRelayCli } from "../src/cli.js";
import { RelayOAuthStore } from "../src/oauth-store.js";

async function cliJson(argv: readonly string[]): Promise<unknown> {
  const chunks: Buffer[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runEnrolledMcpRelayCli(argv);
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

describe("enrolled MCP relay operator OAuth CLI", () => {
  it("lists and revokes clients without starting the daemon", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codexhost-relay-oauth-"));
    const store = new RelayOAuthStore(stateDir);
    store.saveClient({
      clientId: "client-muse",
      clientName: "muse enrollment on karlmac-mini",
      redirectUris: ["https://muse.ai/cb"],
    });
    store.saveAccessToken({
      tokenHash: "aa".repeat(32),
      clientId: "client-muse",
      resource: "https://codexhost.karldigi.dev/mcp",
      expiresAt: Date.now() + 60_000,
    });

    await expect(cliJson(["list-clients", "--oauth-state-dir", stateDir])).resolves.toEqual({
      clients: [
        {
          clientId: "client-muse",
          clientName: "muse enrollment on karlmac-mini",
          accessTokenCount: 1,
          revokedAccessTokenCount: 0,
          refreshTokenCount: 0,
        },
      ],
    });

    await expect(
      cliJson(["revoke-client", "--oauth-state-dir", stateDir, "--client-id", "client-muse"]),
    ).resolves.toEqual({ revoked: ["client-muse"] });

    const after = new RelayOAuthStore(stateDir);
    expect(after.getClient("client-muse")).toBeUndefined();
    expect(after.getAccessToken("aa".repeat(32))?.revoked).toBe(true);

    await expect(
      runEnrolledMcpRelayCli([
        "revoke-client",
        "--oauth-state-dir",
        stateDir,
        "--client-id",
        "client-muse",
      ]),
    ).rejects.toThrow(/not in the store/);
  });

  it("revokes every client with --all", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codexhost-relay-oauth-"));
    const store = new RelayOAuthStore(stateDir);
    store.saveClient({ clientId: "a", redirectUris: ["http://127.0.0.1/cb"] });
    store.saveClient({ clientId: "b", redirectUris: ["http://127.0.0.1/cb"] });
    await expect(
      cliJson(["revoke-client", "--oauth-state-dir", stateDir, "--all"]),
    ).resolves.toEqual({ revoked: ["a", "b"] });
  });
});
