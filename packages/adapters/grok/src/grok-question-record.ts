import type { HostQuestion, HostQuestionRecordEvidence } from "@codexhost/harness-adapter";
import { toGrokHostQuestions, type GrokQuestionRequest } from "./grok-questions.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAskUserQuestionName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "askuserquestion" ||
    normalized === "ask_user_question" ||
    normalized === "_x.ai/ask_user_question"
  );
}

function questionsFromInput(rawInput: unknown): HostQuestion[] | null {
  const questions = isRecord(rawInput) ? rawInput.questions : undefined;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const native: GrokQuestionRequest["questions"] = [];
  for (const value of questions) {
    if (!isRecord(value) || typeof value.question !== "string" || value.question.length === 0) {
      return null;
    }
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          if (!isRecord(option) || typeof option.label !== "string" || option.label.length === 0) {
            return [];
          }
          return [
            {
              label: option.label,
              description: typeof option.description === "string" ? option.description : "",
              ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
            },
          ];
        })
      : [];
    native.push({
      question: value.question,
      options,
      multiple: value.multiSelect === true || value.multi_select === true,
    });
  }
  return toGrokHostQuestions(native);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function userAnsweredMessage(rawOutput: unknown): string | undefined {
  const parsed = asRecord(rawOutput);
  if (!parsed) return undefined;
  if (isRecord(parsed.UserAnswered) && typeof parsed.UserAnswered.message === "string") {
    return parsed.UserAnswered.message;
  }
  return typeof parsed.message === "string" ? parsed.message : undefined;
}

function answersFromUserAnsweredMessage(
  message: string,
  questions: HostQuestion[],
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const escaped = question.prompt.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = message.match(new RegExp(`"${escaped}"\\s*=\\s*"([^"]*)"`, "u"));
    if (!match?.[1]) continue;
    const labels = match[1]
      .split(/\s*,\s*/u)
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    const allowed =
      question.type === "choice" ? new Set(question.options.map((option) => option.value)) : null;
    const selected =
      allowed && question.type === "choice" && !question.allowOther
        ? labels.filter((label) => allowed.has(label))
        : labels;
    if (selected.length) answers[question.id] = selected;
  }
  return answers;
}

function answersFromOutput(
  rawOutput: unknown,
  questions: HostQuestion[],
): { outcome: HostQuestionRecordEvidence["outcome"]; answers: Record<string, string[]> } {
  const parsed = asRecord(rawOutput);
  if (parsed?.outcome === "cancelled") {
    return { outcome: "skipped", answers: {} };
  }
  const message = userAnsweredMessage(rawOutput);
  if (message && /declined to answer/iu.test(message)) {
    return { outcome: "skipped", answers: {} };
  }
  const nativeAnswers = parsed && isRecord(parsed.answers) ? parsed.answers : undefined;
  const answers: Record<string, string[]> = {};
  if (nativeAnswers) {
    for (const question of questions) {
      const values = nativeAnswers[question.prompt] ?? nativeAnswers[question.id];
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) continue;
      const selected = values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (selected.length) answers[question.id] = selected;
    }
  }
  if (Object.keys(answers).length > 0) return { outcome: "answered", answers };
  if (message) {
    const fromMessage = answersFromUserAnsweredMessage(message, questions);
    if (Object.keys(fromMessage).length > 0) return { outcome: "answered", answers: fromMessage };
    if (/answered your questions/iu.test(message)) return { outcome: "answered", answers: {} };
  }
  return { outcome: "closedByHarness", answers: {} };
}

export function grokQuestionRecordFromTool(
  toolName: string,
  rawInput: unknown,
  rawOutput: unknown,
  status: string,
): HostQuestionRecordEvidence | undefined {
  if (!isAskUserQuestionName(toolName)) return undefined;
  const questions = questionsFromInput(rawInput);
  if (!questions) return undefined;
  if (status === "failed") {
    return { title: "Grok", questions, outcome: "closedByHarness", answers: {} };
  }
  const { outcome, answers } = answersFromOutput(rawOutput, questions);
  return { title: "Grok", questions, outcome, answers };
}
