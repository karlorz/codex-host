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

function fallbackOrThrow(
  fallbackDefault: boolean,
  defaultModel: HarnessModelRef | undefined,
  harnessId: string,
  requested: HarnessModelRef,
  reason: string,
  error: () => DelegationControlError,
): { model: HarnessModelRef; log: string } {
  if (fallbackDefault && defaultModel) {
    return {
      model: defaultModel,
      log: fallbackLog(harnessId, requested.id, defaultModel.id, reason),
    };
  }
  throw error();
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
    const requested = model;
    if (!inspection.capabilities.configuration.selectModel) {
      throw namedError(
        "MODEL_SELECTION_UNSUPPORTED",
        `harness '${harnessId}' does not support Model selection`,
      );
    }
    const listed = catalogModelForRef(catalog, requested);
    const defaultModel = catalog.defaultModel;
    if (!listed) {
      const fallback = fallbackOrThrow(
        fallbackDefault,
        defaultModel,
        harnessId,
        requested,
        "model is not in the catalog",
        () =>
          namedError(
            "MODEL_NOT_IN_CATALOG",
            `model '${requested.id}' is not in the catalog for harness '${harnessId}'`,
            { validModelIds: catalogModelIds(catalog) },
          ),
      );
      logs.push(fallback.log);
      model = fallback.model;
      decision = "fallback-default";
    } else if (input.usability?.checked === true && input.usability.usable === false) {
      const usability = input.usability;
      const fallback = fallbackOrThrow(
        fallbackDefault,
        defaultModel,
        harnessId,
        requested,
        usability.reason ?? "model is not usable",
        () =>
          namedError(
            "MODEL_NOT_USABLE",
            `model '${requested.id}' is not usable on harness '${harnessId}'`,
            {
              ...(usability.reason ? { reason: usability.reason } : {}),
            },
          ),
      );
      logs.push(fallback.log);
      model = fallback.model;
      decision = "fallback-default";
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

  return {
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    decision,
    log: logs.join(" | "),
  };
}
