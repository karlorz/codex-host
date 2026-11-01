import { describe, expect, it } from "vitest";
import { hostThreadIdSchema, type BackgroundActivity } from "@codexhost/shared-contracts";
import {
  activityCountdown,
  activitySummaryLabel,
  supplementalBackgroundActivities,
} from "../src/renderer-background-activity.js";

const task: BackgroundActivity = {
  id: "task",
  kind: "task",
  label: "Restored process",
  status: "running",
  canStop: true,
};
const loop: BackgroundActivity = {
  id: "loop",
  kind: "loop",
  label: "Schedule",
  status: "scheduled",
  canStop: true,
};
describe("native summary activity presentation", () => {
  it("uses a compact native label and leaves multiline instructions to details", () => {
    expect(
      activitySummaryLabel({ ...loop, label: "  Check\tstatus.\nFull native instructions." }),
    ).toBe("Check status.");
    expect(activitySummaryLabel({ ...loop, label: "x".repeat(1000) })).toBe("x".repeat(71) + "…");
    expect(activitySummaryLabel({ ...loop, label: "🔁".repeat(73) })).toBe("🔁".repeat(71) + "…");
    expect(activitySummaryLabel({ ...loop, label: "\n\t" })).toBe("Loop schedule");
    expect(activitySummaryLabel({ ...task, label: " " })).toBe("Background process");
  });
  it("leaves commands and genuine children in native UI, retaining schedules and unassociated processes", () => {
    const child: BackgroundActivity = {
      ...task,
      id: "child",
      kind: "subagent",
      threadId: hostThreadIdSchema.parse("child-thread"),
      canStop: false,
    };
    const represented = ["task", "monitor"].map(
      (kind) => ({ ...task, kind, commandItemId: "native-item" }) as BackgroundActivity,
    );
    const original = [loop, task, child, ...represented];
    expect(supplementalBackgroundActivities(original)).toEqual([loop, task]);
    expect(original).toContain(child);
    expect(supplementalBackgroundActivities([child, ...represented])).toEqual([]);
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "hides a terminal-only %s registry",
    (status) => {
      expect(supplementalBackgroundActivities([{ ...task, status }])).toEqual([]);
      expect(supplementalBackgroundActivities([{ ...task, status }, loop])).toEqual([
        { ...task, status },
        loop,
      ]);
    },
  );
  it("keeps unknown native processes visible", () => {
    expect(supplementalBackgroundActivities([{ ...task, status: "unknown" }])).toHaveLength(1);
  });
  it("renders native timestamps without dispatching work", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(activityCountdown("2026-11-01T00:01:00Z", now)).toBe("Next in 1:00");
    expect(activityCountdown("2026-11-01T00:00:00Z", now)).toBe("Waiting for Harness");
    expect(activityCountdown(undefined, now)).toBe("");
    expect(activityCountdown("invalid", now)).toBe("");
  });
});
