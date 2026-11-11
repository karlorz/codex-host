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

interface PersistedState {
  clients: Record<string, OAuthClient>;
  authCodes: Record<string, OAuthAuthCode>;
  accessTokens: Record<string, OAuthAccessToken>;
  refreshTokens: Record<string, OAuthRefreshToken>;
}

function emptyState(): PersistedState {
  return { clients: {}, authCodes: {}, accessTokens: {}, refreshTokens: {} };
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
      delete this.state.authCodes[codeHash];
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
        delete this.state.accessTokens[tokenHash];
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
      delete this.state.refreshTokens[tokenHash];
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
      delete this.state.refreshTokens[tokenHash];
      for (const [hash, access] of Object.entries(this.state.accessTokens)) {
        if (access.clientId === refresh.clientId) {
          this.state.accessTokens[hash] = { ...access, revoked: true };
        }
      }
    });
    return "refresh";
  }

  revokeClient(clientId: string): void {
    this.commit(() => {
      delete this.state.clients[clientId];
      for (const [hash, code] of Object.entries(this.state.authCodes)) {
        if (code.clientId === clientId) delete this.state.authCodes[hash];
      }
      for (const [hash, token] of Object.entries(this.state.accessTokens)) {
        if (token.clientId === clientId) {
          this.state.accessTokens[hash] = { ...token, revoked: true };
        }
      }
      for (const [hash, token] of Object.entries(this.state.refreshTokens)) {
        if (token.clientId === clientId) delete this.state.refreshTokens[hash];
      }
    });
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
