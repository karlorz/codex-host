import path from "node:path";

import {
  DEFAULT_ENROLLMENT_CLIENT_ID,
  parseAllowlistOption,
  parseEnrollmentClientId,
  publicEnrollmentView,
  verifyEnrollmentRecord,
  type EnrollmentRecord,
} from "./client-enrollment.js";
import {
  deleteEnrollmentStore,
  enrollmentBootstrapPath,
  enrollmentStorePath,
  readEnrollmentBootstrap,
  readEnrollmentStore,
  rejectForeignCredentialSources,
  writeEnrollmentStore,
} from "./client-enrollment-store.js";
import type { DelegationCliArguments } from "./delegation-cli-options.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  NATIVE_CODEX_THREAD_ID_ENV,
  DelegationControlError,
} from "./delegation-types.js";

export interface CliRuntimeConnection {
  endpoint: string;
  token: string;
  callerThreadId?: string;
  source: "env" | "enrollment";
}

export function missingRuntimeEnvironmentError(
  endpoint: string | undefined,
  token: string | undefined,
): DelegationControlError {
  const missingEnvironmentVariables = [
    ...(!endpoint ? [DELEGATION_RUNTIME_ENDPOINT_ENV] : []),
    ...(!token ? [DELEGATION_RUNTIME_TOKEN_ENV] : []),
  ];
  return new DelegationControlError(
    "RUNTIME_UNREACHABLE",
    `${missingEnvironmentVariables.join(" and ")} ${missingEnvironmentVariables.length === 1 ? "is" : "are"} required. If this command runs inside native Codex, shell_environment_policy may have filtered the Host-provided CODEXHOST_* variables. Prefer inherit = "all" with ignore_default_excludes = true and a narrow include_only allowlist that contains "CODEXHOST_RUNTIME_ENDPOINT" and "CODEXHOST_RUNTIME_TOKEN" plus the variables required by the platform and invoked tools; do not use unconstrained inherit = "all".`,
    {
      reason: "missing_runtime_environment",
      missingEnvironmentVariables,
      nativeCodexRecovery: {
        recommendedPolicy: {
          inherit: "all",
          ignoreDefaultExcludes: true,
          includeOnlyMustContain: [DELEGATION_RUNTIME_ENDPOINT_ENV, DELEGATION_RUNTIME_TOKEN_ENV],
        },
      },
    },
  );
}

function option(parsed: DelegationCliArguments, name: string): string | undefined {
  return parsed.options.get(name);
}

export function rejectEnrollmentAttackOptions(
  environment: NodeJS.ProcessEnv,
  parsed: DelegationCliArguments,
): void {
  const fromPid = option(parsed, "--from-pid");
  const fromEnvFile = option(parsed, "--from-env-file");
  const asThread = option(parsed, "--as-thread");
  rejectForeignCredentialSources({
    environment,
    ...(fromPid ? { fromPid } : {}),
    ...(fromEnvFile ? { fromEnvFile } : {}),
    ...(asThread ? { asThread } : {}),
  });
}

export async function resolveCliRuntimeConnection(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  nowMs: number;
}): Promise<CliRuntimeConnection> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const endpoint = input.environment[DELEGATION_RUNTIME_ENDPOINT_ENV];
  const token = input.environment[DELEGATION_RUNTIME_TOKEN_ENV];
  if (endpoint && token) {
    const callerThreadId =
      input.environment[DELEGATION_THREAD_ID_ENV] ||
      input.environment[NATIVE_CODEX_THREAD_ID_ENV] ||
      undefined;
    return {
      endpoint,
      token,
      source: "env",
      ...(callerThreadId ? { callerThreadId } : {}),
    };
  }
  if (endpoint || token) throw missingRuntimeEnvironmentError(endpoint, token);
  const clientId = parseEnrollmentClientId(
    option(input.parsed, "--client") ??
      input.environment.CODEXHOST_ENROLL_CLIENT ??
      DEFAULT_ENROLLMENT_CLIENT_ID,
  );
  const record = await readEnrollmentStore(
    enrollmentStorePath(input.environment, clientId),
    input.nowMs,
  );
  if (!record) throw missingRuntimeEnvironmentError(undefined, undefined);
  return {
    endpoint: record.endpoint,
    token: record.token,
    callerThreadId: record.threadId,
    source: "enrollment",
  };
}

export async function runEnrollRequest(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  nowMs: number;
  request: (
    path: string,
    body: Record<string, unknown>,
    connection: CliRuntimeConnection,
  ) => Promise<unknown>;
}): Promise<{
  record: EnrollmentRecord;
  storePath: string;
  view: ReturnType<typeof publicEnrollmentView> & { storePath: string };
}> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const client = option(input.parsed, "--client");
  if (!client) {
    throw new DelegationControlError("INVALID_ARGUMENT", "--client is required");
  }
  const clientId = parseEnrollmentClientId(client);
  const allowlist = parseAllowlistOption(option(input.parsed, "--allow"));
  const executable = option(input.parsed, "--executable") ?? process.argv[1] ?? process.execPath;
  const executablePath = path.isAbsolute(executable) ? executable : path.resolve(executable);
  const hostEndpoint = input.environment[DELEGATION_RUNTIME_ENDPOINT_ENV];
  const hostToken = input.environment[DELEGATION_RUNTIME_TOKEN_ENV];
  const hostConnection =
    typeof hostEndpoint === "string" &&
    hostEndpoint.length > 0 &&
    typeof hostToken === "string" &&
    hostToken.length > 0
      ? { endpoint: hostEndpoint, token: hostToken, source: "env" as const }
      : undefined;
  const bootstrap = hostConnection
    ? undefined
    : await readEnrollmentBootstrap(enrollmentBootstrapPath(input.environment));
  const connection = hostConnection ?? {
    endpoint: bootstrap!.endpoint,
    token: bootstrap!.bootstrapToken,
    source: "enrollment" as const,
  };
  const issued = (await input.request(
    "/v1/enroll",
    {
      clientId,
      executablePath,
      allowlist,
    },
    connection,
  )) as EnrollmentRecord;
  const parentToken = hostToken;
  const bootstrapToken = bootstrap?.bootstrapToken;
  if (
    typeof issued !== "object" ||
    issued === null ||
    (bootstrapToken && issued.token === bootstrapToken) ||
    (parentToken && issued.token === parentToken) ||
    issued.enrollmentId === issued.threadId
  ) {
    throw new DelegationControlError("ENROLLMENT_INVALID", "Host issued an invalid enrollment", {
      reason: "allowlist_tamper",
    });
  }
  verifyEnrollmentRecord(issued, input.nowMs);
  const storePath = enrollmentStorePath(input.environment, clientId);
  await writeEnrollmentStore(storePath, issued);
  return {
    record: issued,
    storePath,
    view: { ...publicEnrollmentView(issued), storePath },
  };
}

export async function runEnrollStatus(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  nowMs: number;
}): Promise<{
  view: ReturnType<typeof publicEnrollmentView> & { storePath: string };
  storePath: string;
}> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const clientId = parseEnrollmentClientId(
    option(input.parsed, "--client") ?? DEFAULT_ENROLLMENT_CLIENT_ID,
  );
  const storePath = enrollmentStorePath(input.environment, clientId);
  const record = await readEnrollmentStore(storePath, input.nowMs);
  if (!record) {
    throw new DelegationControlError("ENROLLMENT_INVALID", "No enrollment store is present", {
      reason: "missing_store",
    });
  }
  return { storePath, view: { ...publicEnrollmentView(record), storePath } };
}

export async function runEnrollRevoke(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  nowMs: number;
  request: (
    path: string,
    body: Record<string, unknown>,
    connection: CliRuntimeConnection,
  ) => Promise<unknown>;
}): Promise<{ enrollmentId: string; revoked: true; storePath: string }> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const clientId = parseEnrollmentClientId(
    option(input.parsed, "--client") ?? DEFAULT_ENROLLMENT_CLIENT_ID,
  );
  const storePath = enrollmentStorePath(input.environment, clientId);
  const record = await readEnrollmentStore(storePath, input.nowMs);
  if (!record) {
    throw new DelegationControlError("ENROLLMENT_INVALID", "No enrollment store is present", {
      reason: "revoked",
    });
  }
  await input.request(
    "/v1/enroll/revoke",
    {},
    {
      endpoint: record.endpoint,
      token: record.token,
      source: "enrollment",
      callerThreadId: record.threadId,
    },
  );
  await deleteEnrollmentStore(storePath);
  return { enrollmentId: record.enrollmentId, revoked: true, storePath };
}
