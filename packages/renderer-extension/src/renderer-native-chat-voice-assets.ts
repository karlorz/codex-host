type NativeModule = Record<string, unknown>;
export const NATIVE_CHAT_VOICE_VERSION = "26.1023.51421";
const NATIVE_CHAT_INITIAL_ASSET = "app-initial-bc8256c3cccb.js";
const START_ASSET = "start-voice-a0564cefdc95.js";

export const NATIVE_CHAT_VOICE_ASSETS = [
  {
    platform: "darwin",
    version: NATIVE_CHAT_VOICE_VERSION,
    initial: NATIVE_CHAT_INITIAL_ASSET,
    shared: "app-shared-e9f258fd3588.js",
    primary: "app-primary-b7f335b763ca.js",
    start: START_ASSET,
    prewarm: "voice-prewarm-53aefded152c.js",
    settings: "voice-settings-1a9f68eb7ae8.js",
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
  },
  {
    platform: "darwin",
    version: "26.1016.62342",
    initial: "app-initial-dddef47d6ef6.js",
    shared: "app-shared-fc3316d48427.js",
    start: "start-voice-7cbf0a39d53b.js",
    prewarm: "voice-prewarm-5d107129ac1c.js",
  },
  {
    platform: "darwin",
    version: "26.1016.61520",
    initial: "app-initial-c95ddb62696e.js",
    shared: "app-shared-2eda13eb7044.js",
    start: "start-voice-18b08f0acdd7.js",
    prewarm: "voice-prewarm-94271e581c1b.js",
  },
];

/** Normalize audited exports to the baseline Chat lifecycle contract.
 * The full composer START can live in a chunk unrelated to its public filename.
 * The starter-prompt entry has a different signature and cannot substitute for it.
 */
export async function loadNativeChatVoiceModules(
  assets: (typeof NATIVE_CHAT_VOICE_ASSETS)[number],
  importModule: (url: string) => Promise<NativeModule>,
): Promise<{
  initial: NativeModule;
  shared: NativeModule;
  start: NativeModule;
  prewarm: NativeModule;
}> {
  const [sharedModule, initialModule, startModule, prewarm, primary] = await Promise.all(
    [assets.shared, assets.initial, assets.start, assets.prewarm, assets.primary].map((asset) =>
      asset ? importModule(`app://-/assets/${asset}`) : Promise.resolve(undefined),
    ),
  );
  if (!sharedModule || !initialModule || !startModule || !prewarm) throw new Error();
  const latest = assets.version === "26.1023.51421";
  const current = latest || assets.version === "26.1021.31345";
  const initialize = latest ? primary?.gm : current ? primary?.um : initialModule.oT;
  const start = current && !latest ? { t: startModule.r, n: startModule.i } : startModule;
  if (
    typeof start.t !== "function" ||
    typeof start.n !== "function" ||
    typeof initialize !== "function" ||
    typeof (latest ? initialModule["s$t"] : current ? initialModule.qXt : initialModule.SPn) !==
      "function" ||
    typeof (latest ? sharedModule.OHt : current ? sharedModule.XVt : sharedModule.FBt) !==
      "function" ||
    typeof (latest ? sharedModule.wPt : current ? sharedModule.KNt : sharedModule.PNt) !==
      "function" ||
    typeof prewarm.VoiceInstantConnectCacheController !== "function"
  )
    throw new Error();
  initialize();
  start.t();
  // Initializers publish mutable native exports, including the enable flag.
  const initial = latest
    ? {
        MOr: initialModule.x1n,
        CDr: initialModule.MQn,
        B1n: initialModule.Opn,
        SPn: initialModule["s$t"],
        oT: primary?.gm,
        aT: primary?.hm,
        Ycr: initialModule.Zir,
        Nir: initialModule.ejn,
        n0n: initialModule.Kpn,
        Y1n: initialModule.zpn,
        HJt: initialModule.k3,
      }
    : current
      ? {
          MOr: initialModule.CQn,
          CDr: initialModule.PXn,
          B1n: initialModule.tdn,
          SPn: initialModule.qXt,
          oT: primary?.um,
          aT: primary?.lm,
          Ycr: initialModule.Xkn,
          Nir: initialModule.yAn,
          n0n: initialModule.ydn,
          Y1n: initialModule.fdn,
          HJt: initialModule.R2,
        }
      : initialModule;
  const shared = latest
    ? { Qst: sharedModule.uct, FBt: sharedModule.OHt, PNt: sharedModule.wPt, Vot: sharedModule.ast }
    : current
      ? {
          Qst: sharedModule.Bst,
          FBt: sharedModule.XVt,
          PNt: sharedModule.KNt,
          Vot: sharedModule.Fot,
        }
      : sharedModule;
  const scope = (value: unknown, brand: string) =>
    value !== null &&
    typeof value === "object" &&
    (value as { __scopeBrand?: unknown }).__scopeBrand === brand;
  if (
    !scope(shared.Qst, "AppScope") ||
    !scope(initial.MOr, "RouteScope") ||
    !scope(initial.CDr, "ComposerScope") ||
    !initial.B1n ||
    !initial.aT
  )
    throw new Error();
  return { initial, shared, start, prewarm };
}
