import { describe, expect, it, vi } from "vitest";

import {
  composerHidesNativeGoalControl,
  isNativeGoalControlCandidate,
  reconcileComposerNativeControls,
  type ComposerAgentControl,
} from "../src/renderer-composer-dom.js";

function goalButton(options: {
  label?: string | null;
  owned?: boolean;
  text?: string;
  tag?: string;
}): {
  click: ReturnType<typeof vi.fn>;
  hidden: boolean;
  attributes: Map<string, string>;
  element: Element;
} {
  const attributes = new Map<string, string>();
  if (options.label != null) attributes.set("aria-label", options.label);
  if (options.owned) attributes.set("data-codexhost-agent-control", "composer-1");
  const click = vi.fn();
  const record = {
    click,
    hidden: false,
    attributes,
    textContent: options.text ?? "Goal",
    closest: () => null,
    contains: () => false,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    hasAttribute: (name: string) => attributes.has(name),
    matches: (selector: string) => (options.tag ?? "button") === "button" && selector === "button",
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
  };
  return Object.assign(record, { element: record as unknown as Element });
}

describe("native Goal footer control", () => {
  it.each([
    ["codex", false, false],
    ["grok", false, false],
    ["cursor-cli", false, true],
    ["claude-code", false, true],
    ["cursor-cli", true, true],
    ["grok", true, true],
    ["codex", true, true],
  ] as const)("hides Goal for %s when switching=%s", (agent, switching, hidden) => {
    expect(composerHidesNativeGoalControl(agent, switching)).toBe(hidden);
  });

  it("identifies Desktop's in-mode Goal chip by its clear label", () => {
    expect(isNativeGoalControlCandidate(goalButton({ label: "Clear goal" }).element)).toBe(true);
    expect(isNativeGoalControlCandidate(goalButton({ label: "清除目标" }).element)).toBe(true);
    expect(isNativeGoalControlCandidate(goalButton({ label: "Goal" }).element)).toBe(false);
    expect(isNativeGoalControlCandidate(goalButton({ label: "Plan" }).element)).toBe(false);
    expect(
      isNativeGoalControlCandidate(goalButton({ label: "Clear goal", owned: true }).element),
    ).toBe(false);
  });

  it("dismisses and hides Goal on unsupported Harnesses, and leaves Grok's chip visible", () => {
    const cursorGoal = goalButton({ label: "Clear goal" });
    const grokGoal = goalButton({ label: "Clear goal" });
    const noNativeRequest = {
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const controlFor = (button: ReturnType<typeof goalButton>) => {
      const composer = {
        ...noNativeRequest,
        querySelectorAll: (selector: string) => (selector === "button" ? [button.element] : []),
      } as unknown as Element;
      return {
        composer,
        nativeGoalControl: {
          element: button.element as HTMLElement,
          hidden: false,
          ariaHidden: null,
        },
        nativeModelControl: null,
        nativePermissionModeControl: null,
        nativeContextUsageControl: null,
        nativeUsageBanner: null,
        modelPicker: { trigger: { parentElement: null }, root: { parentElement: null } },
        credits: { place: vi.fn(), root: { remove: vi.fn() } },
        usage: { place: vi.fn(), root: { remove: vi.fn() } },
      } as unknown as ComposerAgentControl;
    };

    reconcileComposerNativeControls(controlFor(cursorGoal), true, true, true);
    expect(cursorGoal.click).toHaveBeenCalledOnce();
    expect(cursorGoal.hidden).toBe(true);
    expect(cursorGoal.attributes.get("aria-hidden")).toBe("true");

    reconcileComposerNativeControls(controlFor(grokGoal), true, true, false);
    expect(grokGoal.click).not.toHaveBeenCalled();
    expect(grokGoal.hidden).toBe(false);
    expect(grokGoal.attributes.get("aria-hidden")).toBeUndefined();
  });
});
