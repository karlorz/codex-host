import type {
  HarnessInspection,
  HarnessModelRef,
  HarnessModelUsability,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";
import { catalogModelForRef } from "@codexhost/shared-contracts";

import {
  DelegationControlError,
  type DelegationModelResolutionDecision,
} from "./delegation-types.js";

export type { HarnessModelUsability, DelegationModelResolutionDecision };

export interface ResolvedDelegationStartConfiguration {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  decision: DelegationModelResolutionDecision;
  log: string;
}

function catalogModelIds(
  catalog: Extract<HarnessInspection, { status: "ready" }>["catalog"],
): string[] {
  return catalog.models.flatMap((candidate) =>
    candidate.fastModel ? [candidate.ref.id, candidate.fastModel.id] : [candidate.ref.id],
  );
}

function namedError(
  code:
    | "MODEL_NOT_IN_CATALOG"
    | "MODEL_NOT_USABLE"
    | "THINKING_NOT_AVAILABLE"
    | "MODEL_SELECTION_UNSUPPORTED"
    | "THINKING_SELECTION_UNSUPPORTED"
    | "DELEGATION_FAILED",
  message: string,
  details?: Record<string, unknown>,
): DelegationControlError {
  return new DelegationControlError(code, `${code}: ${message}`, details);
}

function readyInspection(
  inspection: HarnessInspection | undefined,
  harnessId: string,
): Extract<HarnessInspection, { status: "ready" }> {
  if (inspection?.status === "ready") return inspection;
  throw new DelegationControlError(
    "DELEGATION_FAILED",
    inspection ? inspection.error.message : `Harness '${harnessId}' Model catalog is unavailable`,
    ...(inspection ? [{ status: inspection.status }] : []),
  );
}

function fallbackLog(
  harnessId: string,
  requested: string,
  fallbackId: string,
  reason: string,
): string {
  return `MODEL_RESOLUTION: falling back to harness '${harnessId}' default model '${fallbackId}' because ${reason}; requested '${requested}' (--fallback-default)`;
}

/**
 * Validate `--model`/`--thinking` against the inspected catalog and optional
 * entitlement probe. Does not start a Turn. `fallbackDefault` is the only way
 * a requested Model is replaced with the Harness default.
 */
export function resolveDelegationStartConfiguration(input: {
  harnessId: string;
  inspection?: HarnessInspection;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  fallbackDefault?: boolean;
  usability?: HarnessModelUsability;
}): ResolvedDelegationStartConfiguration {
  const fallbackDefault = input.fallbackDefault === true;
  const harnessId = input.harnessId;
  if (!input.model && !input.thinkingOptionId) {
    return {
      decision: "harness-default",
      log: `MODEL_RESOLUTION: using harness '${harnessId}' native default (no --model; fallback-default=${fallbackDefault})`,
    };
  }

  const inspection = readyInspection(input.inspection, harnessId);
  const catalog = inspection.catalog;
  let model = input.model;
  let thinkingOptionId = input.thinkingOptionId;
  let decision: DelegationModelResolutionDecision = input.model ? "requested" : "harness-default";
  const logs: string[] = [];

  if (model) {
    if (!inspection.capabilities.configuration.selectModel) {
      throw namedError(
        "MODEL_SELECTION_UNSUPPORTED",
        `harness '${harnessId}' does not support Model selection`,
      );
    }
    const listed = catalogModelForRef(catalog, model);
    const defaultModel = catalog.defaultModel;
    if (!listed) {
      if (fallbackDefault && defaultModel) {
        logs.push(fallbackLog(harnessId, model.id, defaultModel.id, `model is not in the catalog`));
        model = defaultModel;
        decision = "fallback-default";
      } else {
        throw namedError(
          "MODEL_NOT_IN_CATALOG",
          `model '${model.id}' is not in the catalog for harness '${harnessId}'`,
          { validModelIds: catalogModelIds(catalog) },
        );
      }
    } else if (input.usability?.checked === true && input.usability.usable === false) {
      if (fallbackDefault && defaultModel) {
        logs.push(
          fallbackLog(
            harnessId,
            model.id,
            defaultModel.id,
            input.usability.reason ?? "model is not usable",
          ),
        );
        model = defaultModel;
        decision = "fallback-default";
      } else {
        throw namedError(
          "MODEL_NOT_USABLE",
          `model '${model.id}' is not usable on harness '${harnessId}'`,
          {
            ...(input.usability.reason ? { reason: input.usability.reason } : {}),
          },
        );
      }
    } else if (input.usability?.checked === false) {
      logs.push(
        `MODEL_RESOLUTION: using requested model '${model.id}' on harness '${harnessId}'; entitlement cannot be checked before spawn${input.usability.reason ? ` (${input.usability.reason})` : ""}`,
      );
    } else {
      logs.push(
        `MODEL_RESOLUTION: using requested model '${model.id}' on harness '${harnessId}' (no fallback)`,
      );
    }
  } else {
    logs.push(
      `MODEL_RESOLUTION: using harness '${harnessId}' native default Model with explicit Thinking (fallback-default=${fallbackDefault})`,
    );
  }

  if (thinkingOptionId) {
    if (!inspection.capabilities.configuration.selectThinkingOption) {
      throw namedError(
        "THINKING_SELECTION_UNSUPPORTED",
        `harness '${harnessId}' does not support Thinking selection`,
      );
    }
    const selectedModel = model ?? catalog.defaultModel;
    const modelEntry = selectedModel ? catalogModelForRef(catalog, selectedModel) : undefined;
    const validThinkingOptionIds = modelEntry?.supportedThinkingOptionIds ?? [];
    if (!validThinkingOptionIds.includes(thinkingOptionId)) {
      if (fallbackDefault) {
        logs.push(
          `MODEL_RESOLUTION: dropping requested thinking '${thinkingOptionId}' on harness '${harnessId}' (--fallback-default); valid=${JSON.stringify(validThinkingOptionIds)}`,
        );
        thinkingOptionId = undefined;
        if (decision === "requested") decision = "fallback-default";
      } else {
        throw namedError(
          "THINKING_NOT_AVAILABLE",
          `thinking '${thinkingOptionId}' is not available for model '${selectedModel?.id ?? "default"}' on harness '${harnessId}'`,
          { validThinkingOptionIds },
        );
      }
    }
  }

  if (logs.length === 0) {
    logs.push(
      `MODEL_RESOLUTION: using harness '${harnessId}' native default (fallback-default=${fallbackDefault})`,
    );
  }

  return {
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    decision,
    log: logs.join(" | "),
  };
}
