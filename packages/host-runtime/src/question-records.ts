import type {
  HostItem,
  HostQuestion,
  HostQuestionInteraction,
  HostQuestionRecordEvidence,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  threadQuestionFieldSchema,
  threadQuestionRecordSchema,
  type QuestionRecordOutcome,
  type ThreadQuestionRecord,
} from "@codexhost/shared-contracts";

const LOCKED = new Set<QuestionRecordOutcome>(["answered", "skipped", "expired"]);
const MAX_RECORDS_PER_THREAD = 100;

function publicQuestions(questions: HostQuestion[]) {
  const fields = [];
  for (const question of questions) {
    if (question.type === "text") {
      if (question.secret) continue;
      const parsed = threadQuestionFieldSchema.safeParse({
        id: question.id,
        type: "text",
        prompt: question.prompt,
        optional: question.optional,
        multiline: question.multiline,
        secret: false,
        ...(question.placeholder !== undefined ? { placeholder: question.placeholder } : {}),
        ...(question.prefill !== undefined ? { prefill: question.prefill } : {}),
      });
      if (parsed.success) fields.push(parsed.data);
      continue;
    }
    const parsed = threadQuestionFieldSchema.safeParse({
      id: question.id,
      type: "choice",
      prompt: question.prompt,
      optional: question.optional,
      multiple: question.multiple,
      allowOther: question.allowOther,
      options: question.options,
    });
    if (parsed.success) fields.push(parsed.data);
  }
  return fields.length > 0 ? fields : null;
}

function publicAnswers(
  answers: Record<string, string[]>,
  questions: NonNullable<ReturnType<typeof publicQuestions>>,
): Record<string, string[]> {
  const allowed = new Set(questions.map((question) => question.id));
  return Object.fromEntries(
    Object.entries(answers).filter(([id, values]) => allowed.has(id) && values.length > 0),
  );
}

function toRecord(input: {
  interactionId: string;
  turnId: string;
  itemId: string;
  title?: string;
  questions: HostQuestion[];
  outcome: QuestionRecordOutcome;
  answers: Record<string, string[]>;
}): ThreadQuestionRecord | null {
  const questions = publicQuestions(input.questions);
  if (!questions) return null;
  const interactionId = hostInteractionIdSchema.safeParse(input.interactionId);
  const turnId = hostTurnIdSchema.safeParse(input.turnId);
  const itemId = hostItemIdSchema.safeParse(input.itemId);
  if (!interactionId.success || !turnId.success || !itemId.success) return null;
  const parsed = threadQuestionRecordSchema.safeParse({
    interactionId: interactionId.data,
    turnId: turnId.data,
    itemId: itemId.data,
    ...(input.title !== undefined ? { title: input.title } : {}),
    questions,
    outcome: input.outcome,
    answers: publicAnswers(input.answers, questions),
  });
  return parsed.success ? parsed.data : null;
}

export class QuestionRecordStore {
  readonly #records = new WeakMap<object, Map<string, ThreadQuestionRecord>>();

  #map(thread: object): Map<string, ThreadQuestionRecord> {
    const existing = this.#records.get(thread);
    if (existing) return existing;
    const created = new Map<string, ThreadQuestionRecord>();
    this.#records.set(thread, created);
    return created;
  }

  #write(thread: object, record: ThreadQuestionRecord): void {
    const records = this.#map(thread);
    const current = records.get(record.interactionId);
    if (current && LOCKED.has(current.outcome)) return;
    if (!records.has(record.interactionId) && records.size >= MAX_RECORDS_PER_THREAD) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
    records.set(record.interactionId, record);
  }

  record(
    thread: object,
    input: {
      interaction: HostQuestionInteraction;
      itemId: string;
      outcome: QuestionRecordOutcome;
      answers: Record<string, string[]>;
    },
  ): void {
    const next = toRecord({
      interactionId: input.interaction.interactionId,
      turnId: input.interaction.turnId,
      itemId: input.itemId,
      ...(input.interaction.title !== undefined ? { title: input.interaction.title } : {}),
      questions: input.interaction.questions,
      outcome: input.outcome,
      answers: input.answers,
    });
    if (next) this.#write(thread, next);
  }

  ingest(thread: object, turnId: string, item: HostItem): void {
    if (item.type !== "toolExecution" || !item.questionRecord) return;
    const evidence: HostQuestionRecordEvidence = item.questionRecord;
    const questions: HostQuestion[] = evidence.questions;
    const next = toRecord({
      interactionId: evidence.interactionId ?? item.itemId,
      turnId,
      itemId: item.itemId,
      ...(evidence.title !== undefined ? { title: evidence.title } : {}),
      questions,
      outcome: evidence.outcome,
      answers: evidence.answers,
    });
    if (next) this.#write(thread, next);
  }

  ingestHistory(thread: object, turns: { turnId: string; items: HostItem[] }[]): void {
    for (const turn of turns) {
      for (const item of turn.items) this.ingest(thread, turn.turnId, item);
    }
  }

  list(thread: object | undefined): ThreadQuestionRecord[] {
    if (!thread) return [];
    return [...this.#map(thread).values()];
  }
}
