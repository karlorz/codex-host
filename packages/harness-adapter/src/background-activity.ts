import type {
  BackgroundActivity,
  BackgroundActivityDetail,
  BackgroundActivityStopResult,
} from "@codexhost/shared-contracts";
import type { HarnessResult, HostSubagentState } from "./text-session.js";

/** Session-owned native activity. Reads and controls never create conversation Turns. */
export interface HarnessBackgroundActivityCapability {
  list(): Promise<HarnessResult<readonly BackgroundActivity[]>>;
  read(id: string): Promise<HarnessResult<BackgroundActivityDetail>>;
  stop(id: string): Promise<HarnessResult<BackgroundActivityStopResult>>;
  /** Native child identities for generic Host materialization, independent of a parent Turn. */
  subagents?(): readonly { activityId: string; state: HostSubagentState }[];
}
