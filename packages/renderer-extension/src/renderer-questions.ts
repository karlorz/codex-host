import {
  THREAD_QUESTIONS_LIST_METHOD,
  THREAD_QUESTION_RESPOND_METHOD,
  THREAD_QUESTION_ACTIVITY_METHOD,
  THREAD_QUESTION_RECORDS_LIST_METHOD,
  threadQuestionActivityResultSchema,
  threadQuestionRecordsResultSchema,
  threadQuestionsResultSchema,
  threadQuestionRespondResultSchema,
  type ThreadQuestion,
  type ThreadQuestionPendingAnchor,
  type ThreadQuestionRecord,
} from "@codexhost/shared-contracts";
import { createQuestionCard } from "./renderer-question-card.js";
import { installQuestionActivity } from "./renderer-question-activity.js";
import {
  elementIsShown,
  ensureQuestionHistorySlot,
  findLiveQuestionMount,
  findVisibleHistoryMount,
} from "./renderer-question-anchors.js";
import { jumpRevealsQuestionRow } from "./renderer-question-jump.js";
import {
  HARNESS_QUESTION_HISTORY_CHANGE_EVENT,
  readHarnessQuestionHistory,
} from "./renderer-question-history-preference.js";
import {
  HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT,
  readHarnessQuestionPlacement,
} from "./renderer-question-placement-preference.js";
import {
  coverNativeComposerRequest,
  uncoverNativeComposerRequest,
} from "./renderer-composer-request.js";
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

function sharedCard(question: ThreadQuestion | undefined): question is ThreadQuestion {
  return Boolean(
    question?.questions.some(
      (field) => field.type === "choice" && (field.multiple || field.allowOther),
    ),
  );
}

function createJumpPill(document: Document, onJump: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.codexhostQuestionJump = "";
  button.textContent = "Question waiting — Jump";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onJump();
  });
  Object.assign(button.style, {
    display: "block",
    position: "relative",
    zIndex: "4",
    pointerEvents: "auto",
    width: "100%",
    margin: "0 0 8px",
    minHeight: "28px",
    border: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
    borderRadius: "999px",
    background: "transparent",
    color: "inherit",
    font: "13px/1.4 system-ui, sans-serif",
    cursor: "pointer",
  });
  return button;
}

/** Only the unambiguous visible external Composer can own a card. */
export function installRendererQuestions(
  window: Window,
  readContext: () => QuestionContext | null,
) {
  let disposed = false;
  let inFlight = false;
  let revision = 0;
  let placement = readHarnessQuestionPlacement(window);
  let historyMode = readHarnessQuestionHistory(window);
  let context: QuestionContext | null = null;
  let card: ReturnType<typeof createQuestionCard> | null = null;
  let cardKey: string | null = null;
  let mountedPlacement: "in-chat" | "overlay" | "jump" | null = null;
  let jump: HTMLButtonElement | null = null;
  let stopActivity: (() => void) | undefined;
  const unsupported = new WeakSet<object>();
  const unsupportedRecords = new WeakSet<object>();
  const listUnobserved = (current: QuestionContext) => {
    if (unsupported.has(current.route)) return;
    void Promise.resolve(
      current.route.sendRequest(
        THREAD_QUESTIONS_LIST_METHOD,
        { threadId: current.threadId, unobserved: true },
        { priority: "background", timeoutMs: 4000 },
      ),
    ).catch((error: unknown) => {
      if (isUnsupportedMethod(error, THREAD_QUESTIONS_LIST_METHOD)) unsupported.add(current.route);
    });
  };
  const drafts = new Map<string, Record<string, string[]>>();
  const records = new Map<string, ReturnType<typeof createQuestionCard>>();
  const clearJump = () => {
    jump?.remove();
    jump = null;
  };
  const clear = (retain = true) => {
    stopActivity?.();
    stopActivity = undefined;
    if (retain && card && cardKey) {
      drafts.set(cardKey, card.readAnswers());
      const oldest = drafts.keys().next().value;
      if (drafts.size > 50 && oldest !== undefined) drafts.delete(oldest);
    }
    card?.dispose();
    card = null;
    cardKey = null;
    mountedPlacement = null;
    clearJump();
  };
  const clearRecords = () => {
    for (const view of records.values()) view.dispose();
    records.clear();
  };
  const syncNativeCover = (current: QuestionContext, live: boolean) => {
    if (live) coverNativeComposerRequest(current.composer);
    else uncoverNativeComposerRequest(current.composer.ownerDocument);
  };
  const liveMount = (
    document: Document,
    anchor: ThreadQuestionPendingAnchor | undefined,
  ): Element | null => {
    if (!anchor?.itemId) return null;
    return findLiveQuestionMount(document, anchor.itemId, anchor.turnId);
  };
  const resolveLivePlacement = (
    document: Document,
    anchor: ThreadQuestionPendingAnchor | undefined,
  ): "in-chat" | "overlay" | "jump" => {
    if (placement !== "in-chat") return "overlay";
    if (liveMount(document, anchor)) return "in-chat";
    if (anchor?.itemId) return "jump";
    return "overlay";
  };
  const placeLive = (
    current: QuestionContext,
    anchor: ThreadQuestionPendingAnchor | undefined,
  ): "in-chat" | "overlay" | "jump" => {
    const document = current.composer.ownerDocument;
    const placement = resolveLivePlacement(document, anchor);
    if (!card) return placement;
    if (placement === "in-chat") {
      const mount = liveMount(document, anchor);
      if (mount) {
        ensureQuestionHistorySlot(document, mount).append(card.root);
        return "in-chat";
      }
    }
    if (placement === "jump") {
      jump = createJumpPill(document, () => {
        void jumpRevealsQuestionRow(
          document,
          current.hostId,
          current.threadId,
          anchor?.itemId,
        ).then(() => {
          if (!disposed) void refresh();
        });
      });
      current.composer.before(jump);
      return "jump";
    }
    current.composer.before(card.root);
    return "overlay";
  };
  const syncRecords = (
    current: QuestionContext,
    closed: ThreadQuestionRecord[],
    liveId: string | undefined,
  ) => {
    const document = current.composer.ownerDocument;
    const visible = new Set<string>();
    for (const record of closed) {
      if (record.interactionId === liveId) continue;
      const mount = findVisibleHistoryMount(document, record.itemId, record.turnId);
      if (!mount) continue;
      const host = ensureQuestionHistorySlot(document, mount);
      visible.add(record.interactionId);
      const existing = records.get(record.interactionId);
      if (
        existing?.root.isConnected &&
        existing.root.parentElement === host &&
        existing.historyMode === historyMode
      )
        continue;
      existing?.dispose();
      const view = createQuestionCard(
        document,
        {
          interactionId: record.interactionId,
          turnId: record.turnId,
          ...(record.title !== undefined ? { title: record.title } : {}),
          questions: record.questions,
        },
        async () => undefined,
        record.answers,
        { outcome: record.outcome, history: historyMode },
      );
      host.append(view.root);
      records.set(record.interactionId, view);
    }
    for (const [id, view] of records) {
      if (visible.has(id) && view.root.isConnected) continue;
      view.dispose();
      records.delete(id);
    }
    while (records.size > 50) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.get(oldest)?.dispose();
      records.delete(oldest);
    }
  };
  const syncRecordsSafe = (
    current: QuestionContext,
    closed: ThreadQuestionRecord[],
    liveId: string | undefined,
  ) => {
    try {
      syncRecords(current, closed, liveId);
    } catch {
      return;
    }
  };
  const refresh = async () => {
    if (disposed) return;
    const next = readContext();
    if (!same(context, next)) {
      if (context && context.threadId !== next?.threadId) listUnobserved(context);
      if (context) syncNativeCover(context, false);
      clear();
      clearRecords();
      context = next;
      revision++;
    }
    const current = context;
    if (!current || inFlight || unsupported.has(current.route)) return;
    const startedRevision = revision;
    inFlight = true;
    try {
      const listParams = { threadId: current.threadId };
      const listOptions = { priority: "background" as const, timeoutMs: 5000 };
      const recordsPromise = unsupportedRecords.has(current.route)
        ? Promise.resolve(undefined)
        : Promise.resolve(
            current.route.sendRequest(THREAD_QUESTION_RECORDS_LIST_METHOD, listParams, listOptions),
          ).catch((error: unknown) => {
            if (isUnsupportedMethod(error, THREAD_QUESTION_RECORDS_LIST_METHOD)) {
              unsupportedRecords.add(current.route);
            }
            return undefined;
          });
      const [raw, recordRaw] = await Promise.all([
        current.route.sendRequest(THREAD_QUESTIONS_LIST_METHOD, listParams, listOptions),
        recordsPromise,
      ]);
      if (disposed || revision !== startedRevision || !same(current, readContext())) return;
      const question = threadQuestionsResultSchema.parse(raw).questions[0];
      const live = sharedCard(question) ? question : undefined;
      let closed: ThreadQuestionRecord[] = [];
      let pendingAnchors: ThreadQuestionPendingAnchor[] = [];
      if (recordRaw !== undefined) {
        const parsed = threadQuestionRecordsResultSchema.safeParse(recordRaw);
        if (parsed.success) {
          closed = parsed.data.records;
          pendingAnchors = parsed.data.pendingAnchors;
        }
      }
      if (!live) {
        if (cardKey) drafts.delete(cardKey);
        clear(false);
        syncNativeCover(current, false);
        syncRecordsSafe(current, closed, undefined);
        return;
      }
      const key = JSON.stringify([
        current.hostId,
        current.threadId,
        live.turnId,
        live.interactionId,
      ]);
      const anchor = pendingAnchors.find(
        (candidate) => candidate.interactionId === live.interactionId,
      );
      if (cardKey === key && mountedPlacement) {
        const expected = resolveLivePlacement(current.composer.ownerDocument, anchor);
        const stable =
          mountedPlacement === expected &&
          (expected === "jump"
            ? jump?.isConnected === true
            : card?.root.isConnected === true &&
              (expected !== "in-chat" || elementIsShown(card.root)));
        if (stable) {
          card?.updateAutoResolution(live.autoResolution);
          syncNativeCover(current, true);
          syncRecordsSafe(current, closed, live.interactionId);
          return;
        }
      }
      clear(cardKey === key);
      cardKey = key;
      card = createQuestionCard(
        current.composer.ownerDocument,
        live,
        async (answers, cancelled) => {
          if (disposed || !same(current, readContext()) || cardKey !== key)
            throw new Error("Question owner changed");
          const raw = await current.route.sendRequest(
            THREAD_QUESTION_RESPOND_METHOD,
            {
              threadId: current.threadId,
              turnId: live.turnId,
              interactionId: live.interactionId,
              answers,
              cancelled,
            },
            { priority: "interactive", timeoutMs: 10000 },
          );
          threadQuestionRespondResultSchema.parse(raw);
          drafts.delete(key);
          if (same(current, context)) {
            // An older in-flight list must not resurrect an already answered card.
            revision++;
            if (cardKey === key) clear(false);
            void refresh();
          }
        },
        drafts.get(key),
      );
      mountedPlacement = placeLive(current, anchor);
      syncNativeCover(current, true);
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
              turnId: live.turnId,
              interactionId: live.interactionId,
            },
            { priority: "background", timeoutMs: 4000 },
          );
          if (disposed || card !== mounted || !same(current, readContext())) return;
          const ack = threadQuestionActivityResultSchema.parse(raw).autoResolution;
          if (ack) mounted.updateAutoResolution(ack);
        },
      );
      syncRecordsSafe(current, closed, live.interactionId);
    } catch (error) {
      if (isUnsupportedMethod(error, THREAD_QUESTIONS_LIST_METHOD)) unsupported.add(current.route);
      if (revision === startedRevision && same(current, context)) {
        clear();
        syncNativeCover(current, false);
      }
    } finally {
      inFlight = false;
    }
  };
  const timer = window.setInterval(() => {
    void refresh();
  }, 750);
  const onPlacement = () => {
    placement = readHarnessQuestionPlacement(window);
    void refresh();
  };
  const onHistory = () => {
    historyMode = readHarnessQuestionHistory(window);
    clearRecords();
    void refresh();
  };
  const onVisibility = () => {
    if (disposed || window.document.visibilityState !== "hidden") return;
    const current = context ?? readContext();
    if (current) listUnobserved(current);
  };
  window.addEventListener(HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT, onPlacement);
  window.addEventListener(HARNESS_QUESTION_HISTORY_CHANGE_EVENT, onHistory);
  window.document.addEventListener("visibilitychange", onVisibility);
  void refresh();
  return {
    refresh,
    refreshContext() {
      if (context && (card || jump)) coverNativeComposerRequest(context.composer);
      else if (context) uncoverNativeComposerRequest(context.composer.ownerDocument);
      // Streaming DOM mutations must not turn the background poll into a request per token.
      if (
        !same(context, readContext()) ||
        (card && !card.root.isConnected) ||
        jump?.isConnected === false
      )
        void refresh();
    },
    dispose() {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener(HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT, onPlacement);
      window.removeEventListener(HARNESS_QUESTION_HISTORY_CHANGE_EVENT, onHistory);
      window.document.removeEventListener("visibilitychange", onVisibility);
      if (context) syncNativeCover(context, false);
      clear(false);
      clearRecords();
      drafts.clear();
    },
  };
}
