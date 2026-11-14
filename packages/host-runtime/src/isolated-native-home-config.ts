import { parse } from "smol-toml";

export const ISOLATED_NATIVE_PROVIDER_ID = "isolated-cpa";
export const ISOLATED_NATIVE_PROVIDER_NAME = "Isolated CPA";
export const ISOLATED_VOICE_ENV_KEY = "ISOLATED_VOICE_GATEWAY_TOKEN";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertMatchingHttpsOrigins(webrtc: string, sideband: string): void {
  let url: URL;
  let other: URL;
  try {
    url = new URL(webrtc);
    other = new URL(sideband);
  } catch {
    throw new Error("External voice gateway URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    other.protocol !== "https:" ||
    url.origin !== other.origin ||
    url.username ||
    url.password ||
    other.username ||
    other.password ||
    url.search ||
    url.hash ||
    other.search ||
    other.hash
  ) {
    throw new Error("External voice requires matching HTTPS gateway origins");
  }
}

export interface IsolatedNativeHomeExample {
  readonly origin?: string;
  readonly providerId?: string;
  readonly name?: string;
  readonly envKey?: string;
}

/**
 * Example isolated gateway-transport home. Host `readRealtimeGateway` accepts it
 * and stock Codex accepts the selected provider `name`. It is not the production
 * Codex profile (`custom` + HTTPS `base_url` + `requires_openai_auth` +
 * `auth.json`).
 */
export function isolatedNativeHomeExampleToml(example: IsolatedNativeHomeExample = {}): string {
  const origin = (example.origin ?? "https://gateway.example/v1").replace(/\/$/u, "");
  const providerId = example.providerId ?? ISOLATED_NATIVE_PROVIDER_ID;
  const name = example.name ?? ISOLATED_NATIVE_PROVIDER_NAME;
  const envKey = example.envKey ?? ISOLATED_VOICE_ENV_KEY;
  return [
    `model_provider = "${providerId}"`,
    `experimental_realtime_webrtc_call_base_url = "${origin}"`,
    `experimental_realtime_ws_base_url = "${origin}"`,
    `[model_providers.${providerId}]`,
    `name = "${name}"`,
    `env_key = "${envKey}"`,
    "",
  ].join("\n");
}

export interface IsolatedNativeHomeInspection {
  readonly providerId: string;
  readonly name: string;
  readonly envKey: string;
  readonly hasBearer: boolean;
}

/**
 * Stock Codex ModelProviderInfo requires a non-empty selected provider `name`.
 * Isolated gateway-transport homes also use `env_key` (never `CODEXHOST_*`, never
 * an in-file bearer) and the same HTTPS gateway origin pair Host
 * `readRealtimeGateway` accepts. Passing this inspect does not prove ChatGPT
 * `auth.json`, inference `base_url`, or `requires_openai_auth`. A working
 * production custom provider may set `requires_openai_auth = true` together with
 * HTTPS inference and realtime URLs; that is out of this helper's scope.
 */
export function inspectIsolatedNativeHomeToml(toml: string): IsolatedNativeHomeInspection {
  let config: Record<string, unknown>;
  try {
    config = parse(toml);
  } catch {
    throw new Error("Isolated native-home configuration is unavailable");
  }
  const providerId = config.model_provider;
  const providers = config.model_providers;
  const provider =
    nonEmptyString(providerId) && object(providers) ? providers[providerId] : undefined;
  if (!nonEmptyString(providerId) || !object(provider)) {
    throw new Error("Isolated native-home selected provider is missing");
  }
  if (!nonEmptyString(provider.name)) {
    throw new Error(`selected ${providerId} provider name must not be empty`);
  }
  if ("experimental_bearer_token" in provider) {
    throw new Error("Isolated native-home must use env_key, not an in-file bearer");
  }
  if (!nonEmptyString(provider.env_key)) {
    throw new Error("Isolated native-home requires env_key");
  }
  if (provider.env_key.startsWith("CODEXHOST_")) {
    throw new Error("Isolated native-home env_key must not use the CODEXHOST_ prefix");
  }
  const webrtc = config.experimental_realtime_webrtc_call_base_url;
  const sideband = config.experimental_realtime_ws_base_url ?? webrtc;
  if (typeof webrtc !== "string" || typeof sideband !== "string") {
    throw new Error("External voice requires a configured realtime gateway and API credential");
  }
  assertMatchingHttpsOrigins(webrtc, sideband);
  return {
    providerId,
    name: provider.name,
    envKey: provider.env_key,
    hasBearer: false,
  };
}
