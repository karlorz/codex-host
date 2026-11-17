import { readFile } from "node:fs/promises";
import path from "node:path";

export const VOICE_REVIEWED_EVIDENCE_RELATIVE = "voice-reviewed-evidence.json";

/** Accepted product paths must survive packaging independently of registry edits. */
export function requireAcceptedVoiceActivations(qualification) {
  for (const voicePath of ["chat", "work-codex", "work-grok"]) {
    if (
      !qualification.reviewedEvidence.some(
        (record) =>
          record.platform === "darwin" &&
          record.desktopVersion === "26.1106.51428" &&
          record.path === voicePath &&
          record.policy === "reviewed",
      )
    ) {
      throw new Error(`packaging would drop accepted macOS voice activation: ${voicePath}`);
    }
  }
}

function validateCompatibilityProvenance(record) {
  const tested = record.testedImplementationRevision;
  if (tested === undefined) return;
  if (typeof tested !== "string" || tested.length === 0) {
    throw new Error("reviewed voice evidence has no tested implementation revision");
  }
  if (record.speech?.implementationRevision !== tested) {
    throw new Error("reviewed voice evidence speech provenance does not match its tested revision");
  }
  if (tested === record.implementationRevision) return;
  const review = record.compatibilityReview;
  if (
    !review ||
    review.implementationRevision !== record.implementationRevision ||
    review.testedImplementationRevision !== tested ||
    typeof review.reference !== "string" ||
    review.reference.length === 0 ||
    typeof review.basis !== "string" ||
    review.basis.length === 0 ||
    !["path", "platform", "desktopVersion", "desktopBuild", "asarDigest"].every(
      (key) => review[key] === record[key],
    )
  ) {
    throw new Error("reviewed voice evidence requires a matching scoped compatibility review");
  }
}

/** Reviewed observations are data; implementation and evidence evaluation remain hashed source. */
export async function loadVoiceQualificationArtifact(packageRoot, profiles, evaluator) {
  const evidence = JSON.parse(
    await readFile(path.join(packageRoot, VOICE_REVIEWED_EVIDENCE_RELATIVE), "utf8"),
  );
  if (!Array.isArray(evidence)) throw new Error("reviewed voice evidence must be an array");
  const qualification = profiles.voiceQualificationArtifact();
  for (const record of evidence) {
    if (!evaluator.isVoiceEvidenceRecord(record) || record.policy !== "reviewed") {
      throw new Error("reviewed voice evidence contains an invalid record");
    }
    validateCompatibilityProvenance(record);
    const evaluation = evaluator.evaluateVoiceEvidence(record);
    if (
      record.implementationRevision !== qualification.implementationRevision ||
      !evaluation.qualified
    ) {
      throw new Error(`reviewed voice evidence is not qualified: ${evaluation.reason}`);
    }
  }
  return { ...qualification, reviewedEvidence: evidence };
}
