export const HARNESS_QUESTION_PLACEMENT_STORAGE_KEY = "codexhost.harness-question-placement.v1";
export const HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT =
  "codexhost:harness-question-placement-changed";

export type HarnessQuestionPlacement = "in-chat" | "overlay";

/** In-chat is the default. Overlay restores the above-Composer live picker. */
export function readHarnessQuestionPlacement(
  owner: Window | null | undefined,
): HarnessQuestionPlacement {
  if (!owner) return "in-chat";
  try {
    return owner.localStorage.getItem(HARNESS_QUESTION_PLACEMENT_STORAGE_KEY) === "overlay"
      ? "overlay"
      : "in-chat";
  } catch {
    return "in-chat";
  }
}

export function writeHarnessQuestionPlacement(owner: Window, inChat: boolean): boolean {
  try {
    owner.localStorage.setItem(
      HARNESS_QUESTION_PLACEMENT_STORAGE_KEY,
      inChat ? "in-chat" : "overlay",
    );
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT));
  return true;
}
