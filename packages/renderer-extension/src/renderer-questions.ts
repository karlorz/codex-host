import {
  THREAD_QUESTIONS_LIST_METHOD,
  THREAD_QUESTION_RESPOND_METHOD,
  THREAD_QUESTION_ACTIVITY_METHOD,
  threadQuestionActivityResultSchema,
  threadQuestionsResultSchema,
  threadQuestionRespondResultSchema,
} from "@codexhost/shared-contracts";
import { createQuestionCard } from "./renderer-question-card.js";
import { installQuestionActivity } from "./renderer-question-activity.js";
import { isUnsupportedMethod, type RendererRequestOptions } from "./renderer-request-sender.js";

export interface QuestionContext {
  hostId: string;
  threadId: string;
  composer: Element;
  route: {
    sendRequest(method: string, params: unknown, options?: RendererRequestOptions): unknown;
  };
}

function same(a: QuestionContext | null, b: QuestionContext | null): boolean {
  return (
    a?.hostId === b?.hostId &&
    a?.threadId === b?.threadId &&
    a?.composer === b?.composer &&
    a?.route === b?.route
  );
}

/** Poll only the visible external Composer. Re-querying also recovers pending cards after remount. */
export function installRendererQuestions(
  window: Window,
  readContext: () => QuestionContext | null,
) {
  let disposed = false;
  let inFlight = false;
  let context: QuestionContext | null = null;
  let card: ReturnType<typeof createQuestionCard> | null = null;
  let cardId: string | null = null;
  let stopActivity: (() => void) | undefined;
  const unsupported = new WeakSet<object>();
  const drafts = new Map<string, Record<string, string[]>>();
  const key = (id: string) => JSON.stringify([context?.hostId, context?.threadId, id]);
  const clear = (retain = true) => {
    stopActivity?.();
    stopActivity = undefined;
    if (retain && card && cardId) {
      drafts.set(key(cardId), card.readAnswers());
      const oldest = drafts.keys().next().value;
      if (drafts.size > 50 && oldest !== undefined) drafts.delete(oldest);
    }
    card?.dispose();
    card = null;
    cardId = null;
  };
  const refresh = async () => {
    if (disposed) return;
    const next = readContext();
    if (!same(context, next)) {
      clear();
      context = next;
    }
    const current = context;
    if (!current || inFlight || unsupported.has(current.route)) return;
    inFlight = true;
    try {
      const raw = await current.route.sendRequest(
        THREAD_QUESTIONS_LIST_METHOD,
        { threadId: current.threadId },
        { priority: "background", timeoutMs: 5000 },
      );
      if (disposed || !same(current, readContext())) return;
      const question = threadQuestionsResultSchema.parse(raw).questions[0];
      if (!question) {
        if (cardId) drafts.delete(key(cardId));
        clear(false);
        return;
      }
      if (cardId === question.interactionId && card?.root.isConnected) {
        card.updateAutoResolution(question.autoResolution);
        return;
      }
      clear(cardId === question.interactionId);
      cardId = question.interactionId;
      card = createQuestionCard(
        current.composer.ownerDocument,
        question,
        async (answers, cancelled) => {
          if (disposed || !same(current, readContext()) || cardId !== question.interactionId)
            throw new Error("Question owner changed");
          const result = await current.route.sendRequest(
            THREAD_QUESTION_RESPOND_METHOD,
            {
              threadId: current.threadId,
              turnId: question.turnId,
              interactionId: question.interactionId,
              answers,
              cancelled,
            },
            { priority: "interactive", timeoutMs: 10000 },
          );
          threadQuestionRespondResultSchema.parse(result);
          drafts.delete(JSON.stringify([current.hostId, current.threadId, question.interactionId]));
          if (same(current, context) && cardId === question.interactionId) clear(false);
        },
        drafts.get(key(question.interactionId)),
      );
      // Keep question textareas outside Desktop's Composer/editor discovery.
      current.composer.before(card.root);
      const mounted = card;
      stopActivity = installQuestionActivity(
        window,
        card.root,
        () =>
          same(current, readContext()) &&
          card === mounted &&
          mounted.autoResolution?.resetOnActivity === true,
        async () => {
          const raw = await current.route.sendRequest(
            THREAD_QUESTION_ACTIVITY_METHOD,
            {
              threadId: current.threadId,
              turnId: question.turnId,
              interactionId: question.interactionId,
            },
            { priority: "background", timeoutMs: 4000 },
          );
          if (disposed || card !== mounted || !same(current, readContext())) return;
          const ack = threadQuestionActivityResultSchema.parse(raw).autoResolution;
          if (ack) mounted.updateAutoResolution(ack);
        },
      );
    } catch (error) {
      if (isUnsupportedMethod(error, THREAD_QUESTIONS_LIST_METHOD)) unsupported.add(current.route);
      // A failed refresh must not leave an actionable stale card.
      if (same(current, context)) clear();
    } finally {
      inFlight = false;
    }
  };
  const timer = window.setInterval(() => {
    void refresh();
  }, 750);
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      window.clearInterval(timer);
      clear(false);
      drafts.clear();
    },
  };
}
