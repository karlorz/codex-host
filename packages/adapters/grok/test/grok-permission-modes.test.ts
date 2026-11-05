import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  GROK_PERMISSION_MODE_CATALOG,
  GROK_PLAN_MODE_ID,
  decodeGrokPermissionModeId,
  grokCatalogPermissionModeId,
  grokOpenPermissionPolicy,
  grokPermissionModeSessionMeta,
  isGrokPlanModeId,
} from "../src/index.js";

describe("Grok Permission Modes", () => {
  it("matches the native Grok Build Permission Mode picker", () => {
    expect(GROK_PERMISSION_MODE_CATALOG).toEqual({
      modes: [
        {
          id: "plan",
          label: "Plan",
          localizations: {
            "zh-CN": {
              label: "规划模式",
              description:
                "先探索并写计划；批准后退出规划并开始实现。工具权限仍由询问/自动/始终批准决定。",
            },
          },
          description:
            "Explore and write a plan; approval exits planning and starts implementation. Tool permission stays Ask, Auto, or Always approve.",
        },
        {
          id: "ask",
          label: "Ask",
          localizations: {
            "zh-CN": { label: "询问", description: "执行受保护的工具操作前询问。" },
          },
          description: "Ask before protected tool actions.",
        },
        {
          id: "auto",
          label: "Auto",
          localizations: {
            "zh-CN": { label: "自动", description: "由 Grok Build 决定哪些工具操作可自动运行。" },
          },
          description: "Let Grok Build decide which tool actions may run automatically.",
        },
        {
          id: "always-approve",
          label: "Always approve",
          localizations: {
            "zh-CN": { label: "始终批准", description: "无需提示即可批准所有工具操作。" },
          },
          description: "Approve all tool actions without prompting.",
          dangerous: true,
        },
      ],
      defaultModeId: "ask",
    });
  });

  it.each([
    ["ask", { yoloMode: false, autoMode: false }],
    ["auto", { yoloMode: false, autoMode: true }],
    ["always-approve", { yoloMode: true, autoMode: false }],
  ] as const)("maps %s to native create metadata", (mode, expected) => {
    const permissionModeId = harnessPermissionModeIdSchema.parse(mode);
    expect(grokPermissionModeSessionMeta(decodeGrokPermissionModeId(permissionModeId))).toEqual(
      expected,
    );
  });

  it("keeps Plan as a session mode overlay on the Ask/Auto/Always-approve policy", () => {
    expect(isGrokPlanModeId(GROK_PLAN_MODE_ID)).toBe(true);
    expect(grokCatalogPermissionModeId(GROK_PLAN_MODE_ID)).toBe("plan");
    expect(() => decodeGrokPermissionModeId(GROK_PLAN_MODE_ID)).toThrow(
      "Grok Permission Mode belongs to another Adapter",
    );
    expect(grokOpenPermissionPolicy(GROK_PLAN_MODE_ID, "create")).toBe("ask");
    expect(grokOpenPermissionPolicy(GROK_PLAN_MODE_ID, "resume")).toBeUndefined();
    expect(
      grokOpenPermissionPolicy(harnessPermissionModeIdSchema.parse("always-approve"), "resume"),
    ).toBe("always-approve");
  });
});
