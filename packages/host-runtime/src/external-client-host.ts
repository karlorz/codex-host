import {
  EXTERNAL_CLIENT_CREATE_METHOD,
  EXTERNAL_CLIENT_LIST_METHOD,
  EXTERNAL_CLIENT_REVOKE_METHOD,
  EXTERNAL_CLIENT_UPDATE_METHOD,
  RELAY_PUBLIC_RESOURCE,
  externalClientCreateParamsSchema,
  externalClientCreateResultSchema,
  externalClientListParamsSchema,
  externalClientListResultSchema,
  externalClientRevokeParamsSchema,
  externalClientRevokeResultSchema,
  externalClientUpdateParamsSchema,
  externalClientPublicViewSchema,
  isProtectedDirectMcpUrl,
} from "@codexhost/shared-contracts";

import { DelegationControlError } from "./delegation-types.js";
import { DEFAULT_EXTERNAL_CLIENT_PORT, externalClientPort } from "./external-client-server.js";
import {
  DIRECT_MCP_URL_ENV,
  ExternalClientRegistry,
  defaultExternalClientsPath,
  publicViewOf,
  type ExternalClientRecord,
} from "./external-clients.js";

export function isExternalClientHostMethod(method: string): boolean {
  return (
    method === EXTERNAL_CLIENT_LIST_METHOD ||
    method === EXTERNAL_CLIENT_CREATE_METHOD ||
    method === EXTERNAL_CLIENT_UPDATE_METHOD ||
    method === EXTERNAL_CLIENT_REVOKE_METHOD
  );
}

function mcpExtras(
  record: ExternalClientRecord,
  environment: NodeJS.ProcessEnv,
): { mcpUrl?: string; mcpUrlNote?: string } {
  if (record.connectionMode === "public-relay") return { mcpUrl: RELAY_PUBLIC_RESOURCE };
  if (record.connectionMode === "local") {
    const port = externalClientPort(environment) ?? DEFAULT_EXTERNAL_CLIENT_PORT;
    return { mcpUrl: `http://127.0.0.1:${port}/mcp` };
  }
  const configured = record.directUrl ?? environment[DIRECT_MCP_URL_ENV]?.trim();
  if (configured && isProtectedDirectMcpUrl(configured)) return { mcpUrl: configured };
  return {
    mcpUrlNote:
      "Direct uses a network path that already reaches this Mac. Set an https://…/mcp URL or a Tailscale 100.x HTTP /mcp URL. Host does not open a new public listener.",
  };
}

function view(record: ExternalClientRecord, environment: NodeJS.ProcessEnv) {
  return externalClientPublicViewSchema.parse(publicViewOf(record, mcpExtras(record, environment)));
}

export async function handleExternalClientHostRequest(input: {
  environment: NodeJS.ProcessEnv;
  method: string;
  params: unknown;
  registry?: ExternalClientRegistry;
}): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
  const registry =
    input.registry ?? new ExternalClientRegistry(defaultExternalClientsPath(input.environment));
  try {
    if (input.method === EXTERNAL_CLIENT_LIST_METHOD) {
      const parsed = externalClientListParamsSchema.safeParse(input.params ?? {});
      if (!parsed.success) {
        return { error: { code: -32602, message: "Invalid external client list request" } };
      }
      const records = await registry.listRecords();
      return {
        result: externalClientListResultSchema.parse({
          clients: records.map((record) => view(record, input.environment)),
        }),
      };
    }
    if (input.method === EXTERNAL_CLIENT_CREATE_METHOD) {
      const parsed = externalClientCreateParamsSchema.safeParse(input.params ?? {});
      if (!parsed.success) {
        return { error: { code: -32602, message: "Invalid external client create request" } };
      }
      const created = await registry.create(parsed.data.name, {
        access: parsed.data.access ?? "all-threads",
        connectionMode: parsed.data.connectionMode ?? "public-relay",
        ...(parsed.data.workspaces ? { workspaces: parsed.data.workspaces } : {}),
        ...(parsed.data.dispatchGrant ? { dispatchGrant: parsed.data.dispatchGrant } : {}),
        ...(parsed.data.oauthClientId ? { oauthClientId: parsed.data.oauthClientId } : {}),
        ...(parsed.data.directUrl ? { directUrl: parsed.data.directUrl } : {}),
      });
      return {
        result: externalClientCreateResultSchema.parse({
          ...view(created.record, input.environment),
          token: created.token,
        }),
      };
    }
    if (input.method === EXTERNAL_CLIENT_UPDATE_METHOD) {
      const parsed = externalClientUpdateParamsSchema.safeParse(input.params ?? {});
      if (!parsed.success) {
        return { error: { code: -32602, message: "Invalid external client update request" } };
      }
      const record = await registry.update(parsed.data.name, {
        ...(parsed.data.access ? { access: parsed.data.access } : {}),
        ...(parsed.data.workspaces ? { workspaces: parsed.data.workspaces } : {}),
        ...(parsed.data.connectionMode ? { connectionMode: parsed.data.connectionMode } : {}),
        ...(parsed.data.dispatchGrant ? { dispatchGrant: parsed.data.dispatchGrant } : {}),
        ...(parsed.data.clearOauthClientId
          ? { oauthClientId: null }
          : parsed.data.oauthClientId
            ? { oauthClientId: parsed.data.oauthClientId }
            : {}),
        ...(parsed.data.directUrl !== undefined
          ? { directUrl: parsed.data.directUrl || null }
          : {}),
      });
      return { result: view(record, input.environment) };
    }
    const parsed = externalClientRevokeParamsSchema.safeParse(input.params ?? {});
    if (!parsed.success) {
      return { error: { code: -32602, message: "Invalid external client revoke request" } };
    }
    await registry.remove(parsed.data.name);
    return {
      result: externalClientRevokeResultSchema.parse({ name: parsed.data.name, revoked: true }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "External client request failed";
    const code =
      error instanceof DelegationControlError && error.code === "UNAUTHORIZED_TARGET"
        ? -32000
        : -32000;
    return { error: { code, message } };
  }
}
