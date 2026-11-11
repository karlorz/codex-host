import { describe, expect, it, vi } from "vitest";

import {
  HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT,
  HARNESS_QUESTION_PLACEMENT_STORAGE_KEY,
  readHarnessQuestionPlacement,
  writeHarnessQuestionPlacement,
} from "../src/renderer-question-placement-preference.js";

function fixture(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(HARNESS_QUESTION_PLACEMENT_STORAGE_KEY, initial);
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const owner = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window;
  return { owner, values };
}

describe("Harness question placement preference", () => {
  it("defaults to in-chat, stores overlay, and notifies listeners", () => {
    const unset = fixture();
    expect(readHarnessQuestionPlacement(unset.owner)).toBe("in-chat");
    expect(readHarnessQuestionPlacement(null)).toBe("in-chat");
    expect(readHarnessQuestionPlacement(undefined)).toBe("in-chat");

    const events: string[] = [];
    unset.owner.addEventListener(HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT, () =>
      events.push("changed"),
    );
    expect(writeHarnessQuestionPlacement(unset.owner, false)).toBe(true);
    expect(unset.values.get(HARNESS_QUESTION_PLACEMENT_STORAGE_KEY)).toBe("overlay");
    expect(readHarnessQuestionPlacement(unset.owner)).toBe("overlay");
    expect(events).toEqual(["changed"]);

    expect(writeHarnessQuestionPlacement(unset.owner, true)).toBe(true);
    expect(unset.values.get(HARNESS_QUESTION_PLACEMENT_STORAGE_KEY)).toBe("in-chat");
    expect(readHarnessQuestionPlacement(unset.owner)).toBe("in-chat");
  });

  it("stays in-chat when localStorage throws", () => {
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
    expect(readHarnessQuestionPlacement(owner)).toBe("in-chat");
    expect(writeHarnessQuestionPlacement(owner, false)).toBe(false);
  });
});
