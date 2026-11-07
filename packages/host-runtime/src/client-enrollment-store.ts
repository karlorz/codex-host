import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  allowlistDigest,
  assertLoopbackHttpUrl,
  assertNotParentIdentity,
  enrollmentError,
  parseEnrollmentClientId,
  verifyEnrollmentRecord,
  type EnrollmentRecord,
} from "./client-enrollment.js";
import { DelegationControlError } from "./delegation-types.js";

export const ENROLL_FROM_PID_ENV = "CODEXHOST_ENROLL_FROM_PID";
export const ENROLL_FROM_ENV_FILE_ENV = "CODEXHOST_ENROLL_FROM_ENV_FILE";

export function codexhostDataDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
}

export function enrollmentDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "enroll");
}

export function enrollmentBootstrapPath(environment: NodeJS.ProcessEnv): string {
  return path.join(enrollmentDirectory(environment), "bootstrap.json");
}

export function enrollmentStorePath(environment: NodeJS.ProcessEnv, clientId: string): string {
  return path.join(
    enrollmentDirectory(environment),
    "clients",
    `${parseEnrollmentClientId(clientId)}.json`,
  );
}

export function enrollmentRuntimeRecordsPath(environment: NodeJS.ProcessEnv): string {
  return path.join(enrollmentDirectory(environment), "runtime-records.json");
}

export function isPrivateFileMode(mode: number): boolean {
  if (process.platform === "win32") return true;
  return (mode & 0o777) === 0o600;
}

export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export function rejectForeignCredentialSources(input: {
  environment: NodeJS.ProcessEnv;
  fromPid?: string;
  fromEnvFile?: string;
  asThread?: string;
}): void {
  const fromPid = input.fromPid ?? input.environment[ENROLL_FROM_PID_ENV];
  if (fromPid) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment cannot load another process's environment",
      "foreign_pid_environ",
    );
  }
  const fromEnvFile = input.fromEnvFile ?? input.environment[ENROLL_FROM_ENV_FILE_ENV];
  if (fromEnvFile) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment cannot load a parent Runtime environment file",
      "parent_env_file",
    );
  }
  if (input.asThread) assertNotParentIdentity(input.asThread);
}

export function loadEnrollmentCredentialsFromPid(pid: string): never {
  void pid;
  throw enrollmentError(
    "ENROLLMENT_INVALID",
    "Enrollment cannot load another process's environment",
    "foreign_pid_environ",
  );
}

export function loadEnrollmentCredentialsFromEnvFile(filePath: string): never {
  void filePath;
  throw enrollmentError(
    "ENROLLMENT_INVALID",
    "Enrollment cannot load a parent Runtime environment file",
    "parent_env_file",
  );
}

function isEnrollmentRecord(value: unknown): value is EnrollmentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.enrollmentId === "string" &&
    typeof record.threadId === "string" &&
    typeof record.token === "string" &&
    typeof record.endpoint === "string" &&
    typeof record.clientId === "string" &&
    typeof record.executablePath === "string" &&
    typeof record.issuedAt === "string" &&
    typeof record.expiresAt === "string" &&
    typeof record.allowlistDigest === "string" &&
    Array.isArray(record.allowlist)
  );
}

export async function writeRuntimeEnrollmentRecords(
  filePath: string,
  records: readonly EnrollmentRecord[],
): Promise<void> {
  for (const record of records) {
    const digest = allowlistDigest(record.allowlist);
    if (digest !== record.allowlistDigest) {
      throw enrollmentError(
        "ENROLLMENT_INVALID",
        "Enrollment allowlist no longer matches its consent digest",
        "allowlist_tamper",
      );
    }
    assertNotParentIdentity(record.threadId);
    assertLoopbackHttpUrl(record.endpoint);
  }
  await writePrivateJsonFile(filePath, { schemaVersion: 1, records });
}

export async function readRuntimeEnrollmentRecords(filePath: string): Promise<EnrollmentRecord[]> {
  let text: string;
  let mode: number;
  try {
    const info = await stat(filePath);
    mode = info.mode;
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  if (!isPrivateFileMode(mode)) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Runtime enrollment records are not user-private mode 600",
      "insecure_store_mode",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Runtime enrollment records are not valid JSON",
      "allowlist_tamper",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  return records.filter(isEnrollmentRecord);
}

export async function writeEnrollmentStore(
  filePath: string,
  record: EnrollmentRecord,
): Promise<void> {
  const digest = allowlistDigest(record.allowlist);
  if (digest !== record.allowlistDigest) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment allowlist no longer matches its consent digest",
      "allowlist_tamper",
    );
  }
  assertNotParentIdentity(record.threadId);
  assertLoopbackHttpUrl(record.endpoint);
  await writePrivateJsonFile(filePath, record);
}

export async function readEnrollmentStore(
  filePath: string,
  nowMs: number,
): Promise<EnrollmentRecord | undefined> {
  let text: string;
  let mode: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw enrollmentError(
        "ENROLLMENT_INVALID",
        "Enrollment store is not a regular file",
        "insecure_store_mode",
      );
    }
    mode = info.mode;
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    if (error instanceof DelegationControlError) throw error;
    throw error;
  }
  if (!isPrivateFileMode(mode)) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment store is not user-private mode 600",
      "insecure_store_mode",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment store is not valid JSON",
      "allowlist_tamper",
    );
  }
  if (!isEnrollmentRecord(parsed)) {
    throw enrollmentError("ENROLLMENT_INVALID", "Enrollment store is invalid", "allowlist_tamper");
  }
  verifyEnrollmentRecord(parsed, nowMs);
  return parsed;
}

export async function deleteEnrollmentStore(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export interface EnrollmentBootstrapDescriptor {
  schemaVersion: 1;
  endpoint: string;
  bootstrapToken: string;
  pid: number;
  startedAt: string;
}

export async function writeEnrollmentBootstrap(
  filePath: string,
  descriptor: EnrollmentBootstrapDescriptor,
): Promise<void> {
  assertLoopbackHttpUrl(descriptor.endpoint);
  await writePrivateJsonFile(filePath, descriptor);
}

export async function readEnrollmentBootstrap(
  filePath: string,
): Promise<EnrollmentBootstrapDescriptor> {
  let text: string;
  let mode: number;
  try {
    const info = await stat(filePath);
    mode = info.mode;
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Host enrollment bootstrap is unavailable. Start Codex Host Desktop on this Mac and retry enroll.",
        { reason: "missing_enroll_bootstrap" },
      );
    }
    throw error;
  }
  if (!isPrivateFileMode(mode)) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment bootstrap is not user-private mode 600",
      "insecure_store_mode",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment bootstrap is invalid",
      "missing_enroll_bootstrap",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { endpoint?: unknown }).endpoint !== "string" ||
    typeof (parsed as { bootstrapToken?: unknown }).bootstrapToken !== "string" ||
    typeof (parsed as { pid?: unknown }).pid !== "number"
  ) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Enrollment bootstrap is invalid",
      "missing_enroll_bootstrap",
    );
  }
  const descriptor = parsed as EnrollmentBootstrapDescriptor;
  assertLoopbackHttpUrl(descriptor.endpoint);
  return descriptor;
}
