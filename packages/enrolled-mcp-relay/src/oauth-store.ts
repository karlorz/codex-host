import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OAuthClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
}

export interface OAuthAuthCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
}

export interface OAuthAccessToken {
  tokenHash: string;
  clientId: string;
  resource: string;
  expiresAt: number;
  scope?: string;
  revoked?: boolean;
}

export interface OAuthRefreshToken {
  tokenHash: string;
  clientId: string;
  resource: string;
  expiresAt: number;
  scope?: string;
}

export interface OAuthClientPublicView {
  clientId: string;
  clientName?: string;
  accessTokenCount: number;
  revokedAccessTokenCount: number;
  refreshTokenCount: number;
}

interface PersistedState {
  clients: Record<string, OAuthClient>;
  authCodes: Record<string, OAuthAuthCode>;
  accessTokens: Record<string, OAuthAccessToken>;
  refreshTokens: Record<string, OAuthRefreshToken>;
}

function emptyState(): PersistedState {
  return { clients: {}, authCodes: {}, accessTokens: {}, refreshTokens: {} };
}

function omitRecord<V>(record: Record<string, V>, key: string): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) next[entryKey] = value;
  }
  return next;
}

function omitWhere<V>(record: Record<string, V>, drop: (value: V) => boolean): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [entryKey, value] of Object.entries(record)) {
    if (!drop(value)) next[entryKey] = value;
  }
  return next;
}

export class RelayOAuthStore {
  private readonly filePath: string | undefined;
  private state: PersistedState;

  constructor(stateDir?: string) {
    if (!stateDir) {
      this.filePath = undefined;
      this.state = emptyState();
      return;
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.filePath = join(stateDir, "oauth-store.json");
    this.state = this.load();
  }

  saveClient(client: OAuthClient): void {
    this.commit(() => {
      this.state.clients[client.clientId] = { ...client };
    });
  }

  getClient(clientId: string): OAuthClient | undefined {
    const client = this.state.clients[clientId];
    return client ? { ...client } : undefined;
  }

  saveAuthCode(code: OAuthAuthCode): void {
    this.commit(() => {
      this.state.authCodes[code.codeHash] = { ...code };
    });
  }

  consumeAuthCode(codeHash: string): OAuthAuthCode | undefined {
    const entry = this.state.authCodes[codeHash];
    if (!entry) return undefined;
    this.commit(() => {
      this.state.authCodes = omitRecord(this.state.authCodes, codeHash);
    });
    if (Date.now() > entry.expiresAt) return undefined;
    return entry;
  }

  saveAccessToken(token: OAuthAccessToken): void {
    this.commit(() => {
      this.state.accessTokens[token.tokenHash] = { ...token };
    });
  }

  getAccessToken(tokenHash: string): OAuthAccessToken | undefined {
    const entry = this.state.accessTokens[tokenHash];
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.commit(() => {
        this.state.accessTokens = omitRecord(this.state.accessTokens, tokenHash);
      });
      return undefined;
    }
    return { ...entry };
  }

  saveRefreshToken(token: OAuthRefreshToken): void {
    this.commit(() => {
      this.state.refreshTokens[token.tokenHash] = { ...token };
    });
  }

  consumeRefreshToken(tokenHash: string): OAuthRefreshToken | undefined {
    const entry = this.state.refreshTokens[tokenHash];
    if (!entry) return undefined;
    this.commit(() => {
      this.state.refreshTokens = omitRecord(this.state.refreshTokens, tokenHash);
    });
    if (Date.now() > entry.expiresAt) return undefined;
    return entry;
  }

  revokeToken(tokenHash: string): "access" | "refresh" | undefined {
    const access = this.state.accessTokens[tokenHash];
    if (access) {
      this.commit(() => {
        this.state.accessTokens[tokenHash] = { ...access, revoked: true };
      });
      return "access";
    }
    const refresh = this.state.refreshTokens[tokenHash];
    if (!refresh) return undefined;
    this.commit(() => {
      this.state.refreshTokens = omitRecord(this.state.refreshTokens, tokenHash);
      for (const [hash, access] of Object.entries(this.state.accessTokens)) {
        if (access.clientId === refresh.clientId) {
          this.state.accessTokens[hash] = { ...access, revoked: true };
        }
      }
    });
    return "refresh";
  }

  listClients(): OAuthClientPublicView[] {
    const ids = new Set<string>([
      ...Object.keys(this.state.clients),
      ...Object.values(this.state.accessTokens).map((token) => token.clientId),
      ...Object.values(this.state.refreshTokens).map((token) => token.clientId),
    ]);
    return [...ids].sort().map((clientId) => {
      const client = this.state.clients[clientId];
      const access = Object.values(this.state.accessTokens).filter(
        (token) => token.clientId === clientId,
      );
      const refresh = Object.values(this.state.refreshTokens).filter(
        (token) => token.clientId === clientId,
      );
      return {
        clientId,
        ...(client?.clientName ? { clientName: client.clientName } : {}),
        accessTokenCount: access.length,
        revokedAccessTokenCount: access.filter((token) => token.revoked).length,
        refreshTokenCount: refresh.length,
      };
    });
  }

  revokeClient(clientId: string): boolean {
    const existed =
      Boolean(this.state.clients[clientId]) ||
      Object.values(this.state.refreshTokens).some((token) => token.clientId === clientId) ||
      Object.values(this.state.authCodes).some((code) => code.clientId === clientId) ||
      Object.values(this.state.accessTokens).some(
        (token) => token.clientId === clientId && !token.revoked,
      );
    if (!existed) return false;
    this.commit(() => {
      this.state.clients = omitRecord(this.state.clients, clientId);
      this.state.authCodes = omitWhere(this.state.authCodes, (code) => code.clientId === clientId);
      this.state.refreshTokens = omitWhere(
        this.state.refreshTokens,
        (token) => token.clientId === clientId,
      );
      for (const [hash, token] of Object.entries(this.state.accessTokens)) {
        if (token.clientId === clientId) {
          this.state.accessTokens[hash] = { ...token, revoked: true };
        }
      }
    });
    return true;
  }

  private load(): PersistedState {
    if (!this.filePath || !existsSync(this.filePath)) return emptyState();
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedState;
    } catch {
      return emptyState();
    }
  }

  private commit(mutate: () => void): void {
    mutate();
    if (!this.filePath) return;
    writeFileSync(this.filePath, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows may ignore mode.
    }
  }
}
