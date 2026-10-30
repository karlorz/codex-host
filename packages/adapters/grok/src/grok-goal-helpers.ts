import type { GrokTransportEvent } from "./acp-transport.js";
import { type GrokHistoryGroup } from "./grok-history-groups.js";

/** Keep pre-input planners and post-terminal summaries inside their native owning Turn. */
export function placeGrokGoalHelpers(
  replay: readonly GrokTransportEvent[],
  groups: readonly GrokHistoryGroup[],
): GrokTransportEvent[] {
  const nextRewind = new Map<number, number>();
  let boundary = replay.length;
  for (let i = replay.length - 1; i >= 0; i--) {
    if (replay[i]?.type === "rewind.marker") boundary = i;
    if (replay[i]?.type === "turn.completed") nextRewind.set(i, boundary);
  }
  const owners = new Map<string, { start: number; end: number; terminal: number }[]>();
  let start = 0;
  for (const group of groups) {
    if (group.disposition !== "durable" || group.userIndex === undefined) continue;
    const terminal = group.terminalIndex;
    const entries = owners.get(group.terminal.nativeTurnKey) ?? [];
    entries.push({
      start: group.userIndex,
      end: nextRewind.get(terminal) ?? replay.length,
      terminal,
    });
    owners.set(group.terminal.nativeTurnKey, entries);
  }
  const pending = new Map<string, { at: number; end: number }>();
  const inserts = new Map<number, GrokTransportEvent[]>();
  const moved = new Set<GrokTransportEvent>();
  for (const [index, event] of replay.entries()) {
    if (event.type === "rewind.marker") {
      pending.clear();
      start = index + 1;
    }
    if (event.type === "subagent.spawned" && event.parentPromptId) {
      const owner = owners
        .get(event.parentPromptId)
        ?.find((g) => g.terminal >= start && index < g.end);
      if (!owner) {
        moved.add(event);
        continue;
      }
      pending.set(event.nativeSubagentId, {
        at: Math.max(owner.start + 1, Math.min(index, owner.terminal)),
        end: owner.terminal,
      });
    }
    if (event.type !== "subagent.spawned" && event.type !== "subagent.finished") continue;
    const placement = pending.get(event.nativeSubagentId);
    if (!placement) continue;
    const at = Math.max(placement.at, Math.min(index, placement.end));
    const list = inserts.get(at) ?? [];
    list.push(event);
    inserts.set(at, list);
    moved.add(event);
  }
  return replay.flatMap((event, index) => [
    ...(inserts.get(index) ?? []),
    ...(moved.has(event) ? [] : [event]),
  ]);
}
