import {
  EXTERNAL_CLIENT_CREATE_METHOD,
  EXTERNAL_CLIENT_LIST_METHOD,
  EXTERNAL_CLIENT_REVOKE_METHOD,
  EXTERNAL_CLIENT_UPDATE_METHOD,
  externalClientCreateParamsSchema,
  externalClientCreateResultSchema,
  externalClientListResultSchema,
  externalClientPublicViewSchema,
  externalClientRevokeParamsSchema,
  externalClientRevokeResultSchema,
  externalClientUpdateParamsSchema,
  type ExternalClientCreateParams,
  type ExternalClientCreateResult,
  type ExternalClientListResult,
  type ExternalClientRevokeResult,
  type ExternalClientUpdateParams,
  type ExternalClientPublicView,
} from "@codexhost/shared-contracts";

export interface RendererExternalClientsClient {
  listClients(): Promise<ExternalClientListResult>;
  createClient(input: ExternalClientCreateParams): Promise<ExternalClientCreateResult>;
  updateClient(input: ExternalClientUpdateParams): Promise<ExternalClientPublicView>;
  revokeClient(name: string): Promise<ExternalClientRevokeResult>;
}

export class RendererExternalClientsUnavailableError extends Error {
  constructor() {
    super("MCP clients are unavailable");
    this.name = "RendererExternalClientsUnavailableError";
  }
}

/** Fixed, typed methods only; callers never receive an arbitrary request bridge. */
export function createRendererExternalClientsClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): RendererExternalClientsClient {
  const request = async (method: string, params: unknown): Promise<unknown> => {
    try {
      return await send(method, params);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === -32601 || code === -32076) throw new RendererExternalClientsUnavailableError();
      throw error;
    }
  };
  return {
    async listClients() {
      return externalClientListResultSchema.parse(await request(EXTERNAL_CLIENT_LIST_METHOD, {}));
    },
    async createClient(input) {
      const params = externalClientCreateParamsSchema.parse(input);
      return externalClientCreateResultSchema.parse(
        await request(EXTERNAL_CLIENT_CREATE_METHOD, params),
      );
    },
    async updateClient(input) {
      const params = externalClientUpdateParamsSchema.parse(input);
      return externalClientPublicViewSchema.parse(
        await request(EXTERNAL_CLIENT_UPDATE_METHOD, params),
      );
    },
    async revokeClient(name) {
      const params = externalClientRevokeParamsSchema.parse({ name });
      return externalClientRevokeResultSchema.parse(
        await request(EXTERNAL_CLIENT_REVOKE_METHOD, params),
      );
    },
  };
}
