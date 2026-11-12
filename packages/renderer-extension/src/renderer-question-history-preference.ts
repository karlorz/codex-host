export const HARNESS_QUESTION_HISTORY_STORAGE_KEY = "codexhost.harness-question-history.v1";
export const HARNESS_QUESTION_HISTORY_CHANGE_EVENT = "codexhost:harness-question-history-changed";

export type HarnessQuestionHistory = "selected" | "all";

/** Selected answers only is the default. `all` keeps every option in history. */
export function readHarnessQuestionHistory(
  owner: Window | null | undefined,
): HarnessQuestionHistory {
  if (!owner) return "selected";
  try {
    return owner.localStorage.getItem(HARNESS_QUESTION_HISTORY_STORAGE_KEY) === "all"
      ? "all"
      : "selected";
  } catch {
    return "selected";
  }
}

export function writeHarnessQuestionHistory(owner: Window, selectedOnly: boolean): boolean {
  try {
    owner.localStorage.setItem(
      HARNESS_QUESTION_HISTORY_STORAGE_KEY,
      selectedOnly ? "selected" : "all",
    );
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(HARNESS_QUESTION_HISTORY_CHANGE_EVENT));
  return true;
}
