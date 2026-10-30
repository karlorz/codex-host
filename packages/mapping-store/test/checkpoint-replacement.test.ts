import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { MappingStore } from "../src/index.js";

it("replaces a ready mapping with an exact shorter Host prefix", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-checkpoint-replacement-"));
  const store = new MappingStore({ directory });
  try {
    await store.initialize();
    const harnessId = harnessIdSchema.parse("pi");
    const hostThreadId = hostThreadIdSchema.parse("checkpoint-thread");
    const source = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "source",
      formatVersion: 1,
    });
    const replacement = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "replacement",
      formatVersion: 1,
    });
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create",
      harnessId,
      cwd: "/synthetic",
      transportModelId: "pi",
      ephemeral: false,
      historyMode: "paginated",
    });
    const original = await store.commitReady({
      hostThreadId,
      nativeSessionRef: source,
      turnMappings: [1, 2, 3].map((n) => ({
        hostTurnId: hostTurnIdSchema.parse(`turn-${n}`),
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId,
          nativeSessionId: "source",
          nativeTurnKey: `native-${n}`,
          formatVersion: 1,
        }),
      })),
    });
    await expect(
      store.replaceReadySessionAfterRollback({
        hostThreadId,
        expectedRevision: original.revision,
        expectedNativeSessionRef: source,
        nativeSessionRef: replacement,
        turnMappings: original.turnMappings.slice(0, 1).map((mapping) => ({
          ...mapping,
          nativeTurnRef: { ...mapping.nativeTurnRef, nativeSessionId: "replacement" },
        })),
        numTurns: 2,
      }),
    ).resolves.toMatchObject({ turnMappings: [{ hostTurnId: "turn-1" }] });
    await expect(
      store.replaceReadySessionAfterRollback({
        hostThreadId,
        expectedRevision: original.revision + 1,
        expectedNativeSessionRef: source,
        nativeSessionRef: replacement,
        turnMappings: [],
        numTurns: 1,
      }),
    ).rejects.toMatchObject({ code: "MAPPING_CONFLICT" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
