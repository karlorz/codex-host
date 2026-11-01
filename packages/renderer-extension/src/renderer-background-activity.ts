import {
  THREAD_ACTIVITY_LIST_METHOD,
  THREAD_ACTIVITY_READ_METHOD,
  THREAD_ACTIVITY_STOP_METHOD,
  backgroundActivityDetailSchema,
  threadActivityListResultSchema,
  threadActivityStopResultSchema,
  type BackgroundActivity,
  type BackgroundActivityDetail,
} from "@codexhost/shared-contracts";
import type { QuestionContext } from "./renderer-questions.js";
import { isUnsupportedMethod } from "./renderer-request-sender.js";
import { openRendererActivityChild } from "./renderer-activity-navigation.js";
import { appendActivityOutput } from "./renderer-activity-detail.js";
import {
  activitySectionTarget,
  ACTIVITY_SECTION_CLASS,
  ACTIVITY_SECTION_CONTENT_CLASS,
  ACTIVITY_SECTION_HEADING_CLASS,
  ACTIVITY_SECTION_TOGGLE_CLASS,
  ACTIVITY_SECTION_LABEL_CLASS,
} from "./renderer-activity-section.js";

export function activityCountdown(nextRunAt: string | undefined, now = Date.now()): string {
  if (!nextRunAt) return "";
  const seconds = Math.ceil((Date.parse(nextRunAt) - now) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds <= 0) return "Waiting for Harness";
  return "Next in " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

export function activitySummaryLabel(activity: Pick<BackgroundActivity, "kind" | "label">): string {
  const firstLine =
    activity.label
      .trim()
      .split(/[\r\n]/, 1)[0]
      ?.replace(/\s+/g, " ") ?? "";
  if (!firstLine) return activity.kind === "loop" ? "Loop schedule" : "Background process";
  const characters = Array.from(firstLine);
  return characters.length > 72 ? characters.slice(0, 71).join("") + "…" : firstLine;
}

/** Presentation only: child descriptors still reach Host materialization through list/read. */
export function supplementalBackgroundActivities(activities: readonly BackgroundActivity[]) {
  const rows = activities.filter(
    (item) => item.kind === "loop" || (item.kind !== "subagent" && !item.commandItemId),
  );
  return rows.some((item) => !["completed", "failed", "cancelled"].includes(item.status))
    ? rows
    : [];
}
function same(a: QuestionContext | null, b: QuestionContext | null): boolean {
  return (
    a?.hostId === b?.hostId &&
    a?.threadId === b?.threadId &&
    a?.composer === b?.composer &&
    a?.route === b?.route
  );
}
const CSS = [
  "[data-codexhost-background-activity]{font:inherit;color:var(--color-text-primary,inherit);min-width:0}",
  "[data-codexhost-background-activity] button{font:inherit;color:inherit;cursor:pointer;background:transparent;border:0;text-align:left}",
  "[data-codexhost-background-activity] button:disabled{opacity:.6;cursor:wait}",
  "[data-codexhost-background-activity] button:focus-visible{outline:2px solid var(--color-ring,#779cff);outline-offset:2px}",
  "[data-codexhost-background-activity] [hidden]{display:none}",
  "[data-codexhost-background-activity] .activity-heading{margin:0}",
  "[data-codexhost-background-activity] .activity-disclosure{flex-shrink:0;transition:transform .15s}",
  "[data-codexhost-background-activity] button[aria-expanded=true]>.activity-disclosure{opacity:0}",
  "[data-codexhost-background-activity] button:hover>.activity-disclosure,[data-codexhost-background-activity] button:focus-visible>.activity-disclosure{opacity:1}",
  "[data-codexhost-background-activity] .activity-row{display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0;padding:7px 0}",
  "[data-codexhost-background-activity] .activity-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  "[data-codexhost-background-activity] .activity-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  "[data-codexhost-background-activity] .activity-detail{padding:4px 0 10px;min-width:0}",
  "[data-codexhost-background-activity] .activity-prompt-title{margin:0 0 6px;overflow-wrap:anywhere}",
  "[data-codexhost-background-activity] summary{cursor:pointer;padding:4px 0}",
  "[data-codexhost-background-activity] .activity-prompt-instructions{white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;padding:6px 0}",
  "[data-codexhost-background-activity] pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:40vh;overflow:auto}",
  "[data-codexhost-background-activity] pre.activity-process-output{font:12px/1.5 ui-monospace,monospace}",
  "[data-codexhost-background-activity] .activity-action{padding:5px 0;text-decoration:underline;margin-right:12px}",
  "[data-codexhost-background-activity] .activity-error{font-size:12px;padding:0 20px;color:var(--color-text-danger,light-dark(#a32020,#ffaaa0))}",
].join("\n");

/** Adds typed supplemental rows to the native summary; never owns composer layout. */
export function installRendererBackgroundActivity(
  window: Window,
  readContext: () => QuestionContext | null,
) {
  let context: QuestionContext | null = null;
  let revision = 0;
  let disposed = false;
  let inFlight: object | null = null;
  let root: HTMLElement | null = null;
  let container: HTMLElement | null = null;
  let body: HTMLElement | null = null;
  let errorNode: HTMLElement | null = null;
  let activities: BackgroundActivity[] = [];
  let allActivities: BackgroundActivity[] = [];
  let selected: string | null = null;
  let expanded = true;
  let instructionsExpanded = false;
  let detail: BackgroundActivityDetail | null = null;
  let renderKey = "";
  let renderedOutput: string | undefined;
  let navigation: AbortController | null = null;
  const unsupported = new WeakSet<object>();
  const valid = (owner: QuestionContext, token: number) =>
    !disposed && token === revision && same(owner, context) && same(owner, readContext());
  const message = (error: unknown) =>
    error instanceof Error ? error.message : "Native activity is unavailable";
  const setError = (text: string) => {
    if (errorNode && errorNode.textContent !== text) errorNode.textContent = text;
  };
  const unmount = () => {
    root?.remove();
    root = null;
    body = null;
    errorNode = null;
    renderKey = "";
    renderedOutput = undefined;
  };
  const clear = () => {
    navigation?.abort();
    navigation = null;
    unmount();
    container = null;
    selected = null;
    expanded = true;
    instructionsExpanded = false;
    detail = null;
    activities = [];
    allActivities = [];
  };
  const button = (text: string, action: () => void, className: string) => {
    const node = window.document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = text;
    node.addEventListener("click", action);
    return node;
  };
  const clocks = () => {
    for (const clock of root?.querySelectorAll<HTMLElement>("[data-next-run]") ?? []) {
      const text = activityCountdown(clock.dataset.nextRun);
      if (clock.textContent !== text) clock.textContent = text;
    }
  };
  const metadata = (parent: HTMLElement, activity: BackgroundActivity) => {
    const meta = window.document.createElement("span");
    meta.className = "activity-meta text-xs text-secondary";
    meta.textContent = [
      activity.kind === "loop" ? "Schedule" : "Process",
      activity.status,
      activity.schedule,
    ]
      .filter(Boolean)
      .join(" · ");
    parent.append(meta);
    if (activity.nextRunAt) {
      const clock = window.document.createElement("span");
      clock.className = "activity-meta text-xs text-secondary";
      clock.dataset.nextRun = activity.nextRunAt;
      parent.append(clock);
    }
  };
  const openChild = async (owner: QuestionContext, token: number, id: string) => {
    navigation?.abort();
    const request = new AbortController();
    navigation = request;
    let child = allActivities.find((item) => item.id === id);
    if (!child?.threadId) {
      let raw: unknown;
      try {
        raw = await owner.route.sendRequest(
          THREAD_ACTIVITY_READ_METHOD,
          { threadId: owner.threadId, activityId: id },
          { priority: "interactive", timeoutMs: 10000 },
        );
      } catch (error) {
        if (request.signal.aborted) return;
        throw error;
      }
      if (!valid(owner, token) || request.signal.aborted) return;
      child = backgroundActivityDetailSchema.parse(raw).activity;
    }
    if (!valid(owner, token) || request.signal.aborted) return;
    if (child.kind !== "subagent" || !child.threadId)
      throw Error("Native child conversation is unavailable");
    openRendererActivityChild(owner, child);
  };
  const showDetail = async (id: string) => {
    const owner = context;
    if (!owner) return;
    const token = revision;
    selected = selected === id ? null : id;
    instructionsExpanded = false;
    detail = null;
    setError("");
    render();
    if (!selected) return;
    try {
      const raw = await owner.route.sendRequest(
        THREAD_ACTIVITY_READ_METHOD,
        { threadId: owner.threadId, activityId: id },
        { priority: "interactive", timeoutMs: 10000 },
      );
      if (!valid(owner, token) || selected !== id) return;
      detail = backgroundActivityDetailSchema.parse(raw);
      render();
    } catch (error) {
      if (valid(owner, token) && selected === id) setError(message(error));
    }
  };
  const render = () => {
    if (!body || !context) return;
    const key = JSON.stringify([
      activities,
      selected,
      detail && [detail.activity, detail.truncated],
    ]);
    if (key === renderKey && detail?.output === renderedOutput) return;
    renderKey = key;
    renderedOutput = detail?.output;
    body.replaceChildren();
    for (const activity of activities) {
      const row = window.document.createElement("div");
      const trigger = button("", () => void showDetail(activity.id), "activity-row");
      const title = window.document.createElement("span");
      title.className = ACTIVITY_SECTION_LABEL_CLASS;
      title.textContent = activitySummaryLabel(activity);
      trigger.append(title);
      trigger.setAttribute("aria-expanded", String(selected === activity.id));
      metadata(trigger, activity);
      row.append(trigger);
      body.append(row);
      if (selected !== activity.id) continue;
      const content = window.document.createElement("div");
      content.className = "activity-detail";
      row.append(content);
      if (!detail) {
        content.textContent = "Loading native details…";
        continue;
      }
      appendActivityOutput(content, detail, instructionsExpanded, (value) => {
        instructionsExpanded = value;
      });
      if (detail.truncated) {
        const note = window.document.createElement("span");
        note.className = "activity-meta text-xs text-secondary";
        note.textContent = "Native output is truncated.";
        content.append(note);
      }
      const owner = context;
      const token = revision;
      if (activity.relatedActivityId) {
        const id = activity.relatedActivityId;
        const open = button(
          "Open latest run",
          () => {
            if (!valid(owner, token)) return;
            open.disabled = true;
            setError("");
            void openChild(owner, token, id)
              .catch((error: unknown) => {
                if (valid(owner, token)) setError(message(error));
              })
              .finally(() => {
                if (valid(owner, token)) open.disabled = false;
              });
          },
          "activity-action",
        );
        content.append(open);
      }
      if (detail.activity.canStop) {
        const stop = button(
          activity.kind === "loop" ? "Delete schedule" : "Stop task",
          () => {
            if (!valid(owner, token)) return;
            stop.disabled = true;
            void (async () => {
              try {
                const raw = await owner.route.sendRequest(
                  THREAD_ACTIVITY_STOP_METHOD,
                  { threadId: owner.threadId, activityId: activity.id },
                  { priority: "interactive", timeoutMs: 10000 },
                );
                if (!valid(owner, token)) return;
                const result = threadActivityStopResultSchema.parse(raw);
                setError(result.outcome === "notFound" ? "Native activity was not found." : "");
                await refresh();
              } catch (error) {
                if (valid(owner, token)) setError(message(error));
              } finally {
                if (valid(owner, token)) stop.disabled = false;
              }
            })();
          },
          "activity-action",
        );
        content.append(stop);
      }
    }
    clocks();
  };
  const mount = (owner: QuestionContext, target: HTMLElement) => {
    root = window.document.createElement("section");
    root.dataset.codexhostBackgroundActivity = owner.threadId;
    root.className = ACTIVITY_SECTION_CLASS;
    const style = window.document.createElement("style");
    style.textContent = CSS;
    const heading = window.document.createElement("header");
    heading.className = ACTIVITY_SECTION_HEADING_CLASS;
    const toggle = button(
      "",
      () => {
        expanded = !expanded;
        syncExpanded();
      },
      ACTIVITY_SECTION_TOGGLE_CLASS,
    );
    const label = window.document.createElement("span");
    label.className = "truncate";
    label.textContent = "Background activity";
    const disclosure = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    disclosure.setAttribute("class", "activity-disclosure");
    disclosure.setAttribute("width", "12");
    disclosure.setAttribute("height", "12");
    disclosure.setAttribute("viewBox", "0 0 24 24");
    disclosure.setAttribute("aria-hidden", "true");
    const path = window.document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m9 5 7 7-7 7");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    disclosure.append(path);
    toggle.append(label, disclosure);
    heading.append(toggle);
    errorNode = window.document.createElement("div");
    errorNode.className = "activity-error";
    errorNode.setAttribute("role", "status");
    body = window.document.createElement("div");
    body.className = ACTIVITY_SECTION_CONTENT_CLASS;
    const syncExpanded = () => {
      toggle.setAttribute("aria-expanded", String(expanded));
      disclosure.style.transform = expanded ? "rotate(90deg)" : "";
      if (body) body.hidden = !expanded;
      if (errorNode) errorNode.hidden = !expanded;
    };
    syncExpanded();
    root.append(style, heading, errorNode, body);
    root.addEventListener("click", (event) => event.stopPropagation());
    target.append(root);
    renderKey = "";
  };
  const syncTarget = (owner: QuestionContext) => {
    const { target } = activitySectionTarget(window, owner.composer, container);
    if (!target) {
      unmount();
      // A hidden panel may retain its validated container after its last native section ends.
      // Target resolution rechecks workspace, visibility and ownership before reuse.
      if (!container?.isConnected) container = null;
      return;
    }
    container = target;
    if (!activities.length) {
      unmount();
      return;
    }
    if (!root?.isConnected) mount(owner, target);
    else if (root.parentElement !== target) target.append(root);
    render();
  };
  const refresh = async () => {
    if (disposed) return;
    const next = readContext();
    if (!same(context, next)) {
      revision++;
      inFlight = null;
      clear();
      context = next;
    }
    const owner = context;
    if (!owner) return;
    if (inFlight || unsupported.has(owner.route)) return;
    const token = revision;
    const request = {};
    inFlight = request;
    try {
      const raw = await owner.route.sendRequest(
        THREAD_ACTIVITY_LIST_METHOD,
        { threadId: owner.threadId },
        { priority: "background", timeoutMs: 5000 },
      );
      if (!valid(owner, token)) return;
      const result = threadActivityListResultSchema.parse(raw);
      if (!result.supported) {
        clear();
        return;
      }
      allActivities = result.activities;
      activities = supplementalBackgroundActivities(allActivities);
      if (selected && !activities.some((item) => item.id === selected)) {
        selected = null;
        instructionsExpanded = false;
        detail = null;
      }
      syncTarget(owner);
      if (selected) {
        const id = selected;
        const rawDetail = await owner.route.sendRequest(
          THREAD_ACTIVITY_READ_METHOD,
          { threadId: owner.threadId, activityId: id },
          { priority: "background", timeoutMs: 5000 },
        );
        if (!valid(owner, token) || selected !== id) return;
        detail = backgroundActivityDetailSchema.parse(rawDetail);
        render();
      }
    } catch (error) {
      if (!valid(owner, token)) return;
      if (isUnsupportedMethod(error, THREAD_ACTIVITY_LIST_METHOD)) {
        unsupported.add(owner.route);
        clear();
      } else {
        syncTarget(owner);
        setError(message(error));
      }
    } finally {
      if (inFlight === request) inFlight = null;
    }
  };
  const timer = window.setInterval(() => {
    clocks();
    void refresh();
  }, 1000);
  void refresh();
  return {
    refreshContext() {
      if (!same(context, readContext()) || (root && !root.isConnected)) void refresh();
    },
    dispose() {
      disposed = true;
      revision++;
      window.clearInterval(timer);
      clear();
    },
  };
}
