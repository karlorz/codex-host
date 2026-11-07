import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_ENROLLMENT_TTL_MS,
  allowlistDigest,
  authorizeEnrollment,
  canonicalizeAllowlist,
  enrollmentError,
  filterEnrollmentThreadList,
  filterEnrollmentWatches,
  issuedAllowlist,
  parseEnrollmentClientId,
  publicEnrollmentView,
  verifyEnrollmentRecord,
  type EnrollmentAllowlistEntry,
  type EnrollmentRecord,
  type EnrollmentRequestAction,
} from "./client-enrollment.js";
import {
  createTimeoutEnrollmentConsent,
  DEFAULT_ENROLLMENT_CONSENT_TIMEOUT_MS,
  type EnrollmentConsent,
} from "./client-enrollment-consent.js";
import {
  enrollmentBootstrapPath,
  enrollmentRuntimeRecordsPath,
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
  /** Host-session attended approve (Karl GO). Skips the Desktop timeout stub. */
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
  readonly #tokenTtlMs: number;
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
    tokenTtlMs?: number;
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
    this.#tokenTtlMs = input.tokenTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
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
    for (const [token, record] of this.#byToken) {
      this.#byToken.set(token, { ...record, endpoint });
    }
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
      const next = { ...record, endpoint: this.#endpoint ?? record.endpoint };
      try {
        verifyEnrollmentRecord(next, this.#now());
      } catch {
        continue;
      }
      this.#byToken.set(next.token, next);
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

  async enroll(request: EnrollmentIssueRequest): Promise<EnrollmentRecord> {
    const clientId = parseEnrollmentClientId(request.clientId);
    const executablePath = path.isAbsolute(request.executablePath)
      ? request.executablePath
      : path.resolve(request.executablePath);
    if (!executablePath) {
      throw new DelegationControlError("INVALID_ARGUMENT", "executable path is required");
    }
    const requested = canonicalizeAllowlist(request.allowlist ?? []);
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
    if (!this.#endpoint) {
      throw new DelegationControlError("INTERNAL_ERROR", "Enrollment bootstrap is not published");
    }
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
      expiresAt: new Date(issuedAtMs + this.#tokenTtlMs).toISOString(),
      allowlist,
      allowlistDigest: allowlistDigest(allowlist),
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
