import { createHash, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { RELAY_MCP_TOOL_NAMES } from "@codexhost/shared-contracts";

import { hashPassword } from "../src/oauth-password.js";
import { RelayOAuthStore } from "../src/oauth-store.js";
import { sha256Hex } from "../src/secret.js";
import { startEnrolledMcpRelay } from "../src/relay.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const PASSWORD = "operator-password";
const passwordHash = hashPassword(PASSWORD);
const SECRET = "test-link-secret";
const NODE_ID = "nTestStable";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
  };
}

async function startOauthRelay(store = new RelayOAuthStore()) {
  const relay = await startEnrolledMcpRelay({
    listen: "127.0.0.1",
    linkPort: 0,
    mcpPort: 0,
    expectedNodeId: NODE_ID,
    linkSecretHash: sha256Hex(SECRET),
    whois: async () => NODE_ID,
    oauth: { passwordHash, store },
  });
  cleanup.push(() => relay.close());
  return { relay, store };
}

async function issueAccessClient(
  origin: string,
  resource = `${origin}/mcp`,
): Promise<{ access: string; clientId: string }> {
  const pair = pkce();
  const registered = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "muse-test",
      redirect_uris: ["http://127.0.0.1/cb"],
    }),
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  const authorize = await fetch(`${origin}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1/cb",
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
      response_type: "code",
      resource,
      password: PASSWORD,
    }),
  });
  expect(authorize.status).toBe(302);
  const location = authorize.headers.get("location");
  expect(location).toBeTruthy();
  const code = new URL(location ?? "").searchParams.get("code");
  expect(code).toBeTruthy();
  const token = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: pair.verifier,
      redirect_uri: "http://127.0.0.1/cb",
      resource,
    }),
  });
  expect(token.status).toBe(200);
  const issued = (await token.json()) as { access_token: string };
  return { access: issued.access_token, clientId: client.client_id };
}

async function issueAccessToken(origin: string, resource = `${origin}/mcp`): Promise<string> {
  return (await issueAccessClient(origin, resource)).access;
}

describe("enrolled MCP relay OAuth", () => {
  it("returns 401 with resource_metadata until a resource-bound token is presented", async () => {
    const { relay } = await startOauthRelay();
    const origin = relay.mcpOrigin;
    const unauth = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauth.status).toBe(401);
    const authenticate = unauth.headers.get("www-authenticate") ?? "";
    expect(authenticate).toContain("resource_metadata=");
    expect(authenticate).toContain(`${origin}/.well-known/oauth-protected-resource`);

    const resourceMeta = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    const asMeta = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(resourceMeta.status).toBe(200);
    expect(asMeta.status).toBe(200);
    expect(await resourceMeta.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
    expect(await asMeta.json()).toMatchObject({
      issuer: origin,
      code_challenge_methods_supported: ["S256"],
    });

    const foreign = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer skillwiki-or-grok-search-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(foreign.status).toBe(401);
    expect(foreign.headers.get("www-authenticate") ?? "").toContain("resource_metadata=");

    const access = await issueAccessToken(origin);
    const listed = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([...RELAY_MCP_TOOL_NAMES]);
  });

  it("rejects a SkillWiki resource and returns 401 without resource_metadata after revoke", async () => {
    const { relay } = await startOauthRelay();
    const origin = relay.mcpOrigin;
    const authorize = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "missing",
        code_challenge: "abc",
        response_type: "code",
        resource: "https://wiki.karldigi.dev/mcp",
        password: PASSWORD,
      }),
    });
    expect(authorize.status).toBe(400);
    expect(await authorize.json()).toMatchObject({ error: "invalid_target" });

    const access = await issueAccessToken(origin);
    const revoked = await fetch(`${origin}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access }),
    });
    expect(revoked.status).toBe(200);
    const again = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(again.status).toBe(401);
    expect(again.headers.get("www-authenticate") ?? "").not.toContain("resource_metadata=");
  });

  it("operator revokeClient marks the access token revoked", async () => {
    const { relay, store } = await startOauthRelay();
    const origin = relay.mcpOrigin;
    const { access, clientId } = await issueAccessClient(origin);
    expect(store.listClients()).toEqual([
      expect.objectContaining({
        clientId,
        clientName: "muse-test",
        accessTokenCount: 1,
        revokedAccessTokenCount: 0,
        refreshTokenCount: 1,
      }),
    ]);
    expect(store.revokeClient(clientId)).toBe(true);
    expect(store.revokeClient(clientId)).toBe(false);
    expect(store.listClients()).toEqual([
      expect.objectContaining({
        clientId,
        accessTokenCount: 1,
        revokedAccessTokenCount: 1,
        refreshTokenCount: 0,
      }),
    ]);
    const again = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(again.status).toBe(401);
    expect(again.headers.get("www-authenticate") ?? "").not.toContain("resource_metadata=");
  });
});
