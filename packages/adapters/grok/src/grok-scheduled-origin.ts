import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HostSubagentState } from "@codexhost/harness-adapter";

const SCHEDULED_PROMPT_HEADER = /^<system-reminder>\nScheduled task (\S+) \(/;

export function grokScheduledTaskIdFromPrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  return prompt.match(SCHEDULED_PROMPT_HEADER)?.[1];
}

export async function readGrokSubagentPrompt(
  sessionDirectory: string,
  nativeSubagentId: string,
): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(
        path.join(sessionDirectory, "subagents", nativeSubagentId, "meta.json"),
        "utf8",
      ),
    );
    return typeof raw === "object" &&
      raw !== null &&
      "prompt" in raw &&
      typeof raw.prompt === "string"
      ? raw.prompt
      : undefined;
  } catch {
    return undefined;
  }
}

/** Tags loop-run children from live fired IDs or a matching native prompt header. */
export async function tagGrokScheduledActivityChildren(input: {
  directory: string;
  children: Map<string, HostSubagentState>;
  scheduledTaskIds?: ReadonlySet<string>;
  scheduledChildIds?: ReadonlySet<string>;
  attempted: Set<string>;
}): Promise<void> {
  const scheduledChildIds = input.scheduledChildIds;
  const scheduledTaskIds = input.scheduledTaskIds;
  const pendingMeta: string[] = [];
  for (const [id, child] of input.children) {
    if (child.origin === "scheduled") {
      input.attempted.add(id);
      continue;
    }
    if (scheduledChildIds?.has(id)) {
      input.children.set(id, { ...child, origin: "scheduled" });
      input.attempted.add(id);
      continue;
    }
    if (input.attempted.has(id) || !scheduledTaskIds?.size) continue;
    pendingMeta.push(id);
    input.attempted.add(id);
  }
  if (pendingMeta.length === 0 || !scheduledTaskIds?.size) return;
  const prompts = await Promise.all(
    pendingMeta.map((id) => readGrokSubagentPrompt(input.directory, id)),
  );
  for (const [index, id] of pendingMeta.entries()) {
    const current = input.children.get(id);
    if (!current || current.origin === "scheduled") continue;
    const taskId = grokScheduledTaskIdFromPrompt(prompts[index]);
    if (taskId && scheduledTaskIds.has(taskId)) {
      input.children.set(id, { ...current, origin: "scheduled" });
    }
  }
}
