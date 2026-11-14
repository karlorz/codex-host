import { describe, expect, it } from "vitest";

import {
  discoverVoiceCandidate,
  fingerprintVoiceInventory,
  replayVoiceDiscovery,
  sourceFingerprint,
} from "../src/renderer-voice-discovery.js";
import {
  HASHED_NATIVE_CHAT_PREWARM_ASSET,
  HASHED_NATIVE_CHAT_ROLES,
  HASHED_NATIVE_CHAT_START_ASSET,
  HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
  HASHED_WEBPACK_VOICE_VERSION,
  NATIVE_CHAT_VOICE_ASSETS,
} from "../src/renderer-voice-profiles.js";

describe("voice candidate discovery", () => {
  it("replays an unchanged named Chat inventory as the same candidate", () => {
    const profile = NATIVE_CHAT_VOICE_ASSETS.find(
      (item) => item.version === "26.1027.61615" && item.platform === "darwin",
    );
    if (!profile) throw new Error("missing named Chat profile");
    const inventory = {
      platform: "darwin",
      desktopVersion: profile.version,
      assets: [profile.initial, profile.shared, profile.start, profile.prewarm],
    };
    const fingerprint = fingerprintVoiceInventory(inventory);
    const first = discoverVoiceCandidate(inventory);
    const replayed = replayVoiceDiscovery(inventory, fingerprint);
    expect(first.activation).toBe("candidate");
    expect(first.kind).toBe("named-chat");
    expect(replayed).toEqual(first);
    expect(fingerprintVoiceInventory(inventory)).toBe(fingerprint);
  });

  it("rejects a stale fingerprint instead of activating the previous candidate", () => {
    const inventory = {
      platform: "darwin",
      desktopVersion: "26.1027.61615",
      assets: ["app-initial-18b189e867e7.js"],
    };
    const result = replayVoiceDiscovery(inventory, "deadbeefdeadbeef");
    expect(result.activation).toBe("rejected");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-inventory");
  });

  it("reports partial hashed assets and missing loader separately", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      assets: [HASHED_WEBPACK_VOICE_RUNTIME_ASSET],
      moduleIds: [HASHED_NATIVE_CHAT_ROLES.startModuleId],
    });
    expect(result.kind).toBe("hashed-chat");
    expect(result.activation).toBe("rejected");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing-assets", "incomplete-graph"]),
    );
  });

  it("does not treat duplicate copies of the same factory as distinct role owners", () => {
    const prewarm = {
      id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
      digest: "canonical-prewarm",
      exports: ["VoiceInstantConnectCacheController", "disposeVoicePrewarm"],
      imports: ["HWpc"],
    };
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
      sources: [
        {
          id: HASHED_NATIVE_CHAT_ROLES.startModuleId,
          path: HASHED_NATIVE_CHAT_START_ASSET,
          exports: ["initializeVoiceSession", "dispatchVoiceCommand", "startVoiceWithIntroduction"],
        },
        { ...prewarm, path: HASHED_NATIVE_CHAT_START_ASSET },
        { ...prewarm, path: HASHED_NATIVE_CHAT_PREWARM_ASSET },
        {
          id: HASHED_NATIVE_CHAT_ROLES.appScopeModuleId,
          path: "514766.js",
          exports: ["u"],
          brands: ["AppScope"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.routeScopeModuleId,
          path: "739301.js",
          exports: ["GD"],
          brands: ["RouteScope"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.composerScopeModuleId,
          path: "739301.js",
          exports: ["PR"],
          brands: ["ComposerScope"],
        },
      ],
    });
    expect(result.kind).toBe("hashed-chat");
    expect(result.issues.map((issue) => issue.code)).not.toContain("ambiguous-roles");
    expect(result.issues.map((issue) => issue.code)).not.toContain("wrong-role");
  });

  it("does not treat callee-only mentions as hashed role owners", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
      sources: [
        {
          id: HASHED_NATIVE_CHAT_ROLES.startModuleId,
          exports: ["initializeVoiceSession", "dispatchVoiceCommand", "startVoiceWithIntroduction"],
        },
        {
          id: "nV4r",
          callees: ["initializeVoiceSession", "dispatchVoiceCommand"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
          exports: ["VoiceInstantConnectCacheController"],
        },
        { id: HASHED_NATIVE_CHAT_ROLES.appScopeModuleId, brands: ["AppScope"] },
        { id: HASHED_NATIVE_CHAT_ROLES.routeScopeModuleId, brands: ["RouteScope"] },
        { id: HASHED_NATIVE_CHAT_ROLES.composerScopeModuleId, brands: ["ComposerScope"] },
      ],
    });
    expect(result.issues.map((issue) => issue.code)).not.toContain("ambiguous-roles");
    expect(result.issues.map((issue) => issue.code)).not.toContain("wrong-role");
  });

  it("keeps same-shape factories with different implementation identity as ambiguous", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
      sources: [
        {
          id: HASHED_NATIVE_CHAT_ROLES.startModuleId,
          digest: "start",
          exports: ["initializeVoiceSession", "dispatchVoiceCommand", "startVoiceWithIntroduction"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
          path: "a.js",
          digest: "prewarm-a",
          exports: ["VoiceInstantConnectCacheController"],
          imports: ["HWpc"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
          path: "b.js",
          digest: "prewarm-b",
          exports: ["VoiceInstantConnectCacheController"],
          imports: ["HWpc"],
        },
        { id: HASHED_NATIVE_CHAT_ROLES.appScopeModuleId, digest: "app", brands: ["AppScope"] },
        {
          id: HASHED_NATIVE_CHAT_ROLES.routeScopeModuleId,
          digest: "route",
          brands: ["RouteScope"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.composerScopeModuleId,
          digest: "composer",
          brands: ["ComposerScope"],
        },
      ],
    });
    expect(result.kind).toBe("hashed-chat");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { code: "ambiguous-roles", details: ["VoiceInstantConnectCacheController"] },
      ]),
    );
  });

  it("does not collapse snapshot copies without proven implementation identity", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
      sources: [
        {
          id: HASHED_NATIVE_CHAT_ROLES.startModuleId,
          exports: ["initializeVoiceSession", "dispatchVoiceCommand", "startVoiceWithIntroduction"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
          path: "a.js",
          exports: ["VoiceInstantConnectCacheController"],
          imports: ["HWpc"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
          path: "b.js",
          exports: ["VoiceInstantConnectCacheController"],
          imports: ["HWpc"],
        },
        { id: HASHED_NATIVE_CHAT_ROLES.appScopeModuleId, brands: ["AppScope"] },
        { id: HASHED_NATIVE_CHAT_ROLES.routeScopeModuleId, brands: ["RouteScope"] },
        { id: HASHED_NATIVE_CHAT_ROLES.composerScopeModuleId, brands: ["ComposerScope"] },
      ],
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { code: "ambiguous-roles", details: ["VoiceInstantConnectCacheController"] },
      ]),
    );
  });

  it("keeps conflicting copies of the same module id as ambiguous role owners", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
      sources: [
        {
          id: HASHED_NATIVE_CHAT_ROLES.startModuleId,
          exports: ["initializeVoiceSession", "dispatchVoiceCommand", "startVoiceWithIntroduction"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
          path: "a.js",
          exports: ["VoiceInstantConnectCacheController"],
          imports: ["HWpc"],
        },
        {
          id: HASHED_NATIVE_CHAT_ROLES.prewarmModuleId,
          path: "b.js",
          exports: ["VoiceInstantConnectCacheController", "otherRole"],
          imports: ["HWpc"],
        },
        { id: HASHED_NATIVE_CHAT_ROLES.appScopeModuleId, brands: ["AppScope"] },
        { id: HASHED_NATIVE_CHAT_ROLES.routeScopeModuleId, brands: ["RouteScope"] },
        { id: HASHED_NATIVE_CHAT_ROLES.composerScopeModuleId, brands: ["ComposerScope"] },
      ],
    });
    expect(result.kind).toBe("hashed-chat");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { code: "ambiguous-roles", details: ["VoiceInstantConnectCacheController"] },
      ]),
    );
  });

  it("rejects ambiguous hashed semantic roles", () => {
    const owned = {
      callees: ["initializeVoiceSession", "dispatchVoiceCommand", "startVoiceWithIntroduction"],
      exports: ["initializeVoiceSession", "VoiceInstantConnectCacheController"],
      brands: ["AppScope", "RouteScope", "ComposerScope"],
    };
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
      sources: [
        { id: "a", ...owned },
        { id: "b", ...owned },
      ],
    });
    expect(result.activation).toBe("rejected");
    expect(result.issues.map((issue) => issue.code)).toContain("ambiguous-roles");
  });

  it("does not treat caller structural fields as byte-verified AST facts", () => {
    const text = '/* initializeVoiceSession */ const docs = "AppScope";';
    const spoofed = {
      text,
      callees: ["initializeVoiceSession"],
      exports: ["initializeVoiceSession"],
      brands: ["VoiceInstantConnectCacheController"],
    };
    expect(sourceFingerprint(spoofed).interpretation).toBe("unvalidated-with-bytes");
    expect(
      sourceFingerprint({
        callees: ["initializeVoiceSession"],
        exports: ["initializeVoiceSession"],
      }).interpretation,
    ).toBe("snapshot-assertion");
    expect(
      sourceFingerprint({
        text,
        interpretationProvenance: "bytes-verified",
        callees: ["initializeVoiceSession"],
      }).interpretation,
    ).toBe("bytes-verified");
  });

  it("labels snapshot-assertion provenance on structure-only inventories", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: "26.9999.1",
      assets: ["start.renamed.js", "prewarm.renamed.js", "runtime.renamed.js"],
      sources: [
        {
          id: "start.renamed.js",
          path: "chunks/start.renamed.js",
          callees: ["startVoiceWithIntroduction"],
          exports: ["q3"],
        },
        {
          id: "prewarm.renamed.js",
          path: "chunks/prewarm.renamed.js",
          exports: ["z9"],
          brands: ["VoiceInstantConnectCacheController"],
        },
        {
          id: "runtime.renamed.js",
          path: "chunks/runtime.renamed.js",
          brands: ["AppScope", "RouteScope", "ComposerScope"],
        },
      ],
    });
    expect(result.kind).toBe("semantic-chat");
    expect(result.identity.interpretation).toBe("snapshot-assertion");
  });

  it("rejects a supplied digest that does not match present source bytes", () => {
    const text = "export function a9(){ return startVoiceWithIntroduction(); }";
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: "26.9999.1",
      assets: ["start.renamed.js"],
      sources: [{ id: "start.renamed.js", path: "start.renamed.js", digest: "stale-digest", text }],
    });
    expect(result.activation).toBe("rejected");
    expect(result.issues.map((issue) => issue.code)).toContain("digest-mismatch");
    expect(sourceFingerprint({ text, digest: "stale-digest" }).provenance).toBe("digest-mismatch");
  });

  it("invalidates replay when source bytes change under a retained digest", () => {
    const original = {
      platform: "darwin",
      desktopVersion: "26.9999.1",
      assets: ["start.renamed.js"],
      sources: [
        {
          id: "start.renamed.js",
          path: "start.renamed.js",
          digest: "aaa",
          text: "export function a9(){ return startVoiceWithIntroduction(); }",
        },
      ],
    };
    const fingerprint = fingerprintVoiceInventory(original);
    const replayed = replayVoiceDiscovery(
      {
        ...original,
        sources: [
          {
            id: "start.renamed.js",
            path: "start.renamed.js",
            digest: "aaa",
            text: "export function a9(){ return dispatchVoiceCommand(); }",
          },
        ],
      },
      fingerprint,
    );
    expect(replayed.activation).toBe("rejected");
    expect(replayed.issues.map((issue) => issue.code)).toContain("stale-inventory");
  });

  it("invalidates digest-only replay when structural interpretation changes", () => {
    const inventory = {
      platform: "darwin",
      desktopVersion: "26.9999.1",
      assets: ["start.renamed.js"],
      sources: [
        {
          id: "start.renamed.js",
          path: "start.renamed.js",
          digest: "same-bytes-never-read",
          callees: ["startVoiceWithIntroduction"],
        },
      ],
    };
    const fingerprint = fingerprintVoiceInventory(inventory);
    const digestOnlySource = inventory.sources?.[0] ?? { digest: "same-bytes-never-read" };
    expect(sourceFingerprint(digestOnlySource).provenance).toBe("digest-only");
    const replayed = replayVoiceDiscovery(
      {
        ...inventory,
        sources: [
          {
            id: "start.renamed.js",
            path: "start.renamed.js",
            digest: "same-bytes-never-read",
            callees: ["unrelatedCallee"],
          },
        ],
      },
      fingerprint,
    );
    expect(replayed.activation).toBe("rejected");
    expect(replayed.issues.map((issue) => issue.code)).toContain("stale-inventory");
  });

  it("maps renamed local identifiers from retained semantic literals and brands", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: "26.9999.1",
      desktopBuild: "99",
      bundleDigest: "candidate-bundle",
      assets: ["start.renamed.js", "prewarm.renamed.js", "runtime.renamed.js"],
      sources: [
        {
          id: "start.renamed.js",
          path: "chunks/start.renamed.js",
          callees: ["startVoiceWithIntroduction"],
          exports: ["q3"],
        },
        {
          id: "prewarm.renamed.js",
          path: "chunks/prewarm.renamed.js",
          exports: ["z9"],
          brands: ["VoiceInstantConnectCacheController"],
        },
        {
          id: "runtime.renamed.js",
          path: "chunks/runtime.renamed.js",
          brands: ["AppScope", "RouteScope", "ComposerScope"],
        },
      ],
    });
    expect(result.kind).toBe("semantic-chat");
    expect(result.activation).toBe("candidate");
    expect(result.roles).toMatchObject({
      start: "chunks/start.renamed.js",
      prewarm: "chunks/prewarm.renamed.js",
    });
  });

  it("invalidates replay when analyzed source bytes change", () => {
    const inventory = {
      platform: "darwin",
      desktopVersion: "26.9999.1",
      desktopBuild: "1",
      bundleDigest: "bundle-a",
      assets: ["start.renamed.js"],
      sources: [{ id: "start.renamed.js", path: "start.renamed.js", digest: "aaa" }],
    };
    const fingerprint = fingerprintVoiceInventory(inventory);
    const replayed = replayVoiceDiscovery(
      {
        ...inventory,
        sources: [{ id: "start.renamed.js", path: "start.renamed.js", digest: "bbb" }],
      },
      fingerprint,
    );
    expect(replayed.activation).toBe("rejected");
    expect(replayed.issues.map((issue) => issue.code)).toContain("stale-inventory");
  });

  it("maps a new-version renamed Chat layout from implementation ownership", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: "26.9999.1",
      desktopBuild: "99",
      bundleDigest: "candidate-bundle",
      assets: ["348410.renamed.js", "start.min.js", "prewarm.min.js"],
      sources: [
        {
          id: "start.min.js",
          path: "chunks/start.min.js",
          callees: ["initializeVoiceSession"],
          exports: ["initializeVoiceSession"],
        },
        {
          id: "prewarm.min.js",
          path: "chunks/prewarm.min.js",
          exports: ["VoiceInstantConnectCacheController"],
        },
        {
          id: "runtime.min.js",
          path: "chunks/runtime.min.js",
          brands: ["AppScope", "RouteScope", "ComposerScope"],
        },
      ],
    });
    expect(result.kind).toBe("semantic-chat");
    expect(result.activation).toBe("candidate");
    expect(result.roles).toMatchObject({
      start: "chunks/start.min.js",
      prewarm: "chunks/prewarm.min.js",
    });
  });

  it("does not treat comments or unused strings as Chat implementation", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: "26.9999.1",
      assets: ["decoy.js"],
      sources: [
        {
          id: "decoy.js",
          path: "decoy.js",
          literals: [
            "initializeVoiceSession",
            "VoiceInstantConnectCacheController",
            "AppScope",
            "RouteScope",
            "ComposerScope",
          ],
        },
      ],
    });
    expect(result.activation).toBe("rejected");
    expect(result.kind).toBe("unknown");
    expect(result.issues.map((issue) => issue.code)).toContain("wrong-role");
  });

  it("rejects hashed win32 26.1106 as reviewed-support wrong-platform, not missing loader", () => {
    const result = discoverVoiceCandidate({
      platform: "win32",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      asarDigest: "54b74a9131680fc9eead711ed5d9f718f6127c22222ca60d2e3b577a707e2485",
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
    });
    expect(result.kind).toBe("hashed-chat");
    expect(result.activation).toBe("rejected");
    expect(result.issues).toEqual([
      { code: "wrong-platform", details: [HASHED_WEBPACK_VOICE_VERSION] },
    ]);
  });

  it("reports exact hashed wrong-role details for n.d exports without scope brands", () => {
    const result = discoverVoiceCandidate({
      platform: "win32",
      desktopVersion: HASHED_WEBPACK_VOICE_VERSION,
      asarDigest: "54b74a9131680fc9eead711ed5d9f718f6127c22222ca60d2e3b577a707e2485",
      assets: [
        HASHED_WEBPACK_VOICE_RUNTIME_ASSET,
        HASHED_NATIVE_CHAT_START_ASSET,
        HASHED_NATIVE_CHAT_PREWARM_ASSET,
      ],
      sources: [
        {
          id: HASHED_NATIVE_CHAT_START_ASSET,
          path: HASHED_NATIVE_CHAT_START_ASSET,
          exports: ["initializeVoiceSession", "dispatchVoiceCommand", "startVoiceWithIntroduction"],
          imports: [
            HASHED_NATIVE_CHAT_ROLES.appScopeModuleId,
            HASHED_NATIVE_CHAT_ROLES.routeScopeModuleId,
            HASHED_NATIVE_CHAT_ROLES.composerScopeModuleId,
          ],
        },
        {
          id: HASHED_NATIVE_CHAT_PREWARM_ASSET,
          path: HASHED_NATIVE_CHAT_PREWARM_ASSET,
          exports: ["VoiceInstantConnectCacheController"],
        },
      ],
    });
    expect(result.kind).toBe("hashed-chat");
    expect(result.activation).toBe("rejected");
    expect(result.issues).toEqual([
      {
        code: "wrong-role",
        details: ["AppScope", "RouteScope", "ComposerScope"],
      },
      { code: "wrong-platform", details: [HASHED_WEBPACK_VOICE_VERSION] },
    ]);
  });

  it("does not treat a Work overlay asset as native Chat", () => {
    const result = discoverVoiceCandidate({
      platform: "darwin",
      desktopVersion: "26.1027.61615",
      assets: [
        "app-initial-18b189e867e7.js",
        "app-shared-601019a330d7.js",
        "avatar-overlay-native-page-920d05377bbe.js",
      ],
    });
    expect(result.kind).toBe("work");
    expect(result.identity.product).toBe("work");
  });
});
