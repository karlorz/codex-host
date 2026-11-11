import {
  RELAY_DEFAULT_LINK_LISTEN,
  RELAY_DEFAULT_LINK_PORT,
  RELAY_DEFAULT_MCP_LISTEN,
  RELAY_DEFAULT_MCP_PORT,
} from "@codexhost/shared-contracts";

import { assertRelayBindAddresses, publicRelayRequiresOauth } from "./listen.js";
import { listenEnrolledLink, type LinkListener } from "./link-server.js";
import { listenEnrolledMcp } from "./mcp-http.js";
import type { RelayOAuth } from "./oauth-http.js";
import { createTailscaleWhois, type WhoisFn } from "./whois.js";

export interface EnrolledMcpRelay {
  mcpListen: string;
  linkListen: string;
  linkPort: number;
  mcpPort: number;
  mcpOrigin: string;
  issuer?: string;
  close(): Promise<void>;
}

function issuerFor(mcpListen: string, mcpPort: number, configured?: string): string {
  return (configured ?? `http://${mcpListen}:${mcpPort}`).replace(/\/+$/u, "");
}

export async function startEnrolledMcpRelay(input: {
  listen?: string;
  mcpListen?: string;
  linkListen?: string;
  linkPort?: number;
  mcpPort?: number;
  expectedNodeId: string;
  linkSecretHash: string;
  whois?: WhoisFn;
  oauth?: Omit<RelayOAuth, "issuer" | "resource"> & { issuer?: string };
}): Promise<EnrolledMcpRelay> {
  const mcpListen = input.mcpListen ?? input.listen ?? RELAY_DEFAULT_MCP_LISTEN;
  const linkListen = input.linkListen ?? input.listen ?? RELAY_DEFAULT_LINK_LISTEN;
  assertRelayBindAddresses(mcpListen, linkListen);
  if (publicRelayRequiresOauth(linkListen) && !input.oauth) {
    throw new Error("OAuth is required when the link listener is not loopback");
  }

  const mcpPort = input.mcpPort ?? RELAY_DEFAULT_MCP_PORT;
  const oauthRef: { current?: RelayOAuth } = {};
  const bindOauth = (port: number) => {
    if (!input.oauth) return;
    const issuer = issuerFor(mcpListen, port, input.oauth.issuer);
    oauthRef.current = {
      issuer,
      resource: `${issuer}/mcp`,
      passwordHash: input.oauth.passwordHash,
      store: input.oauth.store,
    };
  };
  if (mcpPort !== 0) bindOauth(mcpPort);

  const links: LinkListener = await listenEnrolledLink({
    listen: linkListen,
    port: input.linkPort ?? RELAY_DEFAULT_LINK_PORT,
    expectedNodeId: input.expectedNodeId,
    linkSecretHash: input.linkSecretHash,
    whois: input.whois ?? createTailscaleWhois(),
  });
  const mcp = await listenEnrolledMcp({
    listen: mcpListen,
    port: mcpPort,
    links,
    ...(input.oauth ? { oauthRef } : {}),
  });
  bindOauth(mcp.port);
  return {
    mcpListen,
    linkListen,
    linkPort: links.port,
    mcpPort: mcp.port,
    mcpOrigin: `http://${mcpListen}:${mcp.port}`,
    ...(oauthRef.current ? { issuer: oauthRef.current.issuer } : {}),
    close: async () => {
      await mcp.close();
      await links.close();
    },
  };
}
