import path from "node:path";

import {
  DEFAULT_ENROLLMENT_CLIENT_ID,
  enrollPairingFromOptions,
  enrollmentError,
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
  DELEGATION_ENROLL_CLIENT_ENV,
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  NATIVE_CODEX_THREAD_ID_ENV,
  DelegationControlError,
} from "./delegation-types.js";

export const ENROLLED_CLIENT_OPTION = "--enrolled-client";

const HOST_IDENTITY_ENVS = [
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  NATIVE_CODEX_THREAD_ID_ENV,
] as const;

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

function presentEnv(environment: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((name) => Boolean(environment[name]));
}

function enrollmentRecovery(reason: unknown, clientId: string): string | undefined {
  if (reason === "expired" || reason === "missing_store" || reason === "consent_ui_unavailable") {
    return `Request a new enrollment from an authorized Host session: codexhost enroll --client ${clientId} --machine`;
  }
  if (reason === "insecure_store_mode") {
    return "Re-enroll from an authorized Host session. Do not chmod a store whose origin is untrusted.";
  }
  return undefined;
}

function annotateEnrollmentClientError(
  error: unknown,
  details: { clientId: string; storePath: string },
): never {
  if (!(error instanceof DelegationControlError)) throw error;
  const reason = error.details?.reason;
  const recovery = enrollmentRecovery(reason, details.clientId);
  throw new DelegationControlError(error.code, error.message, {
    ...error.details,
    clientId: details.clientId,
    storePath: details.storePath,
    ...(recovery ? { recovery } : {}),
  });
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

export function selectedEnrollmentClientId(
  parsed: DelegationCliArguments,
  environment: NodeJS.ProcessEnv,
): string {
  const enrolled = option(parsed, ENROLLED_CLIENT_OPTION);
  const client = option(parsed, "--client");
  if (enrolled && client && enrolled !== client) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--client and --enrolled-client must name the same client",
    );
  }
  return parseEnrollmentClientId(
    enrolled ?? client ?? environment[DELEGATION_ENROLL_CLIENT_ENV] ?? DEFAULT_ENROLLMENT_CLIENT_ID,
  );
}

export function inspectCliAuthentication(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  clientId: string;
  enrollmentThreadId?: string;
}): {
  source: "host-session" | "incomplete-host-session" | "enrollment";
  clientId: string;
  callerThreadId?: string;
  ignoredAmbient: string[];
  missingEnvironmentVariables?: string[];
} {
  const enrolled = option(input.parsed, ENROLLED_CLIENT_OPTION);
  const endpoint = input.environment[DELEGATION_RUNTIME_ENDPOINT_ENV];
  const token = input.environment[DELEGATION_RUNTIME_TOKEN_ENV];
  if (enrolled) {
    return {
      source: "enrollment",
      clientId: input.clientId,
      ...(input.enrollmentThreadId ? { callerThreadId: input.enrollmentThreadId } : {}),
      ignoredAmbient: presentEnv(input.environment, HOST_IDENTITY_ENVS),
    };
  }
  if (Boolean(endpoint) !== Boolean(token)) {
    return {
      source: "incomplete-host-session",
      clientId: input.clientId,
      ignoredAmbient: [],
      missingEnvironmentVariables: [
        ...(!endpoint ? [DELEGATION_RUNTIME_ENDPOINT_ENV] : []),
        ...(!token ? [DELEGATION_RUNTIME_TOKEN_ENV] : []),
      ],
    };
  }
  if (endpoint && token) {
    const callerThreadId =
      input.environment[DELEGATION_THREAD_ID_ENV] ||
      input.environment[NATIVE_CODEX_THREAD_ID_ENV] ||
      undefined;
    return {
      source: "host-session",
      clientId: input.clientId,
      ...(callerThreadId ? { callerThreadId } : {}),
      ignoredAmbient: [],
    };
  }
  return {
    source: "enrollment",
    clientId: input.clientId,
    ...(input.enrollmentThreadId ? { callerThreadId: input.enrollmentThreadId } : {}),
    ignoredAmbient: presentEnv(input.environment, [
      DELEGATION_THREAD_ID_ENV,
      NATIVE_CODEX_THREAD_ID_ENV,
    ]),
  };
}

async function loadEnrollmentConnection(input: {
  environment: NodeJS.ProcessEnv;
  clientId: string;
  nowMs: number;
  explicit: boolean;
}): Promise<CliRuntimeConnection> {
  const storePath = enrollmentStorePath(input.environment, input.clientId);
  try {
    const [record, liveEndpoint] = await Promise.all([
      readEnrollmentStore(storePath, input.nowMs, input.clientId),
      readLiveEnrollmentEndpoint(input.environment),
    ]);
    if (!record) {
      if (input.explicit) {
        throw enrollmentError(
          "ENROLLMENT_INVALID",
          "No enrollment store is present",
          "missing_store",
          { clientId: input.clientId, storePath },
        );
      }
      throw missingRuntimeEnvironmentError(undefined, undefined);
    }
    return {
      endpoint: enrollmentClientEndpoint(record, liveEndpoint),
      token: record.token,
      callerThreadId: record.threadId,
      source: "enrollment",
    };
  } catch (error) {
    if (
      error instanceof DelegationControlError &&
      error.details?.reason === "missing_runtime_environment"
    ) {
      throw error;
    }
    annotateEnrollmentClientError(error, { clientId: input.clientId, storePath });
  }
}

export async function resolveCliRuntimeConnection(input: {
  environment: NodeJS.ProcessEnv;
  parsed: DelegationCliArguments;
  nowMs: number;
}): Promise<CliRuntimeConnection> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const enrolledClient = option(input.parsed, ENROLLED_CLIENT_OPTION);
  if (enrolledClient) {
    return loadEnrollmentConnection({
      environment: input.environment,
      clientId: parseEnrollmentClientId(enrolledClient),
      nowMs: input.nowMs,
      explicit: true,
    });
  }
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
  // `--client` lists another client's work; identity is --enrolled-client or CODEXHOST_ENROLL_CLIENT.
  const fromEnv = input.environment[DELEGATION_ENROLL_CLIENT_ENV];
  return loadEnrollmentConnection({
    environment: input.environment,
    clientId: parseEnrollmentClientId(fromEnv ?? DEFAULT_ENROLLMENT_CLIENT_ID),
    nowMs: input.nowMs,
    explicit: Boolean(fromEnv),
  });
}

function enrollmentClientEndpoint(
  record: EnrollmentRecord,
  liveEndpoint: string | undefined,
): string {
  return record.networkScope === "tailnet" ? record.endpoint : (liveEndpoint ?? record.endpoint);
}

/** Live Runtime listen port from bootstrap; undefined if Runtime is down or unpublished. */
export async function readLiveEnrollmentEndpoint(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const bootstrap = await readEnrollmentBootstrap(enrollmentBootstrapPath(environment));
    return bootstrap.endpoint;
  } catch {
    return undefined;
  }
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
  let bootstrap: Awaited<ReturnType<typeof readEnrollmentBootstrap>> | undefined;
  let connection: CliRuntimeConnection;
  if (hostConnection) {
    connection = hostConnection;
  } else {
    bootstrap = await readEnrollmentBootstrap(enrollmentBootstrapPath(input.environment));
    connection = {
      endpoint: bootstrap.endpoint,
      token: bootstrap.bootstrapToken,
      source: "enrollment",
    };
  }
  const pairing = enrollPairingFromOptions(input.parsed.options);
  const issued = (await input.request(
    "/v1/enroll",
    {
      clientId,
      executablePath,
      allowlist,
      pairing,
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
  if ((issued.pairing ?? "session") !== pairing) {
    throw enrollmentError(
      "ENROLLMENT_INVALID",
      "Host issued a different enrollment pairing",
      "pairing_mismatch",
    );
  }
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
  view: ReturnType<typeof publicEnrollmentView> & {
    storePath: string;
    authentication: ReturnType<typeof inspectCliAuthentication>;
  };
  storePath: string;
}> {
  rejectEnrollmentAttackOptions(input.environment, input.parsed);
  const clientId = selectedEnrollmentClientId(input.parsed, input.environment);
  const storePath = enrollmentStorePath(input.environment, clientId);
  try {
    const [record, liveEndpoint] = await Promise.all([
      readEnrollmentStore(storePath, input.nowMs, clientId),
      readLiveEnrollmentEndpoint(input.environment),
    ]);
    if (!record) {
      throw enrollmentError(
        "ENROLLMENT_INVALID",
        "No enrollment store is present",
        "missing_store",
        {
          clientId,
          storePath,
        },
      );
    }
    const authentication = inspectCliAuthentication({
      environment: input.environment,
      parsed: input.parsed,
      clientId,
      enrollmentThreadId: record.threadId,
    });
    return {
      storePath,
      view: {
        ...publicEnrollmentView(record),
        endpoint: enrollmentClientEndpoint(record, liveEndpoint),
        storePath,
        authentication,
      },
    };
  } catch (error) {
    if (error instanceof DelegationControlError) {
      const authentication = inspectCliAuthentication({
        environment: input.environment,
        parsed: input.parsed,
        clientId,
      });
      const reason = error.details?.reason;
      const recovery = enrollmentRecovery(reason, clientId);
      throw new DelegationControlError(error.code, error.message, {
        ...error.details,
        clientId,
        storePath,
        authentication,
        ...(recovery ? { recovery } : {}),
      });
    }
    throw error;
  }
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
  const clientId = selectedEnrollmentClientId(input.parsed, input.environment);
  const storePath = enrollmentStorePath(input.environment, clientId);
  let record: EnrollmentRecord | undefined;
  let liveEndpoint: string | undefined;
  try {
    [record, liveEndpoint] = await Promise.all([
      readEnrollmentStore(storePath, input.nowMs, clientId),
      readLiveEnrollmentEndpoint(input.environment),
    ]);
  } catch (error) {
    annotateEnrollmentClientError(error, { clientId, storePath });
  }
  if (!record) {
    throw new DelegationControlError("ENROLLMENT_INVALID", "No enrollment store is present", {
      reason: "revoked",
      clientId,
      storePath,
    });
  }
  await input.request(
    "/v1/enroll/revoke",
    {},
    {
      endpoint: enrollmentClientEndpoint(record, liveEndpoint),
      token: record.token,
      source: "enrollment",
      callerThreadId: record.threadId,
    },
  );
  await deleteEnrollmentStore(storePath);
  return { enrollmentId: record.enrollmentId, revoked: true, storePath };
}
