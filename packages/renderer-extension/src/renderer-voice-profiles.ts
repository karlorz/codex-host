import { VOICE_IMPLEMENTATION_REVISION } from "./renderer-voice-implementation-revision.generated.js";

/** Audited Desktop voice identities. Discovery never modifies or activates this registry. */

export const NATIVE_CHAT_VOICE_VERSION = "26.1027.61615";
const NATIVE_CHAT_INITIAL_ASSET = "app-initial-18b189e867e7.js";
const START_ASSET = "start-voice-221a396d38a5.js";

export type VoicePlatform = "darwin" | "win32";

export interface NativeChatNamedRoles {
  initializeFrom: "primary" | "initial";
  initialize: string;
  startShape: "module" | "entityBusiness";
  startT?: string;
  startN?: string;
  voiceSessionSelector: string;
  reactFactory: string;
  reactDomFactory: string;
  prewarmController: "VoiceInstantConnectCacheController";
  initial: {
    MOr: string;
    CDr: string;
    B1n: string;
    SPn: string;
    oTFrom: "primary" | "initial";
    oT: string;
    aTFrom: "primary" | "initial";
    aT: string;
    Ycr: string;
    Nir: string;
    n0n: string;
    Y1n: string;
    HJt: string;
  };
  shared: {
    Qst: string;
    FBt: string;
    PNt: string;
    Vot: string;
  };
}

export interface NativeChatNamedProfile {
  platform: VoicePlatform;
  version: string;
  initial: string;
  shared: string;
  primary?: string;
  start: string;
  prewarm: string;
  settings?: string;
  roles: NativeChatNamedRoles;
}

const BASELINE_NAMED_CHAT_ROLES: NativeChatNamedRoles = {
  initializeFrom: "initial",
  initialize: "oT",
  startShape: "module",
  voiceSessionSelector: "SPn",
  reactFactory: "FBt",
  reactDomFactory: "PNt",
  prewarmController: "VoiceInstantConnectCacheController",
  initial: {
    MOr: "MOr",
    CDr: "CDr",
    B1n: "B1n",
    SPn: "SPn",
    oTFrom: "initial",
    oT: "oT",
    aTFrom: "initial",
    aT: "aT",
    Ycr: "Ycr",
    Nir: "Nir",
    n0n: "n0n",
    Y1n: "Y1n",
    HJt: "HJt",
  },
  shared: { Qst: "Qst", FBt: "FBt", PNt: "PNt", Vot: "Vot" },
};

const NAMED_CHAT_ROLES_26_1027_61615: NativeChatNamedRoles = {
  initializeFrom: "primary",
  initialize: "Qp",
  startShape: "module",
  voiceSessionSelector: "etn",
  reactFactory: "pWt",
  reactDomFactory: "GFt",
  prewarmController: "VoiceInstantConnectCacheController",
  initial: {
    MOr: "p5n",
    CDr: "w6n",
    B1n: "_On",
    SPn: "etn",
    oTFrom: "primary",
    oT: "Qp",
    aTFrom: "primary",
    aT: "Zp",
    Ycr: "ofr",
    Nir: "yEn",
    n0n: "FOn",
    Y1n: "JOn",
    HJt: "Z6",
  },
  shared: { Qst: "klt", FBt: "pWt", PNt: "GFt", Vot: "_ct" },
};

const NAMED_CHAT_ROLES_26_1027_30824: NativeChatNamedRoles = {
  initializeFrom: "primary",
  initialize: "Yp",
  startShape: "module",
  voiceSessionSelector: "Xen",
  reactFactory: "pWt",
  reactDomFactory: "GFt",
  prewarmController: "VoiceInstantConnectCacheController",
  initial: {
    MOr: "l5n",
    CDr: "b6n",
    B1n: "pOn",
    SPn: "Xen",
    oTFrom: "primary",
    oT: "Yp",
    aTFrom: "primary",
    aT: "Jp",
    Ycr: "nfr",
    Nir: "hEn",
    n0n: "jOn",
    Y1n: "wOn",
    HJt: "J6",
  },
  shared: { Qst: "klt", FBt: "pWt", PNt: "GFt", Vot: "_ct" },
};

const NAMED_CHAT_ROLES_26_1023_51421: NativeChatNamedRoles = {
  initializeFrom: "primary",
  initialize: "gm",
  startShape: "module",
  voiceSessionSelector: "s$t",
  reactFactory: "OHt",
  reactDomFactory: "wPt",
  prewarmController: "VoiceInstantConnectCacheController",
  initial: {
    MOr: "x1n",
    CDr: "MQn",
    B1n: "Opn",
    SPn: "s$t",
    oTFrom: "primary",
    oT: "gm",
    aTFrom: "primary",
    aT: "hm",
    Ycr: "Zir",
    Nir: "ejn",
    n0n: "Kpn",
    Y1n: "zpn",
    HJt: "k3",
  },
  shared: { Qst: "uct", FBt: "OHt", PNt: "wPt", Vot: "ast" },
};

const NAMED_CHAT_ROLES_26_1021_31345: NativeChatNamedRoles = {
  initializeFrom: "primary",
  initialize: "um",
  startShape: "entityBusiness",
  startT: "r",
  startN: "i",
  voiceSessionSelector: "qXt",
  reactFactory: "XVt",
  reactDomFactory: "KNt",
  prewarmController: "VoiceInstantConnectCacheController",
  initial: {
    MOr: "CQn",
    CDr: "PXn",
    B1n: "tdn",
    SPn: "qXt",
    oTFrom: "primary",
    oT: "um",
    aTFrom: "primary",
    aT: "lm",
    Ycr: "Xkn",
    Nir: "yAn",
    n0n: "ydn",
    Y1n: "fdn",
    HJt: "R2",
  },
  shared: { Qst: "Bst", FBt: "XVt", PNt: "KNt", Vot: "Fot" },
};

export const NATIVE_CHAT_VOICE_ASSETS: readonly NativeChatNamedProfile[] = [
  {
    platform: "darwin",
    version: NATIVE_CHAT_VOICE_VERSION,
    initial: NATIVE_CHAT_INITIAL_ASSET,
    shared: "app-shared-601019a330d7.js",
    primary: "app-primary-75d53eef2374.js",
    start: START_ASSET,
    prewarm: "voice-prewarm-a7cd5160219e.js",
    settings: "voice-settings-320cf1212f2c.js",
    roles: NAMED_CHAT_ROLES_26_1027_61615,
  },
  {
    platform: "darwin",
    version: "26.1027.30824",
    initial: "app-initial-60f141238751.js",
    shared: "app-shared-7815d5a1a42a.js",
    primary: "app-primary-95a0e6d83f1e.js",
    start: "start-voice-4c77215aa289.js",
    prewarm: "voice-prewarm-e49220ad61bd.js",
    roles: NAMED_CHAT_ROLES_26_1027_30824,
  },
  {
    platform: "darwin",
    version: "26.1023.51421",
    initial: "app-initial-bc8256c3cccb.js",
    shared: "app-shared-e9f258fd3588.js",
    primary: "app-primary-b7f335b763ca.js",
    start: "start-voice-a0564cefdc95.js",
    prewarm: "voice-prewarm-53aefded152c.js",
    settings: "voice-settings-1a9f68eb7ae8.js",
    roles: NAMED_CHAT_ROLES_26_1023_51421,
  },
  {
    platform: "darwin",
    version: "26.1021.31345",
    initial: "app-initial-feb30b196d11.js",
    shared: "app-shared-2cae01273bae.js",
    primary: "app-primary-7d7313419f84.js",
    start: "entity-business-profile-reference-b68063dfc05d.js",
    prewarm: "voice-prewarm-d672f1245523.js",
    settings: "voice-settings-14000f5c9fc2.js",
    roles: NAMED_CHAT_ROLES_26_1021_31345,
  },
  {
    platform: "win32",
    version: "26.1021.31345",
    initial: "app-initial-438d1df57f70.js",
    shared: "app-shared-955d52676f9c.js",
    primary: "app-primary-844e405f2b90.js",
    start: "entity-business-profile-reference-241c52d811f4.js",
    prewarm: "voice-prewarm-8b47c50a17ae.js",
    settings: "voice-settings-b1c1633136a5.js",
    roles: NAMED_CHAT_ROLES_26_1021_31345,
  },
  {
    platform: "darwin",
    version: "26.1016.62342",
    initial: "app-initial-dddef47d6ef6.js",
    shared: "app-shared-fc3316d48427.js",
    start: "start-voice-7cbf0a39d53b.js",
    prewarm: "voice-prewarm-5d107129ac1c.js",
    roles: BASELINE_NAMED_CHAT_ROLES,
  },
  {
    platform: "darwin",
    version: "26.1016.61520",
    initial: "app-initial-c95ddb62696e.js",
    shared: "app-shared-2eda13eb7044.js",
    start: "start-voice-18b08f0acdd7.js",
    prewarm: "voice-prewarm-94271e581c1b.js",
    roles: BASELINE_NAMED_CHAT_ROLES,
  },
];

export const CLIENT_OWNED_VOICE_VERSION = "26.1027.61615";
export const CLIENT_OWNED_VOICE_INITIAL_ASSET = "app-initial-18b189e867e7.js";
export const CLIENT_OWNED_VOICE_SHARED_ASSET = "app-shared-601019a330d7.js";
export const CLIENT_OWNED_VOICE_OVERLAY_ASSET = "avatar-overlay-native-page-920d05377bbe.js";

export interface ClientOwnedVoiceProfile {
  platform: VoicePlatform;
  version: string;
  initial: string;
  shared: string;
  overlay: string;
  init?: string;
  fetch: string;
  fetchFrom?: "initial" | "shared";
  bridge: string;
  services: string;
  responseError?: string;
  responseErrorFrom?: "initial" | "shared";
  capabilityInit: string;
  capabilityFamily: string;
  inferenceGateFamily: string;
}

export const CLIENT_OWNED_VOICE_ASSETS: readonly ClientOwnedVoiceProfile[] = [
  {
    platform: "darwin",
    version: CLIENT_OWNED_VOICE_VERSION,
    initial: CLIENT_OWNED_VOICE_INITIAL_ASSET,
    shared: CLIENT_OWNED_VOICE_SHARED_ASSET,
    overlay: CLIENT_OWNED_VOICE_OVERLAY_ASSET,
    init: "Adr",
    fetch: "Odr",
    fetchFrom: "initial",
    bridge: "LRt",
    services: "Vct",
    responseError: "Pdr",
    responseErrorFrom: "initial",
    capabilityInit: "Ler",
    capabilityFamily: "Ier",
    inferenceGateFamily: "Vfr",
  },
  {
    platform: "darwin",
    version: "26.1027.30824",
    initial: "app-initial-60f141238751.js",
    shared: "app-shared-7815d5a1a42a.js",
    overlay: "avatar-overlay-native-page-d9d400e751cd.js",
    init: "Edr",
    fetch: "wdr",
    fetchFrom: "initial",
    bridge: "LRt",
    services: "Vct",
    responseError: "Adr",
    responseErrorFrom: "initial",
    capabilityInit: "Ner",
    capabilityFamily: "Mer",
    inferenceGateFamily: "Lfr",
  },
  {
    platform: "darwin",
    version: "26.1023.51421",
    initial: "app-initial-bc8256c3cccb.js",
    shared: "app-shared-e9f258fd3588.js",
    overlay: "avatar-overlay-native-page-af6c3662f64f.js",
    init: "xir",
    fetch: "yir",
    fetchFrom: "initial",
    bridge: "QIt",
    services: "Sst",
    capabilityInit: "N4n",
    capabilityFamily: "M4n",
    inferenceGateFamily: "Par",
  },
  {
    platform: "darwin",
    version: "26.1021.31345",
    initial: "app-initial-feb30b196d11.js",
    shared: "app-shared-2cae01273bae.js",
    overlay: "avatar-overlay-native-page-d549db3706f1.js",
    fetch: "Htr",
    fetchFrom: "initial",
    bridge: "bIt",
    services: "Qot",
    capabilityInit: "l0n",
    capabilityFamily: "c0n",
    inferenceGateFamily: "Cnr",
  },
  {
    platform: "win32",
    version: "26.1021.31345",
    initial: "app-initial-438d1df57f70.js",
    shared: "app-shared-955d52676f9c.js",
    overlay: "avatar-overlay-native-page-1549fe5955e1.js",
    fetch: "Htr",
    fetchFrom: "initial",
    bridge: "bIt",
    services: "Qot",
    capabilityInit: "l0n",
    capabilityFamily: "c0n",
    inferenceGateFamily: "Cnr",
  },
  {
    platform: "darwin",
    version: "26.1016.62342",
    initial: "app-initial-dddef47d6ef6.js",
    shared: "app-shared-fc3316d48427.js",
    overlay: "avatar-overlay-native-page-ef8332c6a2fb.js",
    init: "Oit",
    fetch: "Eit",
    bridge: "AFt",
    responseError: "Mit",
    services: "ist",
    capabilityInit: "njr",
    capabilityFamily: "tjr",
    inferenceGateFamily: "uBr",
  },
  {
    platform: "darwin",
    version: "26.1016.61520",
    initial: "app-initial-c95ddb62696e.js",
    shared: "app-shared-2eda13eb7044.js",
    overlay: "avatar-overlay-native-page-fcc17283519a.js",
    init: "Oit",
    fetch: "Eit",
    bridge: "AFt",
    responseError: "Mit",
    services: "ist",
    capabilityInit: "njr",
    capabilityFamily: "tjr",
    inferenceGateFamily: "uBr",
  },
];

/** Historical overlay-only CPA pin. Not a Chat or Work native-voice qualification. */
export const HISTORICAL_CPA_LIVE_VOICE_DESKTOP_VERSION = "26.1007.30912";
export const HISTORICAL_CPA_LIVE_VOICE_APP_INITIAL_ASSET = "app-initial-6350d04672d0.js";

/** macOS 26.1106.51428 entry exports live `__webpack_require__`. */
export const HASHED_WEBPACK_VOICE_VERSION = "26.1106.51428";
export const HASHED_WEBPACK_VOICE_RUNTIME_ASSET = "348410.1a97dde15f.js";
/** Hashed Instant Connect START / VoiceRoom. */
export const HASHED_NATIVE_CHAT_START_ASSET = "530142.1e51e7f4b2.js";
/** Hashed VoiceInstantConnectCacheController. */
export const HASHED_NATIVE_CHAT_PREWARM_ASSET = "586788.c871bb9b7d.js";

/** Dependency graph used by Desktop 26.1106's native Chat voice initializer. */
export const NATIVE_CHAT_VOICE_CHUNKS = [
  157963, 74692, 198336, 543449, 904485, 459859, 822019, 431137, 108823, 208490, 384218, 843292,
  652289, 907652, 796195, 144338, 140959, 587936, 904817, 426774, 452048, 490954, 445991, 612928,
  42903, 363341, 997826, 223736, 21878, 89655, 333490, 422391, 792483, 530142,
] as const;

export const HASHED_NATIVE_CHAT_ROLES = {
  startModuleId: "j9r7",
  prewarmModuleId: "oWM3",
  appScopeModuleId: "OWtl",
  appScopeExport: "u",
  routeScopeModuleId: "Oj9r",
  routeScopeExport: "GD",
  composerScopeModuleId: "Sd8U",
  composerScopeExport: "PR",
  storeModuleId: "bgok",
  storeExport: "MH",
  runtimeModuleId: "cY1t",
  runtimeEnableExport: "Iy",
  runtimeLoaderExport: "Re",
  reactModuleId: "zd8w",
  reactDomModuleId: "CE87",
  startInitializeExport: "initializeVoiceSession",
  prewarmControllerExport: "VoiceInstantConnectCacheController",
  /** Conversation store: adopted backend ID, transcript mapping, current node. */
  conversationModuleId: "MrGp",
  backendConversationExport: "jS",
  transcriptMappingExport: "Jv",
  currentNodeExport: "Od",
  /** App location atom used as the draft-selection origin. */
  locationModuleId: "nlNF",
  locationExport: "x2",
  /** AppNavigation.navigate(scope, location). */
  navigationModuleId: "E8Sp",
  navigationExport: "oo",
  /** `/c/:conversationId` builder; not a GPT `/g/` path. */
  conversationPathModuleId: "jAnS",
  conversationPathExport: "mv",
} as const;

export const HASHED_OVERLAY_VOICE_ROLES = {
  fetchFactoryId: "GDNt",
  fetchExport: "_n",
  bridgeModuleId: "TL6G",
  bridgeExport: "O1",
  responseErrorModuleId: "eShZ",
  responseErrorExport: "s1",
  capabilityModuleId: "ChYf",
  capabilityExport: "G",
  inferenceGateModuleId: "OMIV",
  inferenceGateExport: "JW",
  /** Workspace voice access derived atom `P` via `zTeN.un`; Instant Connect ANDs `Y3.status`. */
  voiceAccessModuleId: "eFn4",
  voiceAccessExport: "Y3",
} as const;

/** Hashed 26.1106 Instant Connect evaluator roles from webpack `ChYf` / `ZnQ7` / `eFn4`. */
export const HASHED_26_1106_VOICE_EVALUATOR = {
  accessPolicy: "realtime-voice",
  enableStatsig: "2380644311",
  firstPartyStatsig: "3683713372",
  unsupportedAuthReason: "unsupported-auth",
  inAppVoiceFeature: "in_app_voice",
  capabilityFamilyKind: "readable-family",
  inferenceGateFamilyKind: "signal-family",
  accessAtomLibrary: "un",
  capabilityAtomLibrary: "i1",
  accessFactoryCache: "string",
} as const;

/** Source-byte fragments from hashed 26.1106 `zTeN` / `ChYf` / `eFn4`. */
export const HASHED_26_1106_VOICE_NATIVE_BYTES = {
  atomLibrary: "un:()=>U.u,i1:()=>a.i1",
  accessExport: "Y3:()=>P",
  accessCtor: "P=(0,r.un)(l.u,({get:e})=>e(A).voice,{isEqual:X}",
  capabilityCtor: "h=(0,r.i1)(l.u,(e,{get:t})=>{",
} as const;

export const VOICE_CAPABILITY_REASONS = [
  "access-replay",
  "inference-replay",
  "other-denial",
  "access-shape",
  "native-ineligible",
  "unsupported",
  "pending",
  "disabled",
] as const;
export type VoiceCapabilityReason = (typeof VOICE_CAPABILITY_REASONS)[number];

export const HASHED_NATIVE_CHAT_SEMANTIC_ANCHORS = [
  "initializeVoiceSession",
  "VoiceInstantConnectCacheController",
  "AppScope",
  "RouteScope",
  "ComposerScope",
  "dispatchVoiceCommand",
  "startVoiceWithIntroduction",
] as const;

export type VoiceSemanticRoleMatcher = {
  role: string;
  mode: "any" | "all";
  callees: readonly string[];
  exports: readonly string[];
  brands: readonly string[];
};

/** Implementation-owned Chat roles. Comments and unused string mentions do not match. */
export const CHAT_SEMANTIC_ROLE_MATCHERS: readonly VoiceSemanticRoleMatcher[] = [
  {
    role: "start",
    mode: "any",
    callees: ["initializeVoiceSession", "startVoiceWithIntroduction", "dispatchVoiceCommand"],
    exports: ["initializeVoiceSession"],
    brands: [],
  },
  {
    role: "prewarm",
    mode: "any",
    callees: [],
    exports: ["VoiceInstantConnectCacheController"],
    brands: ["VoiceInstantConnectCacheController"],
  },
  { role: "appScope", mode: "any", callees: [], exports: [], brands: ["AppScope"] },
  { role: "routeScope", mode: "any", callees: [], exports: [], brands: ["RouteScope"] },
  { role: "composerScope", mode: "any", callees: [], exports: [], brands: ["ComposerScope"] },
];

/** Implementation-owned Work overlay roles. */
export const WORK_SEMANTIC_ROLE_MATCHERS: readonly VoiceSemanticRoleMatcher[] = [
  {
    role: "overlay-fetch",
    mode: "all",
    callees: ["getInstance"],
    exports: [],
    brands: ["codex_work_desktop"],
  },
];

export function hashedVoiceCandidateOwner(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): boolean {
  return (
    config.desktopVersion === HASHED_WEBPACK_VOICE_VERSION &&
    (config.desktopPlatform === "darwin" || config.desktopPlatform === "win32")
  );
}

export function hashedVoiceProfileSupported(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): boolean {
  return (
    config.desktopVersion === HASHED_WEBPACK_VOICE_VERSION && config.desktopPlatform === "darwin"
  );
}

export function reviewedOverlayHookDesktopVersions(): readonly string[] {
  const versions = new Set<string>([
    HISTORICAL_CPA_LIVE_VOICE_DESKTOP_VERSION,
    HASHED_WEBPACK_VOICE_VERSION,
  ]);
  for (const profile of NATIVE_CHAT_VOICE_ASSETS) versions.add(profile.version);
  for (const profile of CLIENT_OWNED_VOICE_ASSETS) versions.add(profile.version);
  return [...versions].sort();
}

export const VOICE_PROFILE_PINS = {
  workVersion: CLIENT_OWNED_VOICE_VERSION,
  workInitial: CLIENT_OWNED_VOICE_INITIAL_ASSET,
  workShared: CLIENT_OWNED_VOICE_SHARED_ASSET,
  overlayAsset: CLIENT_OWNED_VOICE_OVERLAY_ASSET,
  chatVersion: NATIVE_CHAT_VOICE_VERSION,
  chatInitial: NATIVE_CHAT_INITIAL_ASSET,
  chatStart: START_ASSET,
  hashedVersion: HASHED_WEBPACK_VOICE_VERSION,
  hashedRuntimeAsset: HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  hashedStartAsset: HASHED_NATIVE_CHAT_START_ASSET,
  hashedPrewarmAsset: HASHED_NATIVE_CHAT_PREWARM_ASSET,
  historicalCpaVersion: HISTORICAL_CPA_LIVE_VOICE_DESKTOP_VERSION,
  historicalCpaInitial: HISTORICAL_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
} as const;

export const voiceProfilePins = {
  ...VOICE_PROFILE_PINS,
  overlayHookDesktopVersions: reviewedOverlayHookDesktopVersions(),
};

export type NativeChatVoiceKind = "named" | "hashed";

export function nativeChatVoiceKind(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): NativeChatVoiceKind | undefined {
  if (!config.desktopVersion) return undefined;
  if (hashedVoiceProfileSupported(config)) return "hashed";
  if (
    NATIVE_CHAT_VOICE_ASSETS.some(
      (profile) =>
        profile.version === config.desktopVersion &&
        (config.desktopPlatform === undefined || profile.platform === config.desktopPlatform),
    )
  ) {
    return "named";
  }
  return undefined;
}

export function nativeChatVoiceUnavailableReason(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): string | undefined {
  if (nativeChatVoiceKind(config)) return undefined;
  if (!config.desktopVersion) return "Chat voice is waiting for Desktop identity.";
  if (
    config.desktopVersion === HASHED_WEBPACK_VOICE_VERSION &&
    config.desktopPlatform === "win32"
  ) {
    return "Chat voice is not qualified on this Windows Desktop.";
  }
  return "Chat voice is not qualified on this Desktop.";
}

export function workVoiceUnavailableReason(config: {
  desktopVersion?: string;
  desktopPlatform?: string;
}): string | undefined {
  if (hashedVoiceProfileSupported(config)) return undefined;
  if (
    config.desktopVersion !== undefined &&
    CLIENT_OWNED_VOICE_ASSETS.some(
      (profile) =>
        profile.version === config.desktopVersion &&
        (config.desktopPlatform === undefined || profile.platform === config.desktopPlatform),
    )
  ) {
    return undefined;
  }
  if (!config.desktopVersion) return "Work voice is waiting for Desktop identity.";
  if (
    config.desktopVersion === HASHED_WEBPACK_VOICE_VERSION &&
    config.desktopPlatform === "win32"
  ) {
    return "Work voice is not qualified on this Windows Desktop.";
  }
  return "Work voice is not qualified on this Desktop.";
}

export function profileIdentityKey(
  product: "chat" | "work",
  platform: string | undefined,
  version: string | undefined,
): string {
  return `${product}:${platform ?? "unknown"}:${version ?? "unknown"}`;
}

function fnv1aHex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function digestJson(value: unknown): string {
  return fnv1aHex(JSON.stringify(value));
}

export type LegacyRetainedVoiceLane = {
  path: "chat" | "work-codex";
  platform: VoicePlatform;
  version: string;
};

/** Named Chat and Work/Codex tables already retained on this Host. Not Work/Grok, not hashed 26.1106. */
export function legacyRetainedVoiceLanes(): readonly LegacyRetainedVoiceLane[] {
  return [
    ...NATIVE_CHAT_VOICE_ASSETS.map((profile) => ({
      path: "chat" as const,
      platform: profile.platform,
      version: profile.version,
    })),
    ...CLIENT_OWNED_VOICE_ASSETS.map((profile) => ({
      path: "work-codex" as const,
      platform: profile.platform,
      version: profile.version,
    })),
  ];
}

export function voiceProfileOwner(
  product: "chat" | "work",
  platform: string,
  version: string,
): Record<string, unknown> | undefined {
  if (product === "chat") {
    if (hashedVoiceCandidateOwner({ desktopVersion: version, desktopPlatform: platform })) {
      return {
        kind: "hashed-chat",
        platform,
        version,
        roles: HASHED_NATIVE_CHAT_ROLES,
        chunks: [...NATIVE_CHAT_VOICE_CHUNKS],
        webpack: HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        start: HASHED_NATIVE_CHAT_START_ASSET,
        prewarm: HASHED_NATIVE_CHAT_PREWARM_ASSET,
      };
    }
    const named = NATIVE_CHAT_VOICE_ASSETS.find(
      (profile) => profile.platform === platform && profile.version === version,
    );
    if (!named) return undefined;
    return {
      kind: "named-chat",
      platform: named.platform,
      version: named.version,
      initial: named.initial,
      shared: named.shared,
      primary: named.primary ?? null,
      start: named.start,
      prewarm: named.prewarm,
      settings: named.settings ?? null,
      roles: named.roles,
    };
  }
  const namedWork = CLIENT_OWNED_VOICE_ASSETS.find(
    (profile) => profile.platform === platform && profile.version === version,
  );
  if (namedWork) {
    return {
      kind: "named-work",
      platform: namedWork.platform,
      version: namedWork.version,
      initial: namedWork.initial,
      shared: namedWork.shared,
      overlay: namedWork.overlay,
      init: namedWork.init ?? null,
      fetch: namedWork.fetch,
      fetchFrom: namedWork.fetchFrom ?? null,
      bridge: namedWork.bridge,
      services: namedWork.services,
      responseError: namedWork.responseError ?? null,
      responseErrorFrom: namedWork.responseErrorFrom ?? null,
      capabilityInit: namedWork.capabilityInit,
      capabilityFamily: namedWork.capabilityFamily,
      inferenceGateFamily: namedWork.inferenceGateFamily,
    };
  }
  if (hashedVoiceCandidateOwner({ desktopVersion: version, desktopPlatform: platform })) {
    return {
      kind: "hashed-work",
      platform,
      version,
      overlay: HASHED_OVERLAY_VOICE_ROLES,
      webpack: HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
    };
  }
  return undefined;
}

export function voiceProfileDigest(
  product: "chat" | "work",
  platform: string,
  version: string,
): string | undefined {
  const owner = voiceProfileOwner(product, platform, version);
  return owner ? digestJson(owner) : undefined;
}

export function voiceImplementationRevision(): string {
  return VOICE_IMPLEMENTATION_REVISION;
}

export function voiceQualificationArtifact(): {
  implementationRevision: string;
  reviewedEvidence: readonly [];
} {
  return {
    implementationRevision: voiceImplementationRevision(),
    reviewedEvidence: [],
  };
}
