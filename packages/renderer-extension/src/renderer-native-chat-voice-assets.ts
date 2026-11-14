import type { NativeChatNamedProfile } from "./renderer-voice-profiles.js";

export { NATIVE_CHAT_VOICE_ASSETS, NATIVE_CHAT_VOICE_VERSION } from "./renderer-voice-profiles.js";
export type { NativeChatNamedProfile, NativeChatNamedRoles } from "./renderer-voice-profiles.js";

type NativeModule = Record<string, unknown>;

function exportValue(module: NativeModule | undefined, name: string): unknown {
  return module?.[name];
}

function asModule(value: unknown): NativeModule | undefined {
  return value !== null && typeof value === "object" ? (value as NativeModule) : undefined;
}

/** Normalize audited exports to the baseline Chat lifecycle contract.
 * The full composer START can live in a chunk unrelated to its public filename.
 * The starter-prompt entry has a different signature and cannot substitute for it.
 */
export async function loadNativeChatVoiceModules(
  assets: NativeChatNamedProfile,
  importModule: (url: string) => Promise<NativeModule>,
): Promise<{
  initial: NativeModule;
  shared: NativeModule;
  start: NativeModule;
  prewarm: NativeModule;
}> {
  const roles = assets.roles;
  const [sharedModule, initialModule, startModule, prewarm, primary] = await Promise.all(
    [assets.shared, assets.initial, assets.start, assets.prewarm, assets.primary].map((asset) =>
      asset ? importModule(`app://-/assets/${asset}`) : Promise.resolve(undefined),
    ),
  );
  if (!sharedModule || !initialModule || !startModule || !prewarm) throw new Error();
  const initializeSource = roles.initializeFrom === "primary" ? primary : initialModule;
  const initialize = exportValue(initializeSource, roles.initialize);
  const start =
    roles.startShape === "entityBusiness"
      ? {
          t: exportValue(startModule, roles.startT ?? "t"),
          n: exportValue(startModule, roles.startN ?? "n"),
        }
      : startModule;
  const voiceSession = exportValue(initialModule, roles.voiceSessionSelector);
  const reactFactory = exportValue(sharedModule, roles.reactFactory);
  const reactDomFactory = exportValue(sharedModule, roles.reactDomFactory);
  if (
    !asModule(start) ||
    typeof start.t !== "function" ||
    typeof start.n !== "function" ||
    typeof initialize !== "function" ||
    typeof voiceSession !== "function" ||
    typeof reactFactory !== "function" ||
    typeof reactDomFactory !== "function" ||
    typeof prewarm[roles.prewarmController] !== "function"
  )
    throw new Error();
  initialize();
  start.t();
  const initialFrom = (name: string, from: "primary" | "initial") =>
    exportValue(from === "primary" ? primary : initialModule, name);
  const initial = {
    MOr: initialFrom(roles.initial.MOr, "initial"),
    CDr: initialFrom(roles.initial.CDr, "initial"),
    B1n: initialFrom(roles.initial.B1n, "initial"),
    SPn: initialFrom(roles.initial.SPn, "initial"),
    oT: initialFrom(roles.initial.oT, roles.initial.oTFrom),
    aT: initialFrom(roles.initial.aT, roles.initial.aTFrom),
    Ycr: initialFrom(roles.initial.Ycr, "initial"),
    Nir: initialFrom(roles.initial.Nir, "initial"),
    n0n: initialFrom(roles.initial.n0n, "initial"),
    Y1n: initialFrom(roles.initial.Y1n, "initial"),
    HJt: initialFrom(roles.initial.HJt, "initial"),
  };
  const shared = {
    Qst: exportValue(sharedModule, roles.shared.Qst),
    FBt: exportValue(sharedModule, roles.shared.FBt),
    PNt: exportValue(sharedModule, roles.shared.PNt),
    Vot: exportValue(sharedModule, roles.shared.Vot),
  };
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
  return { initial, shared, start: start as NativeModule, prewarm };
}
