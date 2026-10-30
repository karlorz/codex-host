import type { HarnessResult } from "@codexhost/harness-adapter";
import { harnessCommandCatalogSchema, type JsonObject } from "@codexhost/shared-contracts";

export const grokCommandCatalog = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "grok.compact",
      invocation: "/compact",
      localizations: { "zh-CN": { label: "压缩上下文", description: "压缩当前对话上下文" } },
      label: "Compact context",
      description: "Compact the current conversation context",
      argumentMode: "text",
    },
    {
      id: "grok.goal",
      invocation: "/grok-goal",
      label: "Grok goal",
      description: "Set an objective [--budget tokens], or status / pause / resume / clear",
      localizations: {
        "zh-CN": {
          label: "Grok 目标",
          description: "设置原生目标与可选 token 预算，或 status / pause / resume / clear",
        },
      },
      argumentMode: "text",
    },
  ],
});

/** Keep argument interpretation and goal state in Grok's native slash-command handler. */
export function grokGoalPrompt(arguments_: JsonObject | undefined): HarnessResult<string> {
  if (
    arguments_ &&
    (Object.keys(arguments_).some((key) => key !== "text") ||
      (arguments_.text !== undefined && typeof arguments_.text !== "string"))
  ) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Grok goal accepts only a text argument",
        retryable: false,
      },
    };
  }
  const text = typeof arguments_?.text === "string" ? arguments_.text.trim() : "";
  return { ok: true, value: text ? `/goal ${text}` : "/goal" };
}
