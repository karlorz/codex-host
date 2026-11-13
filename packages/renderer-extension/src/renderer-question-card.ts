import type {
  QuestionAutoResolution,
  QuestionRecordOutcome,
  ThreadQuestion,
} from "@codexhost/shared-contracts";
import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Check from "lucide/dist/esm/icons/check.mjs";
import MessageCircleQuestion from "lucide/dist/esm/icons/message-circle-question-mark.mjs";
import Pencil from "lucide/dist/esm/icons/pencil.mjs";
import X from "lucide/dist/esm/icons/x.mjs";
import type { HarnessQuestionHistory } from "./renderer-question-history-preference.js";
import { QUESTION_CARD_CSS } from "./renderer-question-card-style.js";

const RECORD_OUTCOME_LABEL: Record<QuestionRecordOutcome, string> = {
  answered: "Answered",
  skipped: "Skipped (you cancelled)",
  closedByHarness: "Closed by Harness",
  expired: "Expired",
  turnEnded: "Turn ended",
};

function answerChip(document: Document, label: string, markContent: Node | string): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "answer";
  const mark = document.createElement("span");
  mark.className = "answer-mark";
  mark.setAttribute("aria-hidden", "true");
  if (typeof markContent === "string") {
    mark.dataset.optionOrder = markContent;
    mark.textContent = markContent;
  } else {
    mark.append(markContent);
  }
  const text = document.createElement("span");
  text.className = "answer-label";
  text.textContent = label;
  chip.append(mark, text);
  return chip;
}

function appendSelectedHistory(
  document: Document,
  body: HTMLElement,
  question: ThreadQuestion,
  answers: Record<string, string[]>,
  icon: (node: IconNode) => Node,
): void {
  for (const field of question.questions) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = field.prompt;
    group.append(legend);
    const saved = answers[field.id] ?? [];
    const chips = document.createElement("div");
    chips.className = "answers";
    if (field.type === "text") {
      const text = saved[0]?.trim();
      if (text) chips.append(answerChip(document, text, icon(Check)));
    } else {
      for (const value of saved) {
        const optionIndex = field.options.findIndex((item) => item.value === value);
        const option = optionIndex >= 0 ? field.options[optionIndex] : undefined;
        const mark = optionIndex >= 0 ? String(optionIndex + 1) : icon(Pencil);
        chips.append(answerChip(document, option?.label ?? value, mark));
      }
    }
    if (chips.childNodes.length > 0) group.append(chips);
    body.append(group);
  }
}

/** The card submits public Host values, never native labels or SDK objects. */
export function createQuestionCard(
  document: Document,
  question: ThreadQuestion,
  submit: (answers: Record<string, string[]>, cancelled: boolean) => Promise<void>,
  initial: Record<string, string[]> = {},
  record?: { outcome: QuestionRecordOutcome; history?: HarnessQuestionHistory },
) {
  const icon = (node: IconNode) =>
    document.adoptNode(
      createElement(node, {
        width: 16,
        height: 16,
        "aria-hidden": "true",
        focusable: "false",
      }),
    );
  const selectedIndicator = () => {
    const selected = document.createElement("span");
    selected.className = "selected-indicator";
    selected.setAttribute("aria-hidden", "true");
    selected.append(icon(Check));
    return selected;
  };
  const root = document.createElement("section");
  if (record) {
    root.dataset.codexhostQuestionRecord = question.interactionId;
    root.dataset.outcome = record.outcome;
  } else {
    root.dataset.codexhostQuestion = question.interactionId;
  }
  root.setAttribute("aria-label", question.title ?? "Question");
  root.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && event.composedPath()[0] instanceof HTMLInputElement)
      event.preventDefault();
  });
  const shadow = root.attachShadow({ mode: "open" });
  let lastFocus: HTMLElement | undefined;
  let lastScrollTop = 0;
  let suppressScroll = false;
  shadow.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement) lastFocus = event.target;
  });
  shadow.addEventListener(
    "scroll",
    (event) => {
      if (suppressScroll) return;
      if (event.target instanceof HTMLElement && event.target.classList.contains("body")) {
        lastScrollTop = event.target.scrollTop;
      }
    },
    { capture: true, passive: true },
  );
  const bodyElement = () => {
    const body = shadow.querySelector(".body");
    return body instanceof HTMLElement ? body : null;
  };
  const snapshotScroll = () => {
    const body = bodyElement();
    if (body) lastScrollTop = body.scrollTop;
  };
  const onNodeRemoved = (event: Event) => {
    if (event.target === root) snapshotScroll();
  };
  document.addEventListener("DOMNodeRemoved", onNodeRemoved, true);
  const bodyScrollTop = () => {
    if (root.isConnected) snapshotScroll();
    return lastScrollTop;
  };
  const setBodyScrollTop = (value: number) => {
    lastScrollTop = value;
    const apply = () => {
      const body = bodyElement();
      if (!body) return;
      suppressScroll = true;
      body.scrollTop = value;
      suppressScroll = false;
    };
    apply();
    document.defaultView?.requestAnimationFrame(apply);
  };
  const restoreFocus = () => {
    if (!lastFocus || !shadow.contains(lastFocus)) return;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement &&
      active !== root &&
      !root.contains(active)
    )
      return;
    if (shadow.activeElement === lastFocus) return;
    lastFocus.focus({ preventScroll: true });
  };
  const style = document.createElement("style");
  style.textContent = QUESTION_CARD_CSS;
  const surface = document.createElement("div");
  surface.className = "card";
  const historyMode = record?.history ?? (record ? "selected" : undefined);
  if (record) {
    root.dataset.history = historyMode ?? "selected";
    surface.classList.add("record");
    if (historyMode === "selected") surface.classList.add("compact");
  }
  shadow.append(style, surface);
  const title = document.createElement("div");
  title.className = "title";
  const titleIcon = document.createElement("span");
  titleIcon.className = "question-icon";
  titleIcon.append(icon(MessageCircleQuestion));
  titleIcon.setAttribute("aria-hidden", "true");
  const titleText = document.createElement("span");
  titleText.textContent = question.title?.trim() || "Question";
  const countdown = document.createElement("span");
  countdown.className = "countdown";
  countdown.setAttribute("role", "timer");
  countdown.title = "The Harness owns this timeout and its result.";
  let autoResolution = question.autoResolution;
  const updateCountdown = () => {
    const timeout = autoResolution;
    countdown.hidden = !timeout;
    if (!timeout) return;
    const remaining = Math.max(0, Math.ceil((timeout.deadlineUnixMs - Date.now()) / 1000));
    const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    const action =
      timeout.action === "recommended" ? "Auto-select recommended" : "Question timeout";
    const text = remaining ? `${action} in ${clock}` : "Waiting for Harness…";
    if (countdown.textContent !== text) countdown.textContent = text;
  };
  updateCountdown();
  let countdownTimer = autoResolution
    ? document.defaultView?.setInterval(updateCountdown, 250)
    : undefined;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "dismiss";
  dismiss.append(icon(X));
  dismiss.setAttribute("aria-label", "Dismiss question");
  const outcome = document.createElement("span");
  outcome.className = "outcome";
  if (record) {
    outcome.textContent = RECORD_OUTCOME_LABEL[record.outcome];
    title.append(titleIcon, titleText, outcome);
  } else {
    title.append(titleIcon, titleText, countdown, dismiss);
  }
  const body = document.createElement("div");
  body.className = "body";
  surface.append(title, body);
  const footer = document.createElement("div");
  footer.className = "footer";
  const readers = new Map<string, () => string[]>();
  const controls: Array<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement> = [dismiss];
  const validOther: Array<() => boolean> = [];
  const compactHistory = historyMode === "selected";
  if (compactHistory) {
    appendSelectedHistory(document, body, question, initial, icon);
    for (const field of question.questions) {
      readers.set(field.id, () => initial[field.id] ?? []);
    }
  } else {
    for (const [index, field] of question.questions.entries()) {
      const group = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = field.prompt;
      group.append(legend);
      const saved = initial[field.id] ?? [];
      if (field.type === "text") {
        const input = document.createElement(field.multiline ? "textarea" : "input");
        input.value = saved[0] ?? field.prefill ?? "";
        input.placeholder = field.placeholder ?? "Your answer";
        input.setAttribute("aria-label", field.prompt);
        controls.push(input);
        group.append(input);
        readers.set(field.id, () => (input.value.trim() ? [input.value] : []));
      } else {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "Select all that apply";
        if (field.multiple) group.append(hint);
        const inputs: HTMLInputElement[] = [];
        const name = `codexhost-${question.interactionId}-${index}`;
        for (const [optionIndex, option] of field.options.entries()) {
          const label = document.createElement("label");
          label.className = "option";
          const input = document.createElement("input");
          input.type = field.multiple ? "checkbox" : "radio";
          input.name = name;
          input.value = option.value;
          input.checked = saved.includes(option.value);
          const shortcut = document.createElement("span");
          shortcut.className = "shortcut";
          shortcut.setAttribute("aria-hidden", "true");
          shortcut.textContent = String(optionIndex + 1);
          const selected = selectedIndicator();
          const text = document.createElement("span");
          text.className = "option-copy";
          const optionName = document.createElement("span");
          optionName.className = "option-name";
          optionName.textContent = option.label;
          text.append(optionName);
          if (option.description) {
            const description = document.createElement("span");
            description.className = "description";
            description.textContent = option.description;
            text.append(description);
          }
          label.append(input, shortcut, text, selected);
          group.append(label);
          inputs.push(input);
          controls.push(input);
        }
        let other: HTMLInputElement | undefined;
        let notes: HTMLInputElement | undefined;
        if (field.allowOther) {
          const label = document.createElement("label");
          label.className = "option other";
          other = document.createElement("input");
          other.type = field.multiple ? "checkbox" : "radio";
          other.name = name;
          other.setAttribute("aria-label", `Other: ${field.prompt}`);
          const unknown = saved.find(
            (value) => !field.options.some((option) => option.value === value),
          );
          other.checked = unknown !== undefined;
          notes = document.createElement("input");
          notes.value = unknown ?? "";
          notes.placeholder = "Or write your own response";
          notes.setAttribute("aria-label", `${field.prompt}: Other`);
          const checkbox = other;
          const otherText = notes;
          validOther.push(() => !checkbox.checked || otherText.value.trim().length > 0);
          notes.addEventListener("input", () => {
            checkbox.checked = true;
          });
          const copy = document.createElement("span");
          copy.className = "other-copy";
          copy.append(notes);
          const pencil = document.createElement("span");
          pencil.className = "shortcut pencil";
          pencil.append(icon(Pencil));
          pencil.setAttribute("aria-hidden", "true");
          const selected = selectedIndicator();
          label.append(other, pencil, copy, selected);
          if (question.questions.length === 1) footer.append(label);
          else group.append(label);
          controls.push(other, notes);
        }
        readers.set(field.id, () => [
          ...inputs.filter((input) => input.checked).map((input) => input.value),
          ...(other?.checked && notes?.value.trim() ? [notes.value] : []),
        ]);
      }
      body.append(group);
    }
  }
  const error = document.createElement("div");
  error.setAttribute("role", "alert");
  error.className = "error";
  const actions = document.createElement("div");
  actions.className = "actions";
  const readAnswers = () => Object.fromEntries([...readers].map(([id, read]) => [id, read()]));
  const interaction = { restoreFocus, bodyScrollTop, setBodyScrollTop };
  if (record) {
    for (const control of controls) control.disabled = true;
    if (footer.childNodes.length > 0) surface.append(footer);
    return {
      root,
      readAnswers,
      historyMode,
      ...interaction,
      get autoResolution() {
        return autoResolution;
      },
      updateAutoResolution() {},
      dispose() {
        document.removeEventListener("DOMNodeRemoved", onNodeRemoved, true);
        if (countdownTimer !== undefined) document.defaultView?.clearInterval(countdownTimer);
        root.remove();
      },
    };
  }
  let busy = false;
  const send = async (cancelled: boolean) => {
    if (busy) return;
    const answers = cancelled ? {} : readAnswers();
    if (!cancelled && validOther.some((valid) => !valid())) {
      error.textContent = "Type an answer for each selected Other option.";
      return;
    }
    if (
      !cancelled &&
      question.questions.some((field) => !field.optional && !answers[field.id]?.length)
    ) {
      error.textContent = "Answer each required question before submitting.";
      return;
    }
    busy = true;
    error.textContent = "";
    for (const control of controls) control.disabled = true;
    try {
      await submit(answers, cancelled);
    } catch {
      error.textContent =
        "Could not submit. The question may have closed. Try again if it is still available.";
    } finally {
      busy = false;
      for (const control of controls) control.disabled = false;
    }
  };
  for (const [label, cancelled] of [
    ["Skip", true],
    ["Send", false],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (!cancelled) button.className = "primary";
    button.addEventListener("click", () => {
      void send(cancelled);
    });
    controls.push(button);
    actions.append(button);
  }
  dismiss.addEventListener("click", () => {
    void send(true);
  });
  footer.append(actions);
  surface.append(error, footer);
  return {
    root,
    readAnswers,
    historyMode,
    ...interaction,
    get autoResolution() {
      return autoResolution;
    },
    updateAutoResolution(next: QuestionAutoResolution | undefined) {
      if (autoResolution && (!next || next.deadlineUnixMs < autoResolution.deadlineUnixMs)) return;
      autoResolution = next;
      if (next && countdownTimer === undefined)
        countdownTimer = document.defaultView?.setInterval(updateCountdown, 250);
      updateCountdown();
    },
    dispose() {
      document.removeEventListener("DOMNodeRemoved", onNodeRemoved, true);
      if (countdownTimer !== undefined) document.defaultView?.clearInterval(countdownTimer);
      root.remove();
    },
  };
}
