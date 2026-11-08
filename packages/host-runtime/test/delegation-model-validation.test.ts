import type { HarnessInspection } from "@codexhost/harness-adapter";
import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { resolveDelegationStartConfiguration } from "../src/delegation-model-validation.js";

const catalog = harnessModelCatalogSchema.parse({
  models: [
    {
      ref: { id: "listed" },
      label: "Listed",
      supportedThinkingOptionIds: ["high"],
    },
  ],
  defaultModel: { id: "listed" },
  thinkingOptions: [{ id: "high", label: "High" }],
  defaultThinkingOptionId: "high",
});

const ready: Extract<HarnessInspection, { status: "ready" }> = {
  status: "ready",
  catalog,
  capabilities: {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
};

describe("resolveDelegationStartConfiguration", () => {
  it("logs the harness default when no Model is requested", () => {
    const resolved = resolveDelegationStartConfiguration({
      harnessId: "grok",
      fallbackDefault: false,
    });
    expect(resolved).toMatchObject({ decision: "harness-default" });
    expect(resolved.model).toBeUndefined();
    expect(resolved.log).toContain("native default");
    expect(resolved.log).toContain("fallback-default=false");
  });

  it("rejects an unknown Model with MODEL_NOT_IN_CATALOG", () => {
    expect(() =>
      resolveDelegationStartConfiguration({
        harnessId: "grok",
        inspection: ready,
        model: { id: "grok-4.6" },
      }),
    ).toThrow("MODEL_NOT_IN_CATALOG: model 'grok-4.6' is not in the catalog for harness 'grok'");
  });

  it("rejects a proven-unusable Model with MODEL_NOT_USABLE", () => {
    expect(() =>
      resolveDelegationStartConfiguration({
        harnessId: "grok",
        inspection: ready,
        model: { id: "listed" },
        usability: { usable: false, checked: true, reason: "no entitlement" },
      }),
    ).toThrow("MODEL_NOT_USABLE: model 'listed' is not usable on harness 'grok'");
  });

  it("does not silently fall back unless fallbackDefault is true", () => {
    const withoutFlag = () =>
      resolveDelegationStartConfiguration({
        harnessId: "grok",
        inspection: ready,
        model: { id: "missing" },
      });
    expect(withoutFlag).toThrow(/MODEL_NOT_IN_CATALOG/);
    const resolved = resolveDelegationStartConfiguration({
      harnessId: "grok",
      inspection: ready,
      model: { id: "missing" },
      fallbackDefault: true,
    });
    expect(resolved.model).toEqual({ id: "listed" });
    expect(resolved.decision).toBe("fallback-default");
    expect(resolved.log).toContain("falling back");
    expect(resolved.log).toContain("--fallback-default");
  });

  it("logs and keeps the requested Model when entitlement cannot be checked", () => {
    const resolved = resolveDelegationStartConfiguration({
      harnessId: "grok",
      inspection: ready,
      model: { id: "listed" },
      usability: {
        usable: true,
        checked: false,
        reason: "Grok does not expose per-model entitlement before spawn",
      },
    });
    expect(resolved.model).toEqual({ id: "listed" });
    expect(resolved.decision).toBe("requested");
    expect(resolved.log).toContain("cannot be checked before spawn");
  });
});
