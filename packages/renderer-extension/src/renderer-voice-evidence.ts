import {
  isIsolatedVoiceQualification,
  readCpaLiveVoiceHookConfig,
  type CpaLiveVoiceHookConfig,
} from "./renderer-cpa-live-voice-config.js";
import {
  hashedVoiceProfileSupported,
  legacyRetainedVoiceLanes,
  nativeChatVoiceUnavailableReason,
  profileIdentityKey,
  voiceImplementationRevision,
  voiceProfileDigest,
  workVoiceUnavailableReason,
} from "./renderer-voice-profiles.js";

export const VOICE_EVIDENCE_STAGES = [
  "structural",
  "activation",
  "connection",
  "identity",
  "speech",
  "cleanup",
] as const;

export type VoiceEvidenceStage = (typeof VOICE_EVIDENCE_STAGES)[number];

export type VoiceEvidenceOutcome = "pass" | "fail" | "incomplete" | "mismatch";

export type VoiceEvidencePath = "chat" | "work-codex" | "work-grok";

export type VoiceEvidencePolicy = "legacy-retained" | "reviewed";

export type VoiceEvidenceRecord = {
  profileKey: string;
  platform: string;
  desktopVersion: string;
  path: VoiceEvidencePath;
  implementationRevision: string;
  profileDigest: string;
  policy?: VoiceEvidencePolicy;
  desktopBuild?: string;
  asarDigest?: string;
  stages: Partial<Record<VoiceEvidenceStage, boolean>>;
  startAcknowledged?: boolean;
  connected?: boolean;
  conversationMatched?: boolean;
  harnessMatched?: boolean;
  gatewayOwned?: boolean;
  speech?: {
    attended: boolean;
    bothDirections: boolean;
    witness?: string;
    run?: string;
  };
  cleanup?: {
    ended: boolean;
    microphoneReleased: boolean;
  };
};

export type VoiceEvidenceEvaluation = {
  outcome: VoiceEvidenceOutcome;
  qualified: boolean;
  missing: VoiceEvidenceStage[];
  reason: string;
};

export type VoiceStartupPolicy = "reviewed" | "legacy-retained" | "unreviewed";

export type VoiceStartupPathDecision = {
  enabled: boolean;
  policy: VoiceStartupPolicy;
  reason?: string;
};

export type VoiceStartupGate = {
  chat: VoiceStartupPathDecision;
  "work-codex": VoiceStartupPathDecision;
  "work-grok": VoiceStartupPathDecision;
  work: VoiceStartupPathDecision;
};

const REQUIRED_STAGES: readonly VoiceEvidenceStage[] = VOICE_EVIDENCE_STAGES;

function recordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function missingStages(record: VoiceEvidenceRecord): VoiceEvidenceStage[] {
  return REQUIRED_STAGES.filter((stage) => record.stages[stage] !== true);
}

function productForPath(path: VoiceEvidencePath): "chat" | "work" {
  return path === "chat" ? "chat" : "work";
}

export function evaluateVoiceEvidence(record: VoiceEvidenceRecord): VoiceEvidenceEvaluation {
  const expectedKey = profileIdentityKey(
    productForPath(record.path),
    record.platform,
    record.desktopVersion,
  );
  if (record.profileKey !== expectedKey) {
    return {
      outcome: "mismatch",
      qualified: false,
      missing: missingStages(record),
      reason: "evidence-profile-mismatch",
    };
  }
  if (typeof record.implementationRevision !== "string" || record.implementationRevision === "") {
    return {
      outcome: "mismatch",
      qualified: false,
      missing: missingStages(record),
      reason: "missing-implementation-revision",
    };
  }
  if (
    record.policy !== "legacy-retained" &&
    record.implementationRevision !== voiceImplementationRevision()
  ) {
    return {
      outcome: "mismatch",
      qualified: false,
      missing: missingStages(record),
      reason: "implementation-revision-mismatch",
    };
  }
  if (record.policy !== "legacy-retained") {
    if (
      typeof record.desktopBuild !== "string" ||
      record.desktopBuild === "" ||
      typeof record.asarDigest !== "string" ||
      record.asarDigest === ""
    ) {
      return {
        outcome: "mismatch",
        qualified: false,
        missing: missingStages(record),
        reason: "missing-native-identity",
      };
    }
  }
  if (typeof record.profileDigest !== "string" || record.profileDigest === "") {
    return {
      outcome: "mismatch",
      qualified: false,
      missing: missingStages(record),
      reason: "missing-profile-digest",
    };
  }
  const expectedDigest = voiceProfileDigest(
    productForPath(record.path),
    record.platform,
    record.desktopVersion,
  );
  if (!expectedDigest || record.profileDigest !== expectedDigest) {
    return {
      outcome: "mismatch",
      qualified: false,
      missing: missingStages(record),
      reason: "stale-profile-digest",
    };
  }
  if (record.startAcknowledged === true && record.connected !== true) {
    return {
      outcome: "incomplete",
      qualified: false,
      missing: missingStages(record).length > 0 ? missingStages(record) : ["connection"],
      reason: "start-acknowledged-without-connection",
    };
  }
  if (record.path !== "chat" && record.gatewayOwned !== true && record.stages.connection === true) {
    return {
      outcome: "incomplete",
      qualified: false,
      missing: missingStages(record).length > 0 ? missingStages(record) : ["connection"],
      reason: "route-only-without-connected-gateway",
    };
  }
  if (record.speech?.attended === true && (!record.speech.witness || !record.speech.run)) {
    return {
      outcome: "incomplete",
      qualified: false,
      missing: missingStages(record).includes("speech") ? missingStages(record) : ["speech"],
      reason: "attended-speech-missing-provenance",
    };
  }
  if (record.speech && record.speech.attended !== true) {
    return {
      outcome: "incomplete",
      qualified: false,
      missing: missingStages(record),
      reason: "synthetic-speech-is-not-qualification",
    };
  }
  const missing = missingStages(record);
  if (missing.length > 0) {
    return {
      outcome: "incomplete",
      qualified: false,
      missing,
      reason: `missing:${missing.join(",")}`,
    };
  }
  if (
    record.connected !== true ||
    record.conversationMatched !== true ||
    (record.path === "chat"
      ? record.harnessMatched !== undefined && record.harnessMatched !== true
      : record.harnessMatched !== true) ||
    record.speech?.attended !== true ||
    record.speech.bothDirections !== true ||
    record.cleanup?.ended !== true ||
    record.cleanup.microphoneReleased !== true
  ) {
    return {
      outcome: "fail",
      qualified: false,
      missing: [],
      reason: "required-assertions-failed",
    };
  }
  return { outcome: "pass", qualified: true, missing: [], reason: "qualified" };
}

function evidenceMatchesRuntime(
  record: VoiceEvidenceRecord,
  config: {
    desktopVersion?: string;
    desktopPlatform?: string;
    desktopBuild?: string;
    asarDigest?: string;
    implementationRevision?: string;
  },
): boolean {
  if (record.platform !== config.desktopPlatform) return false;
  if (record.desktopVersion !== config.desktopVersion) return false;
  if (record.implementationRevision !== config.implementationRevision) return false;
  if (record.policy === "legacy-retained") return true;
  if (
    typeof record.desktopBuild !== "string" ||
    record.desktopBuild === "" ||
    typeof record.asarDigest !== "string" ||
    record.asarDigest === "" ||
    typeof config.desktopBuild !== "string" ||
    config.desktopBuild === "" ||
    typeof config.asarDigest !== "string" ||
    config.asarDigest === "" ||
    typeof config.implementationRevision !== "string" ||
    config.implementationRevision === ""
  ) {
    return false;
  }
  return record.desktopBuild === config.desktopBuild && record.asarDigest === config.asarDigest;
}

function isolatedQualificationMatches(
  path: VoiceEvidencePath,
  config: CpaLiveVoiceHookConfig,
): boolean {
  const isolated = config.isolatedQualification;
  if (!isIsolatedVoiceQualification(isolated) || isolated.path !== path) return false;
  if (Date.parse(isolated.expiresAt) <= Date.now()) return false;
  return (
    isolated.desktopVersion === config.desktopVersion &&
    isolated.desktopBuild === config.desktopBuild &&
    isolated.asarDigest === config.asarDigest &&
    isolated.appPath === config.desktopAppPath &&
    isolated.implementationRevision === config.implementationRevision &&
    typeof config.desktopBuild === "string" &&
    config.desktopBuild !== "" &&
    typeof config.asarDigest === "string" &&
    config.asarDigest !== "" &&
    typeof config.desktopAppPath === "string" &&
    config.desktopAppPath !== "" &&
    typeof config.implementationRevision === "string" &&
    config.implementationRevision !== ""
  );
}

function unsupportedReason(path: VoiceEvidencePath, config: CpaLiveVoiceHookConfig): string {
  if (path === "chat") {
    return (
      nativeChatVoiceUnavailableReason(config) ?? "Chat voice is not qualified on this Desktop."
    );
  }
  return workVoiceUnavailableReason(config) ?? "Work voice is not qualified on this Desktop.";
}

function decidePath(
  path: VoiceEvidencePath,
  config: CpaLiveVoiceHookConfig,
  records: readonly VoiceEvidenceRecord[],
): VoiceStartupPathDecision {
  if (!config.desktopVersion || !config.desktopPlatform) {
    return { enabled: false, policy: "unreviewed", reason: "waiting-for-identity" };
  }
  const pathRecords = records.filter((record) => record.path === path);
  if (pathRecords.length > 0) {
    const matching = pathRecords.filter((record) => evidenceMatchesRuntime(record, config));
    if (matching.length === 0) {
      return { enabled: false, policy: "unreviewed", reason: "stale-or-wrong-platform-evidence" };
    }
    for (const record of matching) {
      const evaluation = evaluateVoiceEvidence(record);
      if (!evaluation.qualified) {
        return { enabled: false, policy: "unreviewed", reason: evaluation.reason };
      }
    }
    const record = matching[0];
    if (!record) {
      return { enabled: false, policy: "unreviewed", reason: "missing-evidence" };
    }
    return {
      enabled: true,
      policy: record.policy === "legacy-retained" ? "legacy-retained" : "reviewed",
    };
  }
  const digest = voiceProfileDigest(
    productForPath(path),
    config.desktopPlatform,
    config.desktopVersion,
  );
  if (!digest) {
    return { enabled: false, policy: "unreviewed", reason: unsupportedReason(path, config) };
  }
  const legacy = legacyRetainedVoiceLanes().find(
    (lane) =>
      lane.path === path &&
      lane.platform === config.desktopPlatform &&
      lane.version === config.desktopVersion,
  );
  if (legacy) {
    return {
      enabled: true,
      policy: "legacy-retained",
      reason: "legacy-retained-named-profile",
    };
  }
  if (isolatedQualificationMatches(path, config)) {
    return {
      enabled: true,
      policy: "unreviewed",
      reason: "isolated-qualification",
    };
  }
  return { enabled: false, policy: "unreviewed", reason: "missing-evidence" };
}

export function isVoiceEvidenceRecord(value: unknown): value is VoiceEvidenceRecord {
  if (!recordObject(value)) return false;
  return (
    typeof value.profileKey === "string" &&
    typeof value.platform === "string" &&
    typeof value.desktopVersion === "string" &&
    typeof value.implementationRevision === "string" &&
    typeof value.profileDigest === "string" &&
    (value.path === "chat" || value.path === "work-codex" || value.path === "work-grok") &&
    recordObject(value.stages)
  );
}

export function voiceEvidenceRecordsFromConfig(
  config: CpaLiveVoiceHookConfig,
): VoiceEvidenceRecord[] {
  return (config.voiceEvidence ?? []).filter(isVoiceEvidenceRecord);
}

export function startupVoiceGate(
  config: CpaLiveVoiceHookConfig & { evidence?: VoiceEvidenceRecord },
): VoiceStartupGate {
  const records = [
    ...voiceEvidenceRecordsFromConfig(config),
    ...(config.evidence && isVoiceEvidenceRecord(config.evidence) ? [config.evidence] : []),
  ];
  const chat = decidePath("chat", config, records);
  const workCodex = decidePath("work-codex", config, records);
  const workGrok = decidePath("work-grok", config, records);
  return {
    chat,
    "work-codex": workCodex,
    "work-grok": workGrok,
    work: workCodex,
  };
}

export function chatVoiceQualified(config: CpaLiveVoiceHookConfig): boolean {
  return startupVoiceGate(config).chat.enabled;
}

export function workVoiceLaneEnabledOnConfig(
  config: CpaLiveVoiceHookConfig,
  path: "work-codex" | "work-grok",
): boolean {
  return startupVoiceGate(config)[path].enabled;
}

export function workVoiceLaneEnabled(owner: object, path: "work-codex" | "work-grok"): boolean {
  const config = readCpaLiveVoiceHookConfig(owner);
  return config ? workVoiceLaneEnabledOnConfig(config, path) : false;
}

export function chatVoiceQualifiedOnOwner(owner: object): boolean {
  const config = readCpaLiveVoiceHookConfig(owner);
  return config ? chatVoiceQualified(config) : false;
}

export function projectVoiceAuditObservation(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
  desktopBuild?: string;
  asarDigest?: string;
  voiceEvidence?: readonly VoiceEvidenceRecord[];
}): {
  reviewedChat: boolean;
  reviewedWork: boolean;
  hashedChat: boolean;
  discoveryRun: 0 | 1;
} {
  const gate = startupVoiceGate({
    enabled: true,
    auditedDesktopVersion: "",
    auditedAppInitialAsset: "",
    ...(config.desktopVersion === undefined ? {} : { desktopVersion: config.desktopVersion }),
    ...(config.desktopPlatform === undefined ? {} : { desktopPlatform: config.desktopPlatform }),
    ...(config.desktopBuild === undefined ? {} : { desktopBuild: config.desktopBuild }),
    ...(config.asarDigest === undefined ? {} : { asarDigest: config.asarDigest }),
    ...(config.voiceEvidence === undefined ? {} : { voiceEvidence: [...config.voiceEvidence] }),
  });
  return {
    reviewedChat: gate.chat.enabled,
    reviewedWork: gate["work-codex"].enabled || gate["work-grok"].enabled,
    hashedChat: hashedVoiceProfileSupported(config),
    discoveryRun: 0,
  };
}
