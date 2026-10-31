import type { HostAgentMessageItem, HostItemSnapshot } from "@codexhost/harness-adapter";

/** Durable goal output also contains native PersistOnly messages absent from ACP streaming. */
export function settledGrokAgentMessages(
  persisted: readonly HostItemSnapshot[],
  completedItems: readonly HostItemSnapshot[],
): HostAgentMessageItem[] {
  const messages = persisted.flatMap(({ item }) => (item.type === "agentMessage" ? [item] : []));
  const completed = new Set(completedItems.map(({ item }) => item.itemId));
  return messages.flatMap((item, index) => {
    const phase = index === messages.length - 1 ? "final_answer" : "commentary";
    if (completed.has(item.itemId)) return [];
    return [{ ...item, phase }];
  });
}
