import type { HostQuestion, HostQuestionRecordEvidence } from "@codexhost/harness-adapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAskUserQuestionInput(input: unknown): HostQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) {
    return null;
  }
  const questions: HostQuestion[] = [];
  for (const [index, value] of input.questions.entries()) {
    if (!isRecord(value) || typeof value.question !== "string" || value.question.length === 0) {
      return null;
    }
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) =>
          isRecord(option) && typeof option.label === "string" && option.label.length > 0
            ? [
                {
                  value: option.label,
                  label: option.label,
                  ...(typeof option.description === "string"
                    ? { description: option.description }
                    : {}),
                },
              ]
            : [],
        )
      : [];
    if (options.length === 0) return null;
    questions.push({
      id: `question-${index + 1}`,
      type: "choice",
      prompt: value.question,
      options,
      multiple: value.multiSelect === true,
      allowOther: true,
      optional: false,
    });
  }
  return questions;
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function selectedValues(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function answersFromRecord(
  parsed: Record<string, unknown>,
  questions: HostQuestion[],
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const selected = selectedValues(parsed[question.prompt] ?? parsed[question.id]);
    if (selected.length) answers[question.id] = selected;
  }
  return answers;
}

function answersFromProse(output: string, questions: HostQuestion[]): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const escaped = question.prompt.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = output.match(new RegExp(`"${escaped}"\\s*=\\s*"([^"]*)"`, "u"));
    if (!match?.[1]) continue;
    const selected = selectedValues(match[1]);
    if (selected.length) answers[question.id] = selected;
  }
  return answers;
}

function parseAnswers(
  output: string | undefined,
  questions: HostQuestion[],
  toolUseResult: unknown,
): Record<string, string[]> {
  if (isRecord(toolUseResult) && isRecord(toolUseResult.answers)) {
    const fromStructured = answersFromRecord(toolUseResult.answers, questions);
    if (Object.keys(fromStructured).length > 0) return fromStructured;
  }
  if (!output) return {};
  const parsed = parseJsonObject(output);
  if (parsed) {
    const fromJson = answersFromRecord(parsed, questions);
    if (Object.keys(fromJson).length > 0) return fromJson;
  }
  return answersFromProse(output, questions);
}

export function claudeAskUserQuestionRecord(
  toolName: string,
  input: unknown,
  output: string | undefined,
  failed: boolean,
  toolUseResult?: unknown,
): HostQuestionRecordEvidence | undefined {
  if (toolName !== "AskUserQuestion") return undefined;
  const questions = parseAskUserQuestionInput(input);
  if (!questions) return undefined;
  const cancelled =
    /cancelled the Question/iu.test(output ?? "") ||
    (typeof toolUseResult === "string" && /cancelled the Question/iu.test(toolUseResult));
  const answers = cancelled ? {} : parseAnswers(output, questions, toolUseResult);
  const first = isRecord(input) && Array.isArray(input.questions) ? input.questions[0] : undefined;
  const header = isRecord(first) && typeof first.header === "string" ? first.header : "";
  return {
    title: questions.length === 1 && header.length > 0 ? header : "Claude Code",
    questions,
    outcome: cancelled
      ? "skipped"
      : failed
        ? "closedByHarness"
        : Object.keys(answers).length > 0
          ? "answered"
          : "skipped",
    answers,
  };
}
