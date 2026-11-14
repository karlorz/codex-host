import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXTERNAL_CLIENT_CREATE_METHOD,
  EXTERNAL_CLIENT_LIST_METHOD,
  EXTERNAL_CLIENT_REVOKE_METHOD,
  EXTERNAL_CLIENT_UPDATE_METHOD,
  RELAY_PUBLIC_RESOURCE,
} from "@codexhost/shared-contracts";

import { handleExternalClientHostRequest } from "../src/external-client-host.js";
import {
  ExternalClientRegistry,
  assertFullDispatchClient,
  defaultExternalClientsPath,
} from "../src/external-clients.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("external client Host console methods", () => {
  it("lists, creates and revokes token-free operator views and migrates v1 records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ext-host-"));
    cleanup.push(directory);
    const environment = { CODEXHOST_DATA_DIR: directory };
    await mkdir(directory, { recursive: true });
    await writeFile(
      defaultExternalClientsPath(environment),
      `${JSON.stringify({
        formatVersion: 1,
        clients: [
          {
            name: "grok-bot",
            createdAt: "2026-11-14T00:00:00.000Z",
            salt: "ab",
            tokenHash: "cd",
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const listed = await handleExternalClientHostRequest({
      environment,
      method: EXTERNAL_CLIENT_LIST_METHOD,
      params: {},
    });
    expect(listed).toMatchObject({
      result: {
        clients: [
          {
            name: "grok-bot",
            access: "all-threads",
            connectionMode: "local",
            dispatchGrant: "full-dispatch",
          },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toMatch(/"token"/u);
    const created = await handleExternalClientHostRequest({
      environment,
      method: EXTERNAL_CLIENT_CREATE_METHOD,
      params: { name: "muse" },
    });
    expect(created).toMatchObject({
      result: {
        name: "muse",
        connectionMode: "public-relay",
        dispatchGrant: "legacy-four",
        mcpUrl: RELAY_PUBLIC_RESOURCE,
      },
    });
    expect("token" in (created as { result: object }).result).toBe(true);
    const loopbackMuse = await handleExternalClientHostRequest({
      environment,
      method: EXTERNAL_CLIENT_UPDATE_METHOD,
      params: { name: "muse", connectionMode: "local" },
    });
    expect(loopbackMuse).toMatchObject({ error: { code: -32000 } });
    const revoked = await handleExternalClientHostRequest({
      environment,
      method: EXTERNAL_CLIENT_REVOKE_METHOD,
      params: { name: "grok-bot" },
    });
    expect(revoked).toEqual({ result: { name: "grok-bot", revoked: true } });
    const registry = new ExternalClientRegistry(defaultExternalClientsPath(environment));
    await expect(registry.has("grok-bot")).resolves.toBe(false);
    const stored = await readFile(defaultExternalClientsPath(environment), "utf8");
    expect(stored).not.toContain("chc_");
  });

  it("surfaces a Direct URL only when it is already protected and never falls back to the public relay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ext-host-direct-"));
    cleanup.push(directory);
    const environment = { CODEXHOST_DATA_DIR: directory };
    const lan = await handleExternalClientHostRequest({
      environment,
      method: EXTERNAL_CLIENT_CREATE_METHOD,
      params: {
        name: "lan-bot",
        connectionMode: "direct",
        directUrl: "http://192.168.1.8/mcp",
      },
    });
    expect(lan).toMatchObject({ error: { code: -32000 } });
    const created = await handleExternalClientHostRequest({
      environment,
      method: EXTERNAL_CLIENT_CREATE_METHOD,
      params: {
        name: "tailnet-bot",
        connectionMode: "direct",
        directUrl: "http://100.118.12.90/mcp",
      },
    });
    expect(created).toMatchObject({
      result: {
        name: "tailnet-bot",
        connectionMode: "direct",
        mcpUrl: "http://100.118.12.90/mcp",
      },
    });
    expect(JSON.stringify(created)).not.toContain("codexhost.karldigi.dev");
    const noted = await handleExternalClientHostRequest({
      environment,
      method: EXTERNAL_CLIENT_CREATE_METHOD,
      params: { name: "empty-direct", connectionMode: "direct" },
    });
    expect(noted).toMatchObject({
      result: {
        name: "empty-direct",
        connectionMode: "direct",
        mcpUrlNote: expect.stringContaining("does not open a new public listener"),
      },
    });
    expect((noted as { result: { mcpUrl?: string } }).result.mcpUrl).toBeUndefined();
  });

  it("rejects full dispatch when the OAuth client is bound to a different Host client", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ext-host-oauth-"));
    cleanup.push(directory);
    const registry = new ExternalClientRegistry(path.join(directory, "clients.json"));
    const created = await registry.create("grok-bot", {
      connectionMode: "public-relay",
      dispatchGrant: "full-dispatch",
      oauthClientId: "oauth-grok",
    });
    expect(assertFullDispatchClient(created.record, "oauth-grok").name).toBe("grok-bot");
    expect(() => assertFullDispatchClient(created.record, "oauth-other")).toThrow(
      /OAuth client does not match/,
    );
    const legacy = await registry.create("muse", { connectionMode: "public-relay" });
    expect(() => assertFullDispatchClient(legacy.record, undefined)).toThrow(
      /not approved for full Host dispatch/,
    );
  });
});
