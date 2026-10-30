import type { HarnessGoal, HarnessGoalOrigin, HarnessGoalSet } from "@codexhost/shared-contracts";
import type { HarnessResult } from "./text-session.js";

/** Confirm native state independently of conversation Turns. Never starts a Host scheduler. */
export interface HarnessGoalCapability {
  read(): Promise<HarnessResult<HarnessGoal | null>>;
  set(input: HarnessGoalSet): Promise<HarnessResult<HarnessGoal>>;
  clear(input: { origin: HarnessGoalOrigin }): Promise<HarnessResult<{ cleared: boolean }>>;
}
