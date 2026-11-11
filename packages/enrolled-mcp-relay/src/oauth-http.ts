import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sha256Hex } from "./secret.js";
import { consentHtml } from "./oauth-consent.js";
import { verifyPassword } from "./oauth-password.js";
import type { OAuthClient, RelayOAuthStore } from "./oauth-store.js";

export const OAUTH_ACCESS_TTL_SEC = 3600;
const AUTH_CODE_TTL_MS = 5 * 60_000;
const REFRESH_TTL_MS = 30 * 86_400_000;

export interface RelayOAuth {
  issuer: string;
  resource: string;
  passwordHash: string;
  store: RelayOAuthStore;
}

export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource`;
}

export function unauthorizedAuthenticate(issuer: string, revoked: boolean): string {
  if (revoked) return `Bearer realm="mcp", error="invalid_token"`;
  return `Bearer realm="mcp", error="invalid_token", resource_metadata="${resourceMetadataUrl(issuer)}"`;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/u.exec(header.trim());
  return match?.[1];
}

export type McpBearer = { ok: true } | { ok: false; revoked: boolean };

export function inspectMcpBearer(header: string | undefined, oauth: RelayOAuth): McpBearer {
  const token = bearerToken(header);
  if (!token) return { ok: false, revoked: false };
  const entry = oauth.store.getAccessToken(sha256Hex(token));
  if (!entry) return { ok: false, revoked: false };
  if (entry.revoked) return { ok: false, revoked: true };
  if (entry.resource !== oauth.resource) return { ok: false, revoked: false };
  return { ok: true };
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    ...extra,
  });
  response.end(payload);
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function parseParams(
  method: string | undefined,
  contentType: string,
  rawBody: string,
  search: URLSearchParams,
): Record<string, string> {
  if (method === "GET" || method === "HEAD") {
    return Object.fromEntries(search.entries());
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody).entries());
  }
  if (contentType.includes("application/json") && rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") params[key] = value;
      }
      return params;
    } catch {
      return {};
    }
  }
  return {};
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return computed === challenge;
}

function isAllowedRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function issueTokens(oauth: RelayOAuth, clientId: string, resource: string, scope: string) {
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  oauth.store.saveAccessToken({
    tokenHash: sha256Hex(access),
    clientId,
    resource,
    expiresAt: Date.now() + OAUTH_ACCESS_TTL_SEC * 1000,
    scope,
  });
  oauth.store.saveRefreshToken({
    tokenHash: sha256Hex(refresh),
    clientId,
    resource,
    expiresAt: Date.now() + REFRESH_TTL_MS,
    scope,
  });
  return {
    access_token: access,
    token_type: "Bearer" as const,
    expires_in: OAUTH_ACCESS_TTL_SEC,
    refresh_token: refresh,
    scope,
  };
}

function metadataDocuments(oauth: RelayOAuth) {
  return {
    resource: {
      resource: oauth.resource,
      authorization_servers: [oauth.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp", "offline_access"],
    },
    authorizationServer: {
      issuer: oauth.issuer,
      authorization_endpoint: `${oauth.issuer}/authorize`,
      token_endpoint: `${oauth.issuer}/token`,
      registration_endpoint: `${oauth.issuer}/register`,
      revocation_endpoint: `${oauth.issuer}/revoke`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      scopes_supported: ["mcp", "offline_access"],
      token_endpoint_auth_methods_supported: ["none"],
    },
  };
}

export function isOAuthPath(method: string, path: string): boolean {
  if (
    (method === "GET" || method === "HEAD") &&
    (path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp" ||
      path === "/.well-known/oauth-authorization-server")
  ) {
    return true;
  }
  if (method === "POST" && (path === "/register" || path === "/token" || path === "/revoke")) {
    return true;
  }
  if ((method === "GET" || method === "POST") && path === "/authorize") return true;
  return false;
}

export function handleOAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  rawBody: string,
  oauth: RelayOAuth,
): boolean {
  const url = new URL(request.url ?? "/", oauth.issuer);
  const path = url.pathname;
  const method = request.method ?? "GET";
  if (!isOAuthPath(method, path)) return false;

  const docs = metadataDocuments(oauth);
  if (method === "GET" || method === "HEAD") {
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp"
    ) {
      json(response, 200, docs.resource);
      return true;
    }
    if (path === "/.well-known/oauth-authorization-server") {
      json(response, 200, docs.authorizationServer);
      return true;
    }
  }

  if (method === "POST" && path === "/register") {
    let clientName: string | undefined;
    let redirectUris: string[] = [];
    try {
      const parsed = rawBody.trim() ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      if (typeof parsed.client_name === "string") clientName = parsed.client_name.slice(0, 256);
      if (Array.isArray(parsed.redirect_uris)) {
        redirectUris = parsed.redirect_uris.filter(
          (value): value is string => typeof value === "string",
        );
      }
    } catch {
      json(response, 400, { error: "invalid_request", error_description: "Malformed JSON" });
      return true;
    }
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 16 ||
      !redirectUris.every(isAllowedRedirect)
    ) {
      json(response, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https or loopback http",
      });
      return true;
    }
    const clientId = randomBytes(16).toString("hex");
    const client: OAuthClient = clientName
      ? { clientId, clientName, redirectUris }
      : { clientId, redirectUris };
    oauth.store.saveClient(client);
    json(response, 201, {
      client_id: clientId,
      client_name: clientName ?? null,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    });
    return true;
  }

  if ((method === "GET" || method === "POST") && path === "/authorize") {
    const params = parseParams(
      method,
      request.headers["content-type"] ?? "",
      rawBody,
      url.searchParams,
    );
    const client = params.client_id ? oauth.store.getClient(params.client_id) : undefined;
    if (client?.clientName) params.client_name = client.clientName;
    const wantsHtml =
      method === "GET" ||
      (request.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
    if (!params.client_id || !params.code_challenge || params.response_type !== "code") {
      json(response, 400, {
        error: "invalid_request",
        error_description: "Missing required authorize parameters",
      });
      return true;
    }
    if ((params.code_challenge_method || "S256") !== "S256") {
      json(response, 400, { error: "invalid_request", error_description: "PKCE S256 is required" });
      return true;
    }
    if (params.resource && params.resource !== oauth.resource) {
      json(response, 400, {
        error: "invalid_target",
        error_description: "resource is not this relay",
      });
      return true;
    }
    if (!client) {
      json(response, 400, { error: "invalid_client", error_description: "Unknown client_id" });
      return true;
    }
    if (params.redirect_uri && !client.redirectUris.includes(params.redirect_uri)) {
      json(response, 400, {
        error: "invalid_request",
        error_description: "redirect_uri is not registered",
      });
      return true;
    }
    if (method === "GET") {
      html(response, 200, consentHtml(params));
      return true;
    }
    if (!params.password || !verifyPassword(params.password, oauth.passwordHash)) {
      if (wantsHtml) {
        html(response, 401, consentHtml(params, "Invalid operator password"));
        return true;
      }
      json(response, 401, {
        error: "access_denied",
        error_description: "Invalid operator password",
      });
      return true;
    }
    const code = randomBytes(24).toString("base64url");
    oauth.store.saveAuthCode({
      codeHash: sha256Hex(code),
      clientId: params.client_id,
      redirectUri: params.redirect_uri ?? "",
      codeChallenge: params.code_challenge,
      resource: oauth.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    if (params.redirect_uri) {
      const redirect = new URL(params.redirect_uri);
      redirect.searchParams.set("code", code);
      if (params.state) redirect.searchParams.set("state", params.state);
      response.writeHead(302, { location: redirect.toString() });
      response.end();
      return true;
    }
    json(response, 200, { code, state: params.state });
    return true;
  }

  if (method === "POST" && path === "/token") {
    const params = parseParams(
      method,
      request.headers["content-type"] ?? "",
      rawBody,
      url.searchParams,
    );
    if (params.resource && params.resource !== oauth.resource) {
      json(response, 400, {
        error: "invalid_target",
        error_description: "resource is not this relay",
      });
      return true;
    }
    if (params.grant_type === "authorization_code") {
      if (!params.code || !params.code_verifier) {
        json(response, 400, {
          error: "invalid_request",
          error_description: "Missing code or code_verifier",
        });
        return true;
      }
      const authCode = oauth.store.consumeAuthCode(sha256Hex(params.code));
      if (!authCode) {
        json(response, 400, {
          error: "invalid_grant",
          error_description: "Invalid or expired authorization code",
        });
        return true;
      }
      if (!verifyPkce(params.code_verifier, authCode.codeChallenge)) {
        json(response, 400, {
          error: "invalid_grant",
          error_description: "Code verifier does not match challenge",
        });
        return true;
      }
      if (authCode.redirectUri !== (params.redirect_uri ?? "")) {
        json(response, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return true;
      }
      json(
        response,
        200,
        issueTokens(oauth, authCode.clientId, authCode.resource, "mcp offline_access"),
      );
      return true;
    }
    if (params.grant_type === "refresh_token") {
      if (!params.refresh_token) {
        json(response, 400, {
          error: "invalid_request",
          error_description: "Missing refresh_token",
        });
        return true;
      }
      const existing = oauth.store.consumeRefreshToken(sha256Hex(params.refresh_token));
      if (!existing) {
        json(response, 400, {
          error: "invalid_grant",
          error_description: "Invalid or expired refresh token",
        });
        return true;
      }
      json(
        response,
        200,
        issueTokens(
          oauth,
          existing.clientId,
          existing.resource,
          existing.scope ?? "mcp offline_access",
        ),
      );
      return true;
    }
    json(response, 400, { error: "unsupported_grant_type" });
    return true;
  }

  if (method === "POST" && path === "/revoke") {
    const params = parseParams(
      method,
      request.headers["content-type"] ?? "",
      rawBody,
      url.searchParams,
    );
    if (params.token) oauth.store.revokeToken(sha256Hex(params.token));
    response.writeHead(200);
    response.end();
    return true;
  }

  return false;
}
