import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type GrokPermissionMode = "ask" | "auto" | "always-approve";
export type GrokSessionMode = "default" | "plan";

const nativePermissionModes = new Set<GrokPermissionMode>(["ask", "auto", "always-approve"]);

export const GROK_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("ask");
export const GROK_PLAN_MODE_ID = harnessPermissionModeIdSchema.parse("plan");

export const GROK_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
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
        localizations: { "zh-CN": { label: "询问", description: "执行受保护的工具操作前询问。" } },
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
    defaultModeId: GROK_DEFAULT_PERMISSION_MODE_ID,
  });

export function isGrokPlanModeId(permissionModeId: HarnessPermissionModeId | undefined): boolean {
  return String(permissionModeId ?? "") === "plan";
}

export function isGrokSessionMode(value: string): value is GrokSessionMode {
  return value === "default" || value === "plan";
}

export function decodeGrokPermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): GrokPermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as GrokPermissionMode)) {
    throw new Error("Grok Permission Mode belongs to another Adapter");
  }
  return parsed as GrokPermissionMode;
}

export function grokCatalogPermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): HarnessPermissionModeId {
  if (isGrokPlanModeId(permissionModeId)) return GROK_PLAN_MODE_ID;
  return harnessPermissionModeIdSchema.parse(decodeGrokPermissionModeId(permissionModeId));
}

/** Create uses Ask flags when the picker is Plan. Resume with Plan omits flags so native YOLO stays. */
export function grokOpenPermissionPolicy(
  permissionModeId: HarnessPermissionModeId,
  kind: "create" | "resume",
): GrokPermissionMode | undefined {
  if (isGrokPlanModeId(permissionModeId)) return kind === "create" ? "ask" : undefined;
  return decodeGrokPermissionModeId(permissionModeId);
}

export function grokPermissionModeSessionMeta(permissionMode: GrokPermissionMode): {
  yoloMode: boolean;
  autoMode: boolean;
} {
  return {
    yoloMode: permissionMode === "always-approve",
    autoMode: permissionMode === "auto",
  };
}
