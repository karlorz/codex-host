import { selectVoiceAssets } from "./renderer-voice-assets.js";
import {
  CHAT_SEMANTIC_ROLE_MATCHERS,
  CLIENT_OWNED_VOICE_ASSETS,
  HASHED_NATIVE_CHAT_PREWARM_ASSET,
  HASHED_NATIVE_CHAT_ROLES,
  HASHED_NATIVE_CHAT_SEMANTIC_ANCHORS,
  HASHED_NATIVE_CHAT_START_ASSET,
  HASHED_OVERLAY_VOICE_ROLES,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
  NATIVE_CHAT_VOICE_ASSETS,
  NATIVE_CHAT_VOICE_CHUNKS,
  WORK_SEMANTIC_ROLE_MATCHERS,
  hashedVoiceProfileSupported,
  profileIdentityKey,
  type NativeChatNamedProfile,
  type VoiceSemanticRoleMatcher,
} from "./renderer-voice-profiles.js";

export type VoiceDiscoveryIssueCode =
  | "missing-assets"
  | "incomplete-graph"
  | "ambiguous-roles"
  | "incompatible-contract"
  | "stale-inventory"
  | "wrong-role"
  | "missing-loader"
  | "wrong-platform"
  | "digest-mismatch";

export type VoiceDiscoveryIssue = {
  code: VoiceDiscoveryIssueCode;
  details: readonly string[];
};

export type VoiceCandidateKind =
  "named-chat" | "hashed-chat" | "work" | "semantic-chat" | "semantic-work" | "unknown";

export type VoiceSourceRecord = {
  id?: string;
  path?: string;
  digest?: string;
  literals?: readonly string[];
  callees?: readonly string[];
  imports?: readonly string[];
  exports?: readonly string[];
  brands?: readonly string[];
  text?: string;
  interpretationProvenance?: "bytes-verified" | "snapshot-assertion";
};

export type VoiceSourceInventory = {
  platform?: string;
  desktopVersion?: string;
  desktopBuild?: string;
  bundleDigest?: string;
  asarDigest?: string;
  assets: readonly string[];
  moduleIds?: readonly string[];
  sources?: readonly VoiceSourceRecord[];
  fingerprint?: string;
};

export type VoiceSourceInterpretation =
  "bytes-verified" | "snapshot-assertion" | "unvalidated-with-bytes";

export type VoiceInventoryInterpretation = VoiceSourceInterpretation | "mixed";

export type VoiceCandidateDescriptor = {
  kind: VoiceCandidateKind;
  identity: {
    product: "chat" | "work" | "unknown";
    platform?: string;
    version?: string;
    fingerprint: string;
    profileKey?: string;
    interpretation: VoiceInventoryInterpretation;
  };
  issues: VoiceDiscoveryIssue[];
  activation: "candidate" | "rejected";
  roles?: Readonly<Record<string, string>>;
};

function assetName(value: string): string {
  const parts = value.split(/[/\\]/u);
  return parts[parts.length - 1] ?? value;
}

function assetUrls(assets: readonly string[]): string[] {
  return assets.map((asset) => {
    const name = assetName(asset);
    return asset.includes("://") ? asset : `app://-/assets/${name}`;
  });
}

function fnv1aHex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function sortedStrings(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function sourceInterpretation(source: VoiceSourceRecord): VoiceSourceInterpretation {
  if (source.interpretationProvenance === "bytes-verified") return "bytes-verified";
  if (source.interpretationProvenance === "snapshot-assertion") return "snapshot-assertion";
  return typeof source.text === "string" ? "unvalidated-with-bytes" : "snapshot-assertion";
}

export function sourceFingerprint(source: VoiceSourceRecord): {
  id: string;
  path: string;
  digest: string;
  provenance: "bytes" | "digest-only" | "structure" | "digest-mismatch";
  interpretation: VoiceSourceInterpretation;
  literals: string[];
  callees: string[];
  imports: string[];
  exports: string[];
  brands: string[];
} {
  const structure = {
    literals: sortedStrings(source.literals),
    callees: sortedStrings(source.callees),
    imports: sortedStrings(source.imports),
    exports: sortedStrings(source.exports),
    brands: sortedStrings(source.brands),
  };
  const id = source.id ?? "";
  const filePath = source.path ?? "";
  const interpretation = sourceInterpretation(source);
  if (typeof source.text === "string") {
    const digest = fnv1aHex(source.text);
    const provenance =
      typeof source.digest === "string" && source.digest.length > 0 && source.digest !== digest
        ? ("digest-mismatch" as const)
        : ("bytes" as const);
    return { id, path: filePath, digest, provenance, interpretation, ...structure };
  }
  if (typeof source.digest === "string" && source.digest.length > 0) {
    return {
      id,
      path: filePath,
      digest: source.digest,
      provenance: "digest-only",
      interpretation,
      ...structure,
    };
  }
  return {
    id,
    path: filePath,
    digest: fnv1aHex(JSON.stringify(structure)),
    provenance: "structure",
    interpretation,
    ...structure,
  };
}

export function fingerprintVoiceInventory(inventory: VoiceSourceInventory): string {
  const sources = [...(inventory.sources ?? [])]
    .map((source) => sourceFingerprint(source))
    .sort((left, right) => `${left.path}\0${left.id}`.localeCompare(`${right.path}\0${right.id}`));
  return fnv1aHex(
    JSON.stringify({
      platform: inventory.platform ?? "",
      desktopVersion: inventory.desktopVersion ?? "",
      desktopBuild: inventory.desktopBuild ?? "",
      bundleDigest: inventory.bundleDigest ?? "",
      asarDigest: inventory.asarDigest ?? "",
      assets: [...inventory.assets.map(assetName)].sort(),
      moduleIds: [...(inventory.moduleIds ?? [])].sort(),
      sources,
    }),
  );
}

function sourceDigestIssues(inventory: VoiceSourceInventory): VoiceDiscoveryIssue[] {
  const mismatched = (inventory.sources ?? [])
    .map((source) => sourceFingerprint(source))
    .filter((source) => source.provenance === "digest-mismatch")
    .map((source) => source.path || source.id);
  return mismatched.length > 0 ? [issue("digest-mismatch", mismatched)] : [];
}

function issue(
  code: VoiceDiscoveryIssueCode,
  details: readonly string[] = [],
): VoiceDiscoveryIssue {
  return { code, details };
}

function sourceOwnsAnchor(source: VoiceSourceRecord, anchor: string): boolean {
  return (
    (source.callees ?? []).includes(anchor) ||
    (source.exports ?? []).includes(anchor) ||
    (source.brands ?? []).includes(anchor)
  );
}

function uniqueAnchorHits(sources: readonly VoiceSourceRecord[], anchor: string): number {
  return sources.filter((source) => sourceOwnsAnchor(source, anchor)).length;
}

function sourceOwnsMatcher(source: VoiceSourceRecord, matcher: VoiceSemanticRoleMatcher): boolean {
  const callees = source.callees ?? [];
  const exported = source.exports ?? [];
  const brands = source.brands ?? [];
  const calleeHit =
    matcher.callees.length === 0 || matcher.callees.some((name) => callees.includes(name));
  const exportHit =
    matcher.exports.length === 0 || matcher.exports.some((name) => exported.includes(name));
  const brandHit =
    matcher.brands.length === 0 || matcher.brands.some((name) => brands.includes(name));
  const groups = [
    ...(matcher.callees.length > 0 ? [calleeHit] : []),
    ...(matcher.exports.length > 0 ? [exportHit] : []),
    ...(matcher.brands.length > 0 ? [brandHit] : []),
  ];
  if (groups.length === 0) return false;
  return matcher.mode === "all" ? groups.every(Boolean) : groups.some(Boolean);
}

function mapSemanticRoles(
  inventory: VoiceSourceInventory,
  matchers: readonly VoiceSemanticRoleMatcher[],
): { roles: Record<string, string>; issues: VoiceDiscoveryIssue[] } {
  const roles: Record<string, string> = {};
  const issues: VoiceDiscoveryIssue[] = [];
  for (const matcher of matchers) {
    const hits = (inventory.sources ?? []).filter((source) => sourceOwnsMatcher(source, matcher));
    if (hits.length === 0) issues.push(issue("wrong-role", [matcher.role]));
    else if (hits.length > 1) issues.push(issue("ambiguous-roles", [matcher.role]));
    else {
      const owner = hits[0];
      roles[matcher.role] = owner?.path || owner?.id || matcher.role;
    }
  }
  return { roles, issues };
}

function hashedRoleIssues(inventory: VoiceSourceInventory): VoiceDiscoveryIssue[] {
  const issues: VoiceDiscoveryIssue[] = [];
  const names = inventory.assets.map(assetName);
  const missing: string[] = [];
  if (!names.some((name) => name === HASHED_WEBPACK_VOICE_RUNTIME_ASSET)) {
    missing.push(HASHED_WEBPACK_VOICE_RUNTIME_ASSET);
  }
  if (!names.some((name) => name === HASHED_NATIVE_CHAT_START_ASSET)) {
    missing.push(HASHED_NATIVE_CHAT_START_ASSET);
  }
  if (!names.some((name) => name === HASHED_NATIVE_CHAT_PREWARM_ASSET)) {
    missing.push(HASHED_NATIVE_CHAT_PREWARM_ASSET);
  }
  if (missing.length > 0) issues.push(issue("missing-assets", missing));
  const moduleIds = new Set(inventory.moduleIds ?? []);
  if (moduleIds.size > 0) {
    const required = [
      HASHED_NATIVE_CHAT_ROLES.startModuleId,
      HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
      HASHED_NATIVE_CHAT_ROLES.runtimeModuleId,
      HASHED_OVERLAY_VOICE_ROLES.fetchFactoryId,
    ];
    const absent = required.filter((id) => !moduleIds.has(id));
    if (absent.length > 0) issues.push(issue("incomplete-graph", absent));
  }
  const sources = inventory.sources ?? [];
  if (sources.length > 0) {
    const ambiguous = HASHED_NATIVE_CHAT_SEMANTIC_ANCHORS.filter(
      (anchor) => uniqueAnchorHits(sources, anchor) > 1,
    );
    const missingAnchors = HASHED_NATIVE_CHAT_SEMANTIC_ANCHORS.filter(
      (anchor) => uniqueAnchorHits(sources, anchor) === 0,
    );
    if (ambiguous.length > 0) issues.push(issue("ambiguous-roles", ambiguous));
    if (missingAnchors.length > 0) issues.push(issue("wrong-role", missingAnchors));
  }
  const chunkIds = inventory.moduleIds?.filter((id) => /^\d+$/u.test(id)).map((id) => Number(id));
  if (chunkIds && chunkIds.length > 0) {
    const missingChunks = NATIVE_CHAT_VOICE_CHUNKS.filter((chunk) => !chunkIds.includes(chunk));
    if (missingChunks.length === NATIVE_CHAT_VOICE_CHUNKS.length) {
      issues.push(issue("missing-loader", ["native-chunk-loader"]));
    } else if (missingChunks.length > 0) {
      issues.push(issue("incomplete-graph", missingChunks.map(String)));
    }
  }
  return issues;
}

function namedChatIssues(
  inventory: VoiceSourceInventory,
  profile: NativeChatNamedProfile | undefined,
): VoiceDiscoveryIssue[] {
  if (!profile) {
    return [issue("incompatible-contract", ["named-chat-profile"])];
  }
  const names = inventory.assets.map(assetName);
  const required = [profile.initial, profile.shared, profile.start, profile.prewarm];
  const missing = required.filter((asset) => !names.includes(asset));
  const issues: VoiceDiscoveryIssue[] = [];
  if (missing.length > 0) issues.push(issue("missing-assets", missing));
  if (inventory.platform && inventory.platform !== profile.platform) {
    issues.push(issue("wrong-platform", [profile.platform]));
  }
  return issues;
}

function optionalIdentity(
  platform: string | undefined,
  version: string | undefined,
): { platform?: string; version?: string } {
  return {
    ...(platform === undefined ? {} : { platform }),
    ...(version === undefined ? {} : { version }),
  };
}

function inventoryInterpretation(inventory: VoiceSourceInventory): VoiceInventoryInterpretation {
  const sources = inventory.sources ?? [];
  if (sources.length === 0) return "snapshot-assertion";
  const values = new Set(sources.map((source) => sourceFingerprint(source).interpretation));
  if (values.size === 1) {
    const [value] = values;
    return value ?? "snapshot-assertion";
  }
  return "mixed";
}

function candidateIdentity(
  product: "chat" | "work" | "unknown",
  inventory: VoiceSourceInventory,
  fingerprint: string,
  extras: {
    platform?: string | undefined;
    version?: string | undefined;
    profileKey?: string | undefined;
  } = {},
): VoiceCandidateDescriptor["identity"] {
  return {
    product,
    ...optionalIdentity(
      extras.platform ?? inventory.platform,
      extras.version ?? inventory.desktopVersion,
    ),
    fingerprint,
    interpretation: inventoryInterpretation(inventory),
    ...(extras.profileKey === undefined ? {} : { profileKey: extras.profileKey }),
  };
}

function workIssues(inventory: VoiceSourceInventory): VoiceDiscoveryIssue[] {
  const profile = selectVoiceAssets(
    CLIENT_OWNED_VOICE_ASSETS,
    assetUrls(inventory.assets),
    inventory.desktopVersion,
    inventory.platform,
  );
  if (!profile) return [issue("incompatible-contract", ["work-profile"])];
  const names = inventory.assets.map(assetName);
  const required = [profile.initial, profile.shared, profile.overlay];
  const missing = required.filter((asset) => !names.includes(asset));
  return missing.length > 0 ? [issue("missing-assets", missing)] : [];
}

function knownHashedAssetsPresent(names: readonly string[]): boolean {
  return (
    names.includes(HASHED_WEBPACK_VOICE_RUNTIME_ASSET) &&
    names.includes(HASHED_NATIVE_CHAT_START_ASSET) &&
    names.includes(HASHED_NATIVE_CHAT_PREWARM_ASSET)
  );
}

function semanticDescriptor(
  kind: "semantic-chat" | "semantic-work",
  inventory: VoiceSourceInventory,
  fingerprint: string,
  mapped: { roles: Record<string, string>; issues: VoiceDiscoveryIssue[] },
): VoiceCandidateDescriptor {
  const product = kind === "semantic-chat" ? "chat" : "work";
  return {
    kind,
    identity: candidateIdentity(product, inventory, fingerprint),
    issues: mapped.issues,
    activation: mapped.issues.length === 0 ? "candidate" : "rejected",
    ...(Object.keys(mapped.roles).length > 0 ? { roles: mapped.roles } : {}),
  };
}

/** Structural similarity produces a candidate. It never activates a profile. */
export function discoverVoiceCandidate(inventory: VoiceSourceInventory): VoiceCandidateDescriptor {
  const fingerprint = inventory.fingerprint ?? fingerprintVoiceInventory(inventory);
  if (inventory.fingerprint && inventory.fingerprint !== fingerprintVoiceInventory(inventory)) {
    return {
      kind: "unknown",
      identity: candidateIdentity("unknown", inventory, fingerprint),
      issues: [issue("stale-inventory", [inventory.fingerprint])],
      activation: "rejected",
    };
  }
  const digestIssues = sourceDigestIssues(inventory);
  if (digestIssues.length > 0) {
    return {
      kind: "unknown",
      identity: candidateIdentity("unknown", inventory, fingerprint),
      issues: digestIssues,
      activation: "rejected",
    };
  }
  const names = inventory.assets.map(assetName);
  const hashed = hashedVoiceProfileSupported({
    ...(inventory.desktopVersion === undefined ? {} : { desktopVersion: inventory.desktopVersion }),
    ...(inventory.platform === undefined ? {} : { desktopPlatform: inventory.platform }),
  });
  const workOverlay = CLIENT_OWNED_VOICE_ASSETS.some((profile) => names.includes(profile.overlay));
  const chatStartOrPrewarm = NATIVE_CHAT_VOICE_ASSETS.some(
    (profile) => names.includes(profile.start) || names.includes(profile.prewarm),
  );
  const knownHashedName =
    names.includes(HASHED_WEBPACK_VOICE_RUNTIME_ASSET) ||
    names.includes(HASHED_NATIVE_CHAT_START_ASSET) ||
    names.includes(HASHED_NATIVE_CHAT_PREWARM_ASSET);
  if (hashed || knownHashedName) {
    if (knownHashedAssetsPresent(names)) {
      const issues = hashedRoleIssues(inventory);
      if (!hashed) issues.push(issue("wrong-platform", [HASHED_WEBPACK_VOICE_VERSION]));
      return {
        kind: "hashed-chat",
        identity: candidateIdentity("chat", inventory, fingerprint, {
          version: inventory.desktopVersion ?? HASHED_WEBPACK_VOICE_VERSION,
          profileKey: profileIdentityKey(
            "chat",
            inventory.platform,
            inventory.desktopVersion ?? HASHED_WEBPACK_VOICE_VERSION,
          ),
        }),
        issues,
        activation: issues.length === 0 ? "candidate" : "rejected",
      };
    }
    const renamed = mapSemanticRoles(inventory, CHAT_SEMANTIC_ROLE_MATCHERS);
    if (renamed.issues.length === 0 && Object.keys(renamed.roles).length > 0) {
      return semanticDescriptor("semantic-chat", inventory, fingerprint, renamed);
    }
    if (knownHashedName) {
      const issues = hashedRoleIssues(inventory);
      if (!hashed) issues.push(issue("wrong-platform", [HASHED_WEBPACK_VOICE_VERSION]));
      return {
        kind: "hashed-chat",
        identity: candidateIdentity("chat", inventory, fingerprint, {
          version: inventory.desktopVersion ?? HASHED_WEBPACK_VOICE_VERSION,
          profileKey: profileIdentityKey(
            "chat",
            inventory.platform,
            inventory.desktopVersion ?? HASHED_WEBPACK_VOICE_VERSION,
          ),
        }),
        issues,
        activation: "rejected",
      };
    }
  }
  if (workOverlay && !chatStartOrPrewarm) {
    const issues = workIssues(inventory);
    const work = selectVoiceAssets(
      CLIENT_OWNED_VOICE_ASSETS,
      assetUrls(inventory.assets),
      inventory.desktopVersion,
      inventory.platform,
    );
    return {
      kind: "work",
      identity: candidateIdentity("work", inventory, fingerprint, {
        platform: work?.platform ?? inventory.platform,
        version: work?.version ?? inventory.desktopVersion,
        profileKey: profileIdentityKey(
          "work",
          work?.platform ?? inventory.platform,
          work?.version ?? inventory.desktopVersion,
        ),
      }),
      issues,
      activation: issues.length === 0 ? "candidate" : "rejected",
    };
  }
  const named = selectVoiceAssets(
    NATIVE_CHAT_VOICE_ASSETS,
    assetUrls(inventory.assets),
    inventory.desktopVersion,
    inventory.platform,
  );
  if (named) {
    const issues = namedChatIssues(inventory, named);
    return {
      kind: "named-chat",
      identity: candidateIdentity("chat", inventory, fingerprint, {
        platform: named.platform,
        version: named.version,
        profileKey: profileIdentityKey("chat", named.platform, named.version),
      }),
      issues,
      activation: issues.length === 0 ? "candidate" : "rejected",
    };
  }
  const work = selectVoiceAssets(
    CLIENT_OWNED_VOICE_ASSETS,
    assetUrls(inventory.assets),
    inventory.desktopVersion,
    inventory.platform,
  );
  if (work) {
    const issues = workIssues(inventory);
    return {
      kind: "work",
      identity: candidateIdentity("work", inventory, fingerprint, {
        platform: work.platform,
        version: work.version,
        profileKey: profileIdentityKey("work", work.platform, work.version),
      }),
      issues,
      activation: issues.length === 0 ? "candidate" : "rejected",
    };
  }
  const chatSemantic = mapSemanticRoles(inventory, CHAT_SEMANTIC_ROLE_MATCHERS);
  const workSemantic = mapSemanticRoles(inventory, WORK_SEMANTIC_ROLE_MATCHERS);
  const chatReady = chatSemantic.issues.length === 0 && Object.keys(chatSemantic.roles).length > 0;
  const workReady = workSemantic.issues.length === 0 && Object.keys(workSemantic.roles).length > 0;
  if (chatReady && workReady) {
    return {
      kind: "unknown",
      identity: candidateIdentity("unknown", inventory, fingerprint),
      issues: [issue("ambiguous-roles", ["chat", "work"])],
      activation: "rejected",
    };
  }
  if (chatReady) return semanticDescriptor("semantic-chat", inventory, fingerprint, chatSemantic);
  if (workReady) return semanticDescriptor("semantic-work", inventory, fingerprint, workSemantic);
  if ((inventory.sources ?? []).length > 0) {
    return {
      kind: "unknown",
      identity: candidateIdentity("unknown", inventory, fingerprint),
      issues: [...chatSemantic.issues, ...workSemantic.issues],
      activation: "rejected",
    };
  }
  return {
    kind: "unknown",
    identity: candidateIdentity("unknown", inventory, fingerprint),
    issues: [issue("incompatible-contract", ["unknown-build"])],
    activation: "rejected",
  };
}

export function replayVoiceDiscovery(
  inventory: VoiceSourceInventory,
  expectedFingerprint: string,
): VoiceCandidateDescriptor {
  const actual = fingerprintVoiceInventory(inventory);
  if (actual !== expectedFingerprint) {
    return {
      kind: "unknown",
      identity: candidateIdentity("unknown", inventory, actual),
      issues: [issue("stale-inventory", [expectedFingerprint, actual])],
      activation: "rejected",
    };
  }
  return discoverVoiceCandidate({ ...inventory, fingerprint: expectedFingerprint });
}
