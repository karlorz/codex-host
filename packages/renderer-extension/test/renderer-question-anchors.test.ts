import { describe, expect, it } from "vitest";

import {
  elementIsDisplayed,
  elementIsShown,
  findDisplayedTranscriptItem,
  findTranscriptItem,
  findTranscriptTurn,
  findLiveQuestionMount,
  findVisibleHistoryMount,
  findVisibleReplyColumn,
  findWorkingColumn,
  questionHistorySlotCeiling,
} from "../src/renderer-question-anchors.js";
import {
  TRANSCRIPT_ITEM_IDS_ATTRIBUTE,
  TRANSCRIPT_ITEM_SELECTOR,
  TRANSCRIPT_TURN_KEY_ATTRIBUTE,
} from "../src/renderer-transcript-dom.js";

function list(values: unknown[]): NodeListOf<Element> {
  return values as unknown as NodeListOf<Element>;
}

function rect(height: number) {
  return {
    width: height > 0 ? 100 : 0,
    height,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: height,
  };
}

interface FakeNode {
  parentElement: FakeNode | null;
  children: FakeNode[];
  textContent: string;
  ariaExpanded: string | undefined;
  ids: string | undefined;
  turnKey: string | undefined;
  getBoundingClientRect(): { width: number; height: number };
  getAttribute(name: string): string | null;
  contains(node: FakeNode): boolean;
  querySelectorAll(selector: string): NodeListOf<Element>;
  querySelector(selector: string): Element | null;
  closest(selector: string): Element | null;
}

function node(init: {
  height: number;
  text?: string;
  ids?: string;
  turnKey?: string;
  ariaExpanded?: string;
  children?: FakeNode[];
}): FakeNode {
  const created: FakeNode = {
    parentElement: null,
    children: init.children ?? [],
    textContent: init.text ?? "",
    ariaExpanded: init.ariaExpanded,
    ids: init.ids,
    turnKey: init.turnKey,
    getBoundingClientRect: () => rect(init.height),
    getAttribute(name) {
      if (name === TRANSCRIPT_ITEM_IDS_ATTRIBUTE) return created.ids ?? null;
      if (name === TRANSCRIPT_TURN_KEY_ATTRIBUTE) return created.turnKey ?? null;
      if (name === "aria-expanded") return created.ariaExpanded ?? null;
      return null;
    },
    contains(other) {
      return created === other || created.children.some((child) => child.contains(other));
    },
    querySelectorAll(selector) {
      const matches: FakeNode[] = [];
      const walk = (current: FakeNode) => {
        if (selector === TRANSCRIPT_ITEM_SELECTOR && current.ids) matches.push(current);
        if (selector === "button" && current.ariaExpanded !== undefined) matches.push(current);
        if (selector === "button[aria-expanded]" && current.ariaExpanded !== undefined)
          matches.push(current);
        if (selector === `[${TRANSCRIPT_TURN_KEY_ATTRIBUTE}]` && current.turnKey !== undefined)
          matches.push(current);
        for (const child of current.children) walk(child);
      };
      walk(created);
      return list(matches);
    },
    querySelector(selector) {
      return created.querySelectorAll(selector)[0] ?? null;
    },
    closest(selector) {
      let current: FakeNode | null = created;
      while (current) {
        if (selector === `[${TRANSCRIPT_TURN_KEY_ATTRIBUTE}]` && current.turnKey) {
          return current as unknown as Element;
        }
        if (selector === TRANSCRIPT_ITEM_SELECTOR && current.ids) {
          return current as unknown as Element;
        }
        current = current.parentElement;
      }
      return null;
    },
  };
  for (const child of created.children) child.parentElement = created;
  return created;
}

describe("Renderer question transcript anchors", () => {
  it("matches a Host item id published on a transcript row", () => {
    const row = {
      getAttribute: (name: string) =>
        name === TRANSCRIPT_ITEM_IDS_ATTRIBUTE ? "other item-live extra" : null,
    } as unknown as Element;
    const missing = {
      getAttribute: () => "unrelated",
    } as unknown as Element;
    const root = {
      querySelector: (selector: string) => (selector === TRANSCRIPT_ITEM_SELECTOR ? row : null),
      querySelectorAll: (selector: string) =>
        selector === TRANSCRIPT_ITEM_SELECTOR ? list([missing, row]) : list([]),
    } as unknown as ParentNode;

    expect(findTranscriptItem(root, "item-live")).toBe(row);
    expect(findTranscriptItem(root, "missing")).toBeNull();
  });

  it("treats a zero-size folded row as not displayed", () => {
    const hidden = node({ height: 0, ids: "item-live", text: "ask user question" });
    const card = node({ height: 80, text: "picker" });
    hidden.children.push(card);
    card.parentElement = hidden;
    expect(elementIsDisplayed(hidden as unknown as Element)).toBe(false);
    expect(elementIsDisplayed(card as unknown as Element)).toBe(true);
    expect(elementIsShown(card as unknown as Element)).toBe(false);
    const root = {
      querySelectorAll: (selector: string) =>
        selector === TRANSCRIPT_ITEM_SELECTOR ? list([hidden]) : list([]),
    } as unknown as ParentNode;
    expect(findDisplayedTranscriptItem(root, "item-live")).toBeNull();
    expect(findTranscriptItem(root, "item-live")).toBe(hidden as unknown as Element);
  });

  it("parks a folded record on the turn's remaining visible reply", () => {
    const fold = node({
      height: 20,
      text: "fold",
      ariaExpanded: "false",
    });
    const hiddenRow = node({ height: 0, ids: "item-folded", text: "ask user question" });
    const foldCol = node({ height: 20, text: "fold", children: [fold, hiddenRow] });
    const spacer = node({ height: 19, text: "   " });
    const reply = node({ height: 40, text: "You picked Alpha" });
    const turn = node({
      height: 80,
      turnKey: "turn-1",
      children: [foldCol, spacer, reply],
    });

    expect(findTranscriptTurn(turn as unknown as ParentNode, "turn-1")).toBe(
      turn as unknown as Element,
    );
    expect(
      findVisibleReplyColumn(turn as unknown as Element, hiddenRow as unknown as Element),
    ).toBe(reply as unknown as Element);
    expect(findVisibleHistoryMount(turn as unknown as ParentNode, "item-folded", "turn-1")).toBe(
      reply as unknown as Element,
    );
  });

  it("prefers the visible reply over a still-displayed tool row", () => {
    const fold = node({ height: 20, text: "fold", ariaExpanded: "true" });
    const toolRow = node({ height: 80, ids: "item-live", text: "ask user question" });
    const foldCol = node({ height: 100, text: "fold", children: [fold, toolRow] });
    const reply = node({ height: 40, text: "You picked Alpha" });
    const turn = node({
      height: 160,
      turnKey: "turn-1",
      children: [foldCol, reply],
    });
    expect(findVisibleHistoryMount(turn as unknown as ParentNode, "item-live", "turn-1")).toBe(
      reply as unknown as Element,
    );
  });

  it("parks on the sibling reply while the tool row is still open beside it", () => {
    const fold = node({ height: 20, text: "Working for 25s", ariaExpanded: "false" });
    const toolRow = node({ height: 80, ids: "item-live", text: "ask user question" });
    const reply = node({ height: 80, text: "The tool result says the user declined" });
    const row = node({ height: 80, text: "row", children: [toolRow, reply] });
    const turn = node({
      height: 120,
      turnKey: "turn-1",
      children: [fold, row],
    });
    expect(findVisibleReplyColumn(turn as unknown as Element, toolRow as unknown as Element)).toBe(
      reply as unknown as Element,
    );
    expect(findVisibleHistoryMount(turn as unknown as ParentNode, "item-live", "turn-1")).toBe(
      reply as unknown as Element,
    );
  });

  it("keeps a record on the working column before any reply exists", () => {
    const fold = node({ height: 20, text: "Working for 4s", ariaExpanded: "false" });
    const hiddenRow = node({ height: 0, ids: "item-pending", text: "ask user question" });
    const workingCol = node({ height: 20, text: "working", children: [fold, hiddenRow] });
    const user = node({ height: 40, text: "You said" });
    const turn = node({
      height: 80,
      turnKey: "turn-pending",
      children: [user, workingCol],
    });
    expect(
      findVisibleReplyColumn(turn as unknown as Element, hiddenRow as unknown as Element),
    ).toBeNull();
    expect(findWorkingColumn(turn as unknown as Element)).toBe(workingCol as unknown as Element);
    expect(
      findVisibleHistoryMount(turn as unknown as ParentNode, "item-pending", "turn-pending"),
    ).toBe(workingCol as unknown as Element);
  });

  it("caps a history slot at the turn instead of the surrounding transcript", () => {
    const reply = node({ height: 80, text: "You picked Alpha" });
    const tool = node({ height: 80, ids: "item-rowish", text: "tool" });
    const turn = node({
      height: 80,
      turnKey: "turn-rowish",
      children: [tool, reply],
    });
    const transcript = node({ height: 400, text: "transcript", children: [turn] });
    expect(questionHistorySlotCeiling(reply as unknown as Element)).toBe(
      turn as unknown as Element,
    );
    expect(questionHistorySlotCeiling(reply as unknown as Element)).not.toBe(
      transcript as unknown as Element,
    );
  });

  it("keeps a live picker on the displayed item row instead of the reply", () => {
    const fold = node({ height: 20, text: "fold", ariaExpanded: "true" });
    const toolRow = node({ height: 80, ids: "item-live", text: "ask user question" });
    const foldCol = node({ height: 100, text: "fold", children: [fold, toolRow] });
    const reply = node({ height: 40, text: "You picked Alpha" });
    const turn = node({
      height: 160,
      turnKey: "turn-1",
      children: [foldCol, reply],
    });
    expect(findLiveQuestionMount(turn as unknown as ParentNode, "item-live", "turn-1")).toBe(
      toolRow as unknown as Element,
    );
    expect(findVisibleHistoryMount(turn as unknown as ParentNode, "item-live", "turn-1")).toBe(
      reply as unknown as Element,
    );
  });

  it("parks a folded live picker on the working column", () => {
    const fold = node({ height: 20, text: "Working for 4s", ariaExpanded: "false" });
    const hiddenRow = node({ height: 0, ids: "item-live", text: "Waiting for your answer" });
    const workingCol = node({ height: 20, text: "working", children: [fold, hiddenRow] });
    const user = node({ height: 40, text: "You said" });
    const turn = node({
      height: 80,
      turnKey: "turn-pending",
      children: [user, workingCol],
    });
    expect(findLiveQuestionMount(turn as unknown as ParentNode, "item-live", "turn-pending")).toBe(
      workingCol as unknown as Element,
    );
  });

  it("does not park a live picker when the item row is missing or has no turn", () => {
    const orphan = node({ height: 0, ids: "item-live", text: "Waiting for your answer" });
    const root = {
      querySelectorAll: (selector: string) =>
        selector === TRANSCRIPT_ITEM_SELECTOR ? list([orphan]) : list([]),
    } as unknown as ParentNode;
    expect(findLiveQuestionMount(root, "item-live", "turn-1")).toBeNull();
    expect(findLiveQuestionMount(root, "item-missing", "turn-1")).toBeNull();
  });

  it("caps a history slot at the item row when the turn node is absent", () => {
    const row = node({ height: 40, ids: "item-record", text: "record row" });
    const transcript = node({ height: 400, text: "transcript", children: [row] });
    expect(questionHistorySlotCeiling(row as unknown as Element)).toBe(row as unknown as Element);
    expect(questionHistorySlotCeiling(row as unknown as Element)).not.toBe(
      transcript as unknown as Element,
    );
  });
});
