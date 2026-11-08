import type { PromptResponse } from "@agentclientprotocol/sdk";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { GrokAdapter } from "../src/grok-adapter.js";
import {
  grokPromptStopError,
  grokStopDetail,
  grokTurnStopError,
} from "../src/grok-stop-diagnostic.js";

describe("grok stop diagnostics", () => {
  it("prefers operator-readable _meta detail over a bare stopReason", () => {
    expect(grokStopDetail({ message: "model grok-4.6 is not usable" }, "error")).toBe(
      "model grok-4.6 is not usable",
    );
    expect(grokStopDetail({ error: "error" }, "error")).toBeUndefined();
    expect(
      grokTurnStopError("error", {
        message: "model grok-4.6 is not usable",
        code: "MODEL_NOT_AVAILABLE",
      }),
    ).toMatchObject({
      code: "nativeFailure",
      message: "Grok stopped the Turn: error: model grok-4.6 is not usable",
      diagnostic: expect.stringContaining("MODEL_NOT_AVAILABLE"),
    });
  });

  it("walks nested ACP _meta fields on PromptResponse", () => {
    expect(
      grokPromptStopError({
        stopReason: "error",
        _meta: { error: { message: "no entitlement for grok-4.6" } },
      } as PromptResponse),
    ).toMatchObject({
      message: "Grok stopped the Turn: error: no entitlement for grok-4.6",
      diagnostic: expect.stringContaining("no entitlement for grok-4.6"),
    });
  });
});

describe("GrokAdapter model usability", () => {
  it("cannot prove per-model entitlement before spawn", async () => {
    const adapter = new GrokAdapter({ environment: { PATH: "/usr/bin" } });
    try {
      await expect(
        adapter.isModelUsable({ model: harnessModelRefSchema.parse({ id: "grok-4.6" }) }),
      ).resolves.toEqual({
        usable: true,
        checked: false,
        reason:
          "Grok does not expose per-model entitlement before spawn; catalog membership is necessary, not sufficient.",
      });
    } finally {
      await adapter.close();
    }
  });
});
