import type { BackgroundActivityDetail } from "@codexhost/shared-contracts";

/** Preserve native prompt text while keeping schedule instructions out of the main card. */
export function appendActivityOutput(
  parent: HTMLElement,
  detail: BackgroundActivityDetail,
  expanded: boolean,
  onExpanded: (expanded: boolean) => void,
): void {
  const document = parent.ownerDocument;
  if (detail.activity.kind !== "loop") {
    const output = document.createElement("pre");
    output.className = "activity-process-output";
    output.textContent = detail.output || "No native output available yet.";
    parent.append(output);
    return;
  }
  const prompt = detail.output || "No native prompt available yet.";
  const firstBreak = /\r\n|[\r\n]/.exec(prompt);
  const title = firstBreak ? prompt.slice(0, firstBreak.index) : prompt;
  const instructions = firstBreak ? prompt.slice(firstBreak.index + firstBreak[0].length) : "";
  const heading = document.createElement("h4");
  heading.className = "activity-prompt-title text-sm font-medium";
  heading.textContent = title;
  parent.append(heading);
  if (!instructions) return;
  const disclosure = document.createElement("details");
  disclosure.open = expanded;
  const summary = document.createElement("summary");
  summary.className = "text-sm text-secondary";
  summary.textContent = "Schedule instructions";
  const body = document.createElement("div");
  body.className = "activity-prompt-instructions text-sm";
  body.textContent = instructions;
  disclosure.append(summary, body);
  disclosure.addEventListener("toggle", () => {
    if (disclosure.isConnected) onExpanded(disclosure.open);
  });
  parent.append(disclosure);
}
