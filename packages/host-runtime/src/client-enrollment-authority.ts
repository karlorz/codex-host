import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_ENROLLMENT_TTL_MS,
  MACHINE_ENROLLMENT_TTL_MS,
  allowlistDigest,
  authorizeEnrollment,
  canonicalizeAllowlist,
  enrollmentError,
  filterEnrollmentThreadList,
  filterEnrollmentWatches,
  issuedAllowlist,
  parseEnrollmentClientId,
  parseEnrollmentPairing,
  publicEnrollmentView,
  verifyEnrollmentRecord,
  type EnrollmentAllowlistEntry,
  type EnrollmentPairing,
  type EnrollmentRecord,
  type EnrollmentRequestAction,
} from "./client-enrollment.js";
import {
  createTimeoutEnrollmentConsent,
  DEFAULT_ENROLLMENT_CONSENT_TIMEOUT_MS,
  type EnrollmentConsent,
} from "./client-enrollment-consent.js";
import {
  deleteEnrollmentStore,
  enrollmentBootstrapPath,
  enrollmentRuntimeRecordsPath,
  enrollmentStorePath,
  readRuntimeEnrollmentRecords,
  writeEnrollmentBootstrap,
  writeRuntimeEnrollmentRecords,
  type EnrollmentBootstrapDescriptor,
} from "./client-enrollment-store.js";
import { matchesBearerToken } from "./bearer-token.js";
import { DelegationControlError } from "./delegation-types.js";
import type { DelegationThreadListResult, ThreadWatchListResult } from "./delegation-types.js";

export type EnrollmentPrincipal =
  { kind: "host" } | { kind: "enrollment"; record: EnrollmentRecord };

export interface EnrollmentIssueRequest {
  clientId: string;
  executablePath: string;
  allowlist?: EnrollmentAllowlistEntry[];
  pairing?: EnrollmentPairing;
  /** Host-authenticated calling session; required to reuse a machine pairing. */
  attendedHostApprove?: boolean;
}

export class EnrollmentAuthority {
  readonly #hostToken: string;
  readonly #bootstrapToken: string;
  readonly #consent: EnrollmentConsent;
  readonly #dataDirectory: string;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createToken: () => string;
  readonly #pid: number;
  readonly #byToken = new Map<string, EnrollmentRecord>();
  #endpoint: string | undefined;
  #bootstrapPath: string | undefined;

  constructor(input: {
    hostToken: string;
    dataDirectory: string;
    consent?: EnrollmentConsent;
    now?: () => number;
    createId?: () => string;
    createToken?: () => string;
    pid?: number;
    bootstrapToken?: string;
  }) {
    this.#hostToken = input.hostToken;
    this.#bootstrapToken = input.bootstrapToken ?? randomBytes(32).toString("hex");
    this.#consent =
      input.consent ??
      createTimeoutEnrollmentConsent({
        timeoutMs: DEFAULT_ENROLLMENT_CONSENT_TIMEOUT_MS,
      });
    this.#dataDirectory = input.dataDirectory;
    this.#now = input.now ?? Date.now;
    this.#createId = input.createId ?? randomUUID;
    this.#createToken = input.createToken ?? (() => randomBytes(32).toString("hex"));
    this.#pid = input.pid ?? process.pid;
  }

  get bootstrapToken(): string {
    return this.#bootstrapToken;
  }

  bootstrapDescriptor(): EnrollmentBootstrapDescriptor {
    if (!this.#endpoint) {
      throw new DelegationControlError("INTERNAL_ERROR", "Enrollment bootstrap is not published");
    }
    return {
      schemaVersion: 1,
      endpoint: this.#endpoint,
      bootstrapToken: this.#bootstrapToken,
      pid: this.#pid,
      startedAt: new Date(this.#now()).toISOString(),
    };
  }

  async publishBootstrap(endpoint: string): Promise<string> {
    this.#endpoint = endpoint;
    this.#bootstrapPath = enrollmentBootstrapPath({ CODEXHOST_DATA_DIR: this.#dataDirectory });
    await this.#restoreRecords();
    await this.#saveRecords();
    await writeEnrollmentBootstrap(this.#bootstrapPath, this.bootstrapDescriptor());
    return this.#bootstrapPath;
  }

  async #restoreRecords(): Promise<void> {
    const records = await readRuntimeEnrollmentRecords(
      enrollmentRuntimeRecordsPath({ CODEXHOST_DATA_DIR: this.#dataDirectory }),
    );
    this.#byToken.clear();
    for (const record of records) {
      const next = this.#verified({ ...record, endpoint: this.#endpoint ?? record.endpoint });
      if (next) this.#byToken.set(next.token, next);
    }
  }

  #verified(record: EnrollmentRecord): EnrollmentRecord | undefined {
    try {
      verifyEnrollmentRecord(record, this.#now());
      return record;
    } catch (error) {
      if (!(error instanceof DelegationControlError)) throw error;
      return undefined;
    }
  }

  async #saveRecords(): Promise<void> {
    await writeRuntimeEnrollmentRecords(
      enrollmentRuntimeRecordsPath({ CODEXHOST_DATA_DIR: this.#dataDirectory }),
      [...this.#byToken.values()],
    );
  }

  async close(): Promise<void> {
    if (this.#bootstrapPath) await rm(this.#bootstrapPath, { force: true });
  }

  matchesBootstrap(header: string | undefined): boolean {
    return matchesBearerToken(header, this.#bootstrapToken);
  }

  authenticate(header: string | undefined): EnrollmentPrincipal | undefined {
    if (matchesBearerToken(header, this.#hostToken)) return { kind: "host" };
    for (const record of this.#byToken.values()) {
      if (matchesBearerToken(header, record.token)) return { kind: "enrollment", record };
    }
    return undefined;
  }

  #activeMachineRecord(clientId: string): EnrollmentRecord | undefined {
    for (const record of this.#byToken.values()) {
      if (record.clientId !== clientId || record.pairing !== "machine") continue;
      if (this.#verified(record)) return record;
    }
    return undefined;
  }

  #revokeActiveForClient(clientId: string): void {
    const revokedAt = new Date(this.#now()).toISOString();
    for (const [token, record] of this.#byToken) {
      if (record.clientId !== clientId || record.revokedAt) continue;
      this.#byToken.set(token, { ...record, revokedAt });
    }
  }

  async enroll(request: EnrollmentIssueRequest): Promise<EnrollmentRecord> {
    const clientId = parseEnrollmentClientId(request.clientId);
    const executablePath = path.isAbsolute(request.executablePath)
      ? request.executablePath
      : path.resolve(request.executablePath);
    const requested = canonicalizeAllowlist(request.allowlist ?? []);
    const pairing = parseEnrollmentPairing(request.pairing);
    if (!this.#endpoint) {
      throw new DelegationControlError("INTERNAL_ERROR", "Enrollment bootstrap is not published");
    }
    if (pairing === "machine" && request.attendedHostApprove) {
      const existing = this.#activeMachineRecord(clientId);
      if (
        existing &&
        allowlistDigest(issuedAllowlist(existing.threadId, requested)) === existing.allowlistDigest
      ) {
        const refreshed: EnrollmentRecord = {
          ...existing,
          endpoint: this.#endpoint,
          executablePath,
        };
        this.#byToken.set(refreshed.token, refreshed);
        await this.#saveRecords();
        return refreshed;
      }
    }
    const decision = request.attendedHostApprove
      ? "approve"
      : await this.#consent.decide({
          clientId,
          executablePath,
          allowlist: requested,
        });
    if (decision === "deny") {
      throw enrollmentError("ENROLLMENT_DENIED", "Enrollment was denied", "denied");
    }
    if (decision !== "approve") {
      throw enrollmentError("ENROLLMENT_DENIED", "Enrollment timed out", "timeout");
    }
    if (pairing === "machine") this.#revokeActiveForClient(clientId);
    const enrollmentId = this.#createId();
    const threadId = this.#createId();
    if (threadId === enrollmentId) {
      throw new DelegationControlError("INTERNAL_ERROR", "Enrollment identifiers must be distinct");
    }
    let token = this.#createToken();
    if (token === this.#hostToken || token === this.#bootstrapToken) token = this.#createToken();
    if (token === this.#hostToken || token === this.#bootstrapToken) {
      throw new DelegationControlError(
        "INTERNAL_ERROR",
        "Enrollment token collided with a Host token",
      );
    }
    const issuedAtMs = this.#now();
    const tokenTtlMs =
      pairing === "machine" ? MACHINE_ENROLLMENT_TTL_MS : DEFAULT_ENROLLMENT_TTL_MS;
    const allowlist = issuedAllowlist(threadId, requested);
    const record: EnrollmentRecord = {
      schemaVersion: 1,
      enrollmentId,
      threadId,
      token,
      endpoint: this.#endpoint,
      clientId,
      executablePath,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + tokenTtlMs).toISOString(),
      allowlist,
      allowlistDigest: allowlistDigest(allowlist),
      pairing,
    };
    this.#byToken.set(token, record);
    await this.#saveRecords();
    return record;
  }

  async revoke(header: string | undefined): Promise<EnrollmentRecord> {
    const principal = this.authenticate(header);
    if (principal?.kind !== "enrollment") {
      throw enrollmentError("ENROLLMENT_INVALID", "Enrollment has been revoked", "revoked");
    }
    const revoked: EnrollmentRecord = {
      ...principal.record,
      revokedAt: new Date(this.#now()).toISOString(),
    };
    this.#byToken.set(revoked.token, revoked);
    await this.#saveRecords();
    return revoked;
  }

  status(header: string | undefined): ReturnType<typeof publicEnrollmentView> {
    const principal = this.authenticate(header);
    if (principal?.kind !== "enrollment") {
      throw enrollmentError("ENROLLMENT_INVALID", "Enrollment is not active", "revoked");
    }
    verifyEnrollmentRecord(principal.record, this.#now());
    return publicEnrollmentView(principal.record);
  }

  listPublic(): ReturnType<typeof publicEnrollmentView>[] {
    return [...this.#byToken.values()]
      .filter((record) => this.#verified(record))
      .map((record) => publicEnrollmentView(record))
      .sort((left, right) => {
        const client = left.clientId.localeCompare(right.clientId);
        return client === 0 ? right.issuedAt.localeCompare(left.issuedAt) : client;
      });
  }

  async revokeEnrollment(enrollmentId: string): Promise<{ enrollmentId: string; revoked: true }> {
    const id = enrollmentId.trim();
    let target: EnrollmentRecord | undefined;
    for (const record of this.#byToken.values()) {
      if (record.enrollmentId === id && !record.revokedAt) {
        target = record;
        break;
      }
    }
    if (!target) {
      throw enrollmentError("ENROLLMENT_INVALID", "Enrollment is not active", "revoked");
    }
    this.#byToken.set(target.token, {
      ...target,
      revokedAt: new Date(this.#now()).toISOString(),
    });
    await this.#saveRecords();
    const remaining = [...this.#byToken.values()].some(
      (record) => record.clientId === target.clientId && this.#verified(record),
    );
    if (!remaining) {
      await deleteEnrollmentStore(
        enrollmentStorePath({ CODEXHOST_DATA_DIR: this.#dataDirectory }, target.clientId),
      );
    }
    return { enrollmentId: target.enrollmentId, revoked: true };
  }

  authorize(record: EnrollmentRecord, action: EnrollmentRequestAction): void {
    authorizeEnrollment(record, action, this.#now());
  }

  filterList(
    record: EnrollmentRecord,
    result: DelegationThreadListResult,
  ): DelegationThreadListResult {
    return filterEnrollmentThreadList(record, result);
  }

  filterWatches(record: EnrollmentRecord, result: ThreadWatchListResult): ThreadWatchListResult {
    return filterEnrollmentWatches(record, result);
  }
}
