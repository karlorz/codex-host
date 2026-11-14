import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRealtimeGateway } from "../src/realtime-gateway-config.js";
import {
  ISOLATED_NATIVE_PROVIDER_ID,
  ISOLATED_NATIVE_PROVIDER_NAME,
  ISOLATED_VOICE_ENV_KEY,
  inspectIsolatedNativeHomeToml,
  isolatedNativeHomeExampleToml,
} from "../src/isolated-native-home-config.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("isolated native-home setup", () => {
  it("example satisfies Host gateway reads and stock Codex provider name", async () => {
    const toml = isolatedNativeHomeExampleToml();
    const inspected = inspectIsolatedNativeHomeToml(toml);
    expect(inspected).toEqual({
      providerId: ISOLATED_NATIVE_PROVIDER_ID,
      name: ISOLATED_NATIVE_PROVIDER_NAME,
      envKey: ISOLATED_VOICE_ENV_KEY,
      hasBearer: false,
    });
    const home = await mkdtemp(path.join(tmpdir(), "isolated-native-home-"));
    homes.push(home);
    await writeFile(path.join(home, "config.toml"), toml);
    await expect(
      readRealtimeGateway({
        CODEX_HOME: home,
        [ISOLATED_VOICE_ENV_KEY]: "gateway-fixture",
      }),
    ).resolves.toMatchObject({
      url: expect.objectContaining({ origin: "https://gateway.example" }),
    });
  });

  it("rejects a missing selected provider name the way stock Codex does", () => {
    const toml = isolatedNativeHomeExampleToml().replace('name = "Isolated CPA"\n', "");
    expect(() => inspectIsolatedNativeHomeToml(toml)).toThrow(
      "selected isolated-cpa provider name must not be empty",
    );
  });

  it("rejects an empty selected provider name", () => {
    expect(() =>
      inspectIsolatedNativeHomeToml(isolatedNativeHomeExampleToml({ name: " " })),
    ).toThrow("selected isolated-cpa provider name must not be empty");
  });

  it("rejects isolated env_key names Host launcher would strip", () => {
    expect(() =>
      inspectIsolatedNativeHomeToml(isolatedNativeHomeExampleToml({ envKey: "CODEXHOST_VOICE" })),
    ).toThrow("CODEXHOST_ prefix");
  });

  it("rejects an in-file bearer on the selected provider", () => {
    const toml = `${isolatedNativeHomeExampleToml()}experimental_bearer_token = "must-not-be-copied"\n`;
    expect(() => inspectIsolatedNativeHomeToml(toml)).toThrow("env_key, not an in-file bearer");
  });

  it("does not treat gateway-transport inspect as a production Codex profile", () => {
    const toml = isolatedNativeHomeExampleToml();
    const inspected = inspectIsolatedNativeHomeToml(toml);
    expect(inspected.hasBearer).toBe(false);
    expect(toml).not.toMatch(/requires_openai_auth/u);
    expect(toml).not.toMatch(/^base_url\s*=/mu);
    expect(toml).not.toMatch(/\[model_providers\.[^\]]+\][\s\S]*^base_url\s*=/mu);
  });

  it("does not treat Host-only TOML without name as a complete isolated home", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "host-only-native-home-"));
    homes.push(home);
    const toml =
      'model_provider="custom"\nexperimental_realtime_webrtc_call_base_url="https://gateway.example/v1"\nexperimental_realtime_ws_base_url="https://gateway.example/v1"\n[model_providers.custom]\nenv_key="VOICE_KEY"\n';
    await writeFile(path.join(home, "config.toml"), toml);
    await expect(
      readRealtimeGateway({ CODEX_HOME: home, VOICE_KEY: "gateway-fixture" }),
    ).resolves.toBeDefined();
    expect(() => inspectIsolatedNativeHomeToml(toml)).toThrow(
      "selected custom provider name must not be empty",
    );
    expect(await readFile(path.join(home, "config.toml"), "utf8")).not.toMatch(/bearer/iu);
  });
});
