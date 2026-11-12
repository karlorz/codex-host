import { describe, expect, it, vi } from "vitest";

import {
  HARNESS_QUESTION_HISTORY_CHANGE_EVENT,
  HARNESS_QUESTION_HISTORY_STORAGE_KEY,
  readHarnessQuestionHistory,
  writeHarnessQuestionHistory,
} from "../src/renderer-question-history-preference.js";

function fixture(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(HARNESS_QUESTION_HISTORY_STORAGE_KEY, initial);
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const owner = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window;
  return { owner, values };
}

describe("Harness question history preference", () => {
  it("defaults to selected answers, stores all options, and notifies listeners", () => {
    const unset = fixture();
    expect(readHarnessQuestionHistory(unset.owner)).toBe("selected");
    expect(readHarnessQuestionHistory(null)).toBe("selected");
    expect(readHarnessQuestionHistory(undefined)).toBe("selected");

    const events: string[] = [];
    unset.owner.addEventListener(HARNESS_QUESTION_HISTORY_CHANGE_EVENT, () =>
      events.push("changed"),
    );
    expect(writeHarnessQuestionHistory(unset.owner, false)).toBe(true);
    expect(unset.values.get(HARNESS_QUESTION_HISTORY_STORAGE_KEY)).toBe("all");
    expect(readHarnessQuestionHistory(unset.owner)).toBe("all");
    expect(events).toEqual(["changed"]);

    expect(writeHarnessQuestionHistory(unset.owner, true)).toBe(true);
    expect(unset.values.get(HARNESS_QUESTION_HISTORY_STORAGE_KEY)).toBe("selected");
    expect(readHarnessQuestionHistory(unset.owner)).toBe("selected");
  });

  it("stays on selected answers when localStorage throws", () => {
    const owner = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    }) as unknown as Window;
    expect(readHarnessQuestionHistory(owner)).toBe("selected");
    expect(writeHarnessQuestionHistory(owner, false)).toBe(false);
  });
});
