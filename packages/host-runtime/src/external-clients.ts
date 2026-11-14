import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EXTERNAL_CLIENT_NAME_PATTERN,
  isProtectedDirectMcpUrl,
  type ExternalClientAccess,
  type ExternalClientConnectionMode,
  type ExternalClientDispatchGrant,
  type ExternalClientPublicView,
} from "@codexhost/shared-contracts";

import { DelegationControlError } from "./delegation-types.js";
import { canonicalizeWorkspaces } from "./external-client-workspace.js";

/** A named process outside the Host that may call the delegation API with its own token. */
export interface ExternalClient {
  name: string;
  createdAt: string;
}

export interface ExternalClientRecord extends ExternalClient {
  access: ExternalClientAccess;
  workspaces: string[];
  connectionMode: ExternalClientConnectionMode;
  dispatchGrant: ExternalClientDispatchGrant;
  oauthClientId?: string;
  directUrl?: string;
}

export interface ExternalClientWriteOptions {
  access?: ExternalClientAccess;
  workspaces?: readonly string[];
  connectionMode?: ExternalClientConnectionMode;
  dispatchGrant?: ExternalClientDispatchGrant;
  oauthClientId?: string | null;
  directUrl?: string | null;
}

interface StoredClient {
  name: string;
  createdAt: string;
  salt: string;
  /** sha256(salt + token), hex. Tokens are 32 random bytes, so a fast hash is sufficient. */
  tokenHash: string;
  access?: ExternalClientAccess;
  workspaces?: string[];
  connectionMode?: ExternalClientConnectionMode;
  dispatchGrant?: ExternalClientDispatchGrant;
  oauthClientId?: string;
  directUrl?: string;
}

interface ClientsFile {
  formatVersion: 1 | 2;
  clients: StoredClient[];
}

export const LOCAL_CLI_CLIENT_NAME = "local-cli";
export const MUSE_OPERATIONAL_CLIENT_NAME = "muse";

export function isValidClientName(name: string): boolean {
  return EXTERNAL_CLIENT_NAME_PATTERN.test(name);
}

const TOKEN_PREFIX = "chc_";

export function codexhostDataDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
}

export function defaultExternalClientsPath(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "external-clients.json");
}

function hashToken(salt: string, token: string): string {
  return createHash("sha256").update(salt).update(token).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseClientsFile(text: string): ClientsFile {
  const value = JSON.parse(text) as Partial<ClientsFile> | null;
  if ((value?.formatVersion !== 1 && value?.formatVersion !== 2) || !Array.isArray(value.clients)) {
    throw new Error("unrecognized external client registry");
  }
  for (const client of value.clients) {
    if (
      typeof client?.name !== "string" ||
      !EXTERNAL_CLIENT_NAME_PATTERN.test(client.name) ||
      typeof client.createdAt !== "string" ||
      typeof client.salt !== "string" ||
      typeof client.tokenHash !== "string"
    ) {
      throw new Error("unrecognized external client registry entry");
    }
  }
  return value as ClientsFile;
}

function defaultsForName(
  name: string,
): Pick<ExternalClientRecord, "access" | "workspaces" | "connectionMode" | "dispatchGrant"> {
  if (name === MUSE_OPERATIONAL_CLIENT_NAME) {
    return {
      access: "all-threads",
      workspaces: [],
      connectionMode: "public-relay",
      dispatchGrant: "legacy-four",
    };
  }
  return {
    access: "all-threads",
    workspaces: [],
    connectionMode: "local",
    dispatchGrant: "full-dispatch",
  };
}

function recordOf(stored: StoredClient): ExternalClientRecord {
  const defaults = defaultsForName(stored.name);
  return {
    name: stored.name,
    createdAt: stored.createdAt,
    access: stored.access ?? defaults.access,
    workspaces: stored.workspaces ?? defaults.workspaces,
    connectionMode: stored.connectionMode ?? defaults.connectionMode,
    dispatchGrant: stored.dispatchGrant ?? defaults.dispatchGrant,
    ...(stored.oauthClientId ? { oauthClientId: stored.oauthClientId } : {}),
    ...(stored.directUrl ? { directUrl: stored.directUrl } : {}),
  };
}

function localCliRecord(): ExternalClientRecord {
  return {
    name: LOCAL_CLI_CLIENT_NAME,
    createdAt: new Date(0).toISOString(),
    access: "all-threads",
    workspaces: [],
    connectionMode: "local",
    dispatchGrant: "full-dispatch",
  };
}

function invalidNameError(): DelegationControlError {
  return new DelegationControlError(
    "INVALID_ARGUMENT",
    "Client name must use lowercase letters, digits and hyphens, start and end with a letter or digit, and be at most 64 characters",
  );
}

/**
 * Registered external clients, kept in one private file. The CLI edits the file
 * directly, so registration works while no Runtime is running; a Runtime re-reads
 * it when it changes, so removal takes effect on the next request.
 */
export class ExternalClientRegistry {
  readonly #filePath: string;
  readonly #cliTokenHash: string | undefined;
  #cache: { mtimeMs: number; size: number; clients: StoredClient[] } | undefined;

  constructor(filePath: string, localCliToken?: string) {
    this.#filePath = filePath;
    this.#cliTokenHash = localCliToken ? hashToken("", localCliToken) : undefined;
  }

  async add(
    name: string,
    now: Date = new Date(),
    options: ExternalClientWriteOptions = {},
  ): Promise<{ client: ExternalClient; token: string }> {
    const created = await this.create(name, options, now);
    return {
      client: { name: created.record.name, createdAt: created.record.createdAt },
      token: created.token,
    };
  }

  async create(
    name: string,
    options: ExternalClientWriteOptions = {},
    now: Date = new Date(),
  ): Promise<{ record: ExternalClientRecord; token: string }> {
    if (!EXTERNAL_CLIENT_NAME_PATTERN.test(name)) throw invalidNameError();
    if (name === LOCAL_CLI_CLIENT_NAME) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Client name 'local-cli' is reserved for the local CLI",
      );
    }
    const clients = await this.#read();
    if (clients.some((client) => client.name === name)) {
      throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' already exists`);
    }
    const policy = await this.#policy(name, defaultsForName(name), options);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const salt = randomBytes(16).toString("hex");
    const stored: StoredClient = {
      name,
      createdAt: now.toISOString(),
      salt,
      tokenHash: hashToken(salt, token),
      ...policy,
    };
    await this.#write([...clients, stored]);
    return { record: recordOf(stored), token };
  }

  async update(name: string, options: ExternalClientWriteOptions): Promise<ExternalClientRecord> {
    if (name === LOCAL_CLI_CLIENT_NAME) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "The local CLI identity cannot be updated here",
      );
    }
    const clients = await this.#read();
    const index = clients.findIndex((client) => client.name === name);
    if (index < 0) {
      throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
    }
    const current = clients[index] as StoredClient;
    const policy = await this.#policy(name, recordOf(current), options);
    const stored: StoredClient = {
      ...current,
      ...policy,
    };
    if (options.oauthClientId === null) delete stored.oauthClientId;
    if (options.directUrl === null || options.directUrl === "") delete stored.directUrl;
    const next = [...clients];
    next[index] = stored;
    await this.#write(next);
    return recordOf(stored);
  }

  async list(): Promise<ExternalClient[]> {
    return (await this.#read()).map(({ name, createdAt }) => ({ name, createdAt }));
  }

  async listRecords(): Promise<ExternalClientRecord[]> {
    return (await this.#read()).map(recordOf);
  }

  async record(name: string): Promise<ExternalClientRecord | undefined> {
    if (name === LOCAL_CLI_CLIENT_NAME && this.#cliTokenHash) return localCliRecord();
    const stored = (await this.#current()).find((client) => client.name === name);
    return stored ? recordOf(stored) : undefined;
  }

  async remove(name: string): Promise<void> {
    const clients = await this.#read();
    if (!clients.some((client) => client.name === name))
      throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
    await this.#write(clients.filter((client) => client.name !== name));
  }

  /** The client the token belongs to, or undefined. Every entry is compared, so timing reveals nothing. */
  async authenticate(token: string | undefined): Promise<string | undefined> {
    if (!token?.startsWith(TOKEN_PREFIX)) return undefined;
    let match =
      this.#cliTokenHash && sameHash(hashToken("", token), this.#cliTokenHash)
        ? LOCAL_CLI_CLIENT_NAME
        : undefined;
    for (const client of await this.#current()) {
      if (sameHash(hashToken(client.salt, token), client.tokenHash)) match = client.name;
    }
    return match;
  }

  /** Whether a client is still registered; used to end connections of removed clients. */
  async has(name: string): Promise<boolean> {
    return (
      (name === LOCAL_CLI_CLIENT_NAME && this.#cliTokenHash !== undefined) ||
      (await this.#current()).some((client) => client.name === name)
    );
  }

  async #policy(
    name: string,
    base: Pick<
      ExternalClientRecord,
      "access" | "workspaces" | "connectionMode" | "dispatchGrant" | "oauthClientId" | "directUrl"
    >,
    options: ExternalClientWriteOptions,
  ): Promise<
    Pick<
      StoredClient,
      "access" | "workspaces" | "connectionMode" | "dispatchGrant" | "oauthClientId" | "directUrl"
    >
  > {
    const access = options.access ?? base.access;
    const connectionMode = options.connectionMode ?? base.connectionMode;
    const dispatchGrant = options.dispatchGrant ?? base.dispatchGrant;
    if (name === MUSE_OPERATIONAL_CLIENT_NAME && connectionMode !== "public-relay") {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Muse must use the public relay; loopback and Direct URLs are not valid Muse connectors",
      );
    }
    let workspaces = base.workspaces;
    if (access === "all-threads") {
      workspaces = [];
    } else if (options.workspaces !== undefined || access !== base.access) {
      const requested = options.workspaces ?? base.workspaces;
      if (requested.length === 0) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Selected workspaces access requires at least one resolvable workspace",
        );
      }
      workspaces = await canonicalizeWorkspaces(requested);
    }
    const oauthClientId =
      options.oauthClientId === null ? undefined : (options.oauthClientId ?? base.oauthClientId);
    const requestedDirectUrl =
      options.directUrl === null || options.directUrl === ""
        ? undefined
        : (options.directUrl ?? base.directUrl);
    if (requestedDirectUrl && !isProtectedDirectMcpUrl(requestedDirectUrl)) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Direct MCP URL must be https://…/mcp or http://100.x.x.x/mcp on Tailscale, without credentials or query",
      );
    }
    return {
      access,
      workspaces,
      connectionMode,
      dispatchGrant,
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(requestedDirectUrl ? { directUrl: requestedDirectUrl } : {}),
    };
  }

  async #current(): Promise<StoredClient[]> {
    let info: { mtimeMs: number; size: number };
    try {
      info = await stat(this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (this.#cache?.mtimeMs === info.mtimeMs && this.#cache.size === info.size)
      return this.#cache.clients;
    const clients = await this.#read();
    this.#cache = { mtimeMs: info.mtimeMs, size: info.size, clients };
    return clients;
  }

  async #read(): Promise<StoredClient[]> {
    try {
      return parseClientsFile(await readFile(this.#filePath, "utf8")).clients;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #write(clients: StoredClient[]): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const file: ClientsFile = { formatVersion: 2, clients };
    const temporary = `${this.#filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    this.#cache = undefined;
  }
}

export function publicViewOf(
  record: ExternalClientRecord,
  extras: { mcpUrl?: string; mcpUrlNote?: string } = {},
): ExternalClientPublicView {
  return {
    name: record.name,
    createdAt: record.createdAt,
    access: record.access,
    workspaces: [...record.workspaces],
    connectionMode: record.connectionMode,
    dispatchGrant: record.dispatchGrant,
    ...(record.oauthClientId ? { oauthClientId: record.oauthClientId } : {}),
    ...(record.directUrl ? { directUrl: record.directUrl } : {}),
    ...(extras.mcpUrl ? { mcpUrl: extras.mcpUrl } : {}),
    ...(extras.mcpUrlNote ? { mcpUrlNote: extras.mcpUrlNote } : {}),
  };
}

export const DIRECT_MCP_URL_ENV = "CODEXHOST_DIRECT_MCP_URL";

export function assertFullDispatchClient(
  record: ExternalClientRecord | undefined,
  oauthClientId: string | undefined,
): ExternalClientRecord {
  if (!record || record.dispatchGrant !== "full-dispatch") {
    throw new DelegationControlError(
      "UNAUTHORIZED_TARGET",
      "This client is not approved for full Host dispatch",
    );
  }
  if (record.oauthClientId && record.oauthClientId !== oauthClientId) {
    throw new DelegationControlError(
      "UNAUTHORIZED_TARGET",
      "OAuth client does not match this Host client",
    );
  }
  return record;
}

export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}
