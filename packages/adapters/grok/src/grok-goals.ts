import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  harnessGoalSchema,
  type HarnessGoal,
  type HarnessGoalSet,
} from "@codexhost/shared-contracts";
import type { HarnessGoalCapability, HarnessResult } from "@codexhost/harness-adapter";

const status: Record<string, HarnessGoal["status"]> = {
  active: "active",
  paused: "paused",
  user_paused: "paused",
  back_off_paused: "paused",
  no_progress_paused: "paused",
  infra_paused: "paused",
  blocked: "blocked",
  budget_limited: "budgetLimited",
  complete: "complete",
};
export function projectGrokGoal(
  state: Record<string, unknown>,
  updatedAt: number,
  update?: Record<string, unknown>,
): HarnessGoal {
  const source = update ?? state;
  return harnessGoalSchema.parse({
    objective: source.objective,
    status: status[String(source.status)],
    tokenBudget: source.token_budget ?? null,
    tokensUsed: update ? source.tokens_used : state.tokens_used_high_water,
    timeUsedSeconds:
      typeof source.elapsed_ms === "number" ? Math.floor(source.elapsed_ms / 1000) : undefined,
    createdAt: Math.floor(Date.parse(String(state.created_at)) / 1000),
    updatedAt: Math.floor(updatedAt / 1000),
  });
}
export async function readGrokGoal(
  directory: string,
): Promise<{ state: Record<string, unknown>; updatedAt: number } | null> {
  const filename = path.join(directory, "goal", "state.json");
  try {
    const state = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
    return { state, updatedAt: (await stat(filename)).mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const failure = (message: string): HarnessResult<never> => ({
  ok: false,
  error: { code: "unavailable", message, retryable: false },
});

/** Native controls acknowledge goal state; their planner/worker output has an independent owner. */
export class GrokGoals implements HarnessGoalCapability {
  #mutating = false;
  #active = false;
  #closed = false;
  #version = 0;
  #creation: {
    objective: string;
    tokenBudget: number | null;
    promise: Promise<HarnessResult<HarnessGoal>>;
    nativeId: string | undefined;
  } | null = null;
  #latest: { id: unknown; goal: HarnessGoal; observedAt: number } | null = null;
  constructor(
    readonly directory: string,
    readonly control: (prompt: string) => Promise<unknown>,
    readonly changed: (goal: HarnessGoal | null) => void,
    readonly timeoutMs = 30_000,
  ) {}
  get busy() {
    return this.#mutating;
  }
  get active() {
    return this.#active;
  }
  close() {
    this.#closed = true;
    this.#active = false;
    this.#creation = null;
    this.#version++;
  }
  async observe(update: Record<string, unknown> | null): Promise<void> {
    const version = ++this.#version;
    if (update === null) {
      this.#active = false;
      this.#latest = null;
      this.#creation = null;
      if (!this.#closed) this.changed(null);
      return;
    }
    this.#active = update.status === "active";
    // Creation can precede the persistence actor. The wire supplies accounting, the native
    // snapshot supplies the original creation timestamp omitted from GoalUpdated.
    for (let attempt = 0; attempt < 20 && !this.#closed && version === this.#version; attempt++) {
      const stored = await readGrokGoal(this.directory);
      if (stored && stored.state.goal_id === update.goal_id) {
        const goal = projectGrokGoal(stored.state, Date.now(), update);
        if (!this.#closed && version === this.#version) {
          this.#latest = { id: update.goal_id, goal, observedAt: Date.now() };
          this.changed(goal);
        }
        return;
      }
      await delay(50);
    }
  }
  async read(): Promise<HarnessResult<HarnessGoal | null>> {
    if (this.#closed) return failure("Grok goal Session is closed");
    try {
      const stored = await readGrokGoal(this.directory);
      const goal = this.#projectStored(stored);
      this.#active = goal?.status === "active";
      return { ok: true, value: goal };
    } catch {
      return failure("Grok native goal accounting is unavailable");
    }
  }
  #projectStored(stored: Awaited<ReturnType<typeof readGrokGoal>>): HarnessGoal | null {
    const latest = this.#latest;
    return stored
      ? latest && latest.id === stored.state.goal_id && latest.observedAt >= stored.updatedAt
        ? latest.goal
        : projectGrokGoal(stored.state, stored.updatedAt)
      : null;
  }
  async set(input: HarnessGoalSet): Promise<HarnessResult<HarnessGoal>> {
    if (
      input.objective !== undefined &&
      (input.status === "paused" ||
        /[\r\n]/u.test(input.objective) ||
        /^(?:status|pause|resume|clear)$/u.test(input.objective.trim()))
    )
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Grok cannot create a paused, multiline or reserved-control objective",
          retryable: false,
        },
      };
    if (input.objective !== undefined && /(?:^|\s)--budget(?:\s|$)/u.test(input.objective))
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Set the native goal budget through tokenBudget, not objective command syntax",
          retryable: false,
        },
      };
    if (input.tokenBudget !== undefined && !input.objective)
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Grok only accepts a token budget when creating a goal",
          retryable: false,
        },
      };
    if (!input.objective && !input.status)
      return failure("Grok goal mutation has no supported change");
    if (this.#closed) return failure("Grok goal Session is closed");
    if (!input.objective) return this.#setNative(input);
    const creation = this.#creation;
    if (
      creation?.objective === input.objective &&
      creation.tokenBudget === (input.tokenBudget ?? null)
    ) {
      // Desktop starts a new Goal chat with a /goal Turn, then sends the same
      // objective via thread/goal/set. Both acknowledge one native creation.
      if (!creation.nativeId) return creation.promise;
      try {
        const stored = await readGrokGoal(this.directory);
        if (
          stored?.state.goal_id === creation.nativeId &&
          stored.state.status === "active" &&
          stored.state.objective === input.objective &&
          (stored.state.token_budget ?? null) === creation.tokenBudget
        ) {
          const goal = this.#projectStored(stored);
          if (
            goal?.status === "active" &&
            goal.objective === input.objective &&
            goal.tokenBudget === creation.tokenBudget
          )
            return { ok: true, value: goal };
        }
      } catch {
        return failure("Grok native goal accounting is unavailable");
      }
    }
    if (this.#mutating) return failure("Grok goal operation is unavailable");
    const pending = {
      objective: input.objective,
      tokenBudget: input.tokenBudget ?? null,
      promise: this.#setNative(input).catch(() =>
        failure("Grok native goal accounting is unavailable"),
      ),
      nativeId: undefined as string | undefined,
    };
    this.#creation = pending;
    const result = await pending.promise;
    if (result.ok && this.#creation === pending) {
      try {
        const id = (await readGrokGoal(this.directory))?.state.goal_id;
        if (typeof id === "string") pending.nativeId = id;
        else this.#creation = null;
      } catch {
        this.#creation = null;
      }
    } else if (this.#creation === pending) this.#creation = null;
    return result;
  }
  async #setNative(input: HarnessGoalSet): Promise<HarnessResult<HarnessGoal>> {
    const prompt = input.objective
      ? `/goal ${input.objective}${input.tokenBudget == null ? "" : ` --budget ${input.tokenBudget}`}`
      : `/goal ${input.status === "paused" ? "pause" : "resume"}`;
    const result = await this.#mutate(
      prompt,
      (goal, before) =>
        goal !== null &&
        (input.objective !== undefined
          ? goal.objective === input.objective &&
            (input.tokenBudget === undefined || goal.tokenBudget === input.tokenBudget) &&
            goal.createdAt >= (before?.createdAt ?? 0)
          : goal.status === input.status),
    );
    return result.ok && result.value !== null
      ? { ok: true, value: result.value }
      : result.ok
        ? failure("Grok did not confirm a goal")
        : result;
  }
  async clear(): Promise<HarnessResult<{ cleared: boolean }>> {
    const before = await this.read();
    if (!before.ok) return before;
    if (before.value === null) return { ok: true, value: { cleared: false } };
    const result = await this.#mutate("/goal clear", (goal) => goal === null);
    return result.ok ? { ok: true, value: { cleared: true } } : result;
  }
  async #mutate(
    prompt: string,
    matches: (goal: HarnessGoal | null, before: HarnessGoal | null) => boolean,
  ): Promise<HarnessResult<HarnessGoal | null>> {
    if (this.#mutating || this.#closed) return failure("Grok goal operation is unavailable");
    this.#mutating = true;
    try {
      const before = await this.read();
      if (!before.ok) return before;
      const beforeIdentity = (await readGrokGoal(this.directory))?.state.goal_id;
      const creating = !["/goal pause", "/goal resume", "/goal clear"].includes(prompt);
      let error: unknown;
      let settled = false;
      const version = this.#version;
      // GoalSet can keep its ACP response open while planning. Confirmation is native state,
      // and the ongoing native prompt remains owned by the transport's background observer.
      void this.control(prompt).then(
        () => {
          settled = true;
        },
        (cause: unknown) => {
          error = cause;
        },
      );
      const deadline = Date.now() + this.timeoutMs;
      while (!this.#closed && Date.now() < deadline) {
        if (error) return failure("Grok rejected the goal control");
        const current = await this.read();
        if (
          (settled || (creating && this.#version > version)) &&
          current.ok &&
          matches(current.value, before.value) &&
          (!creating || (await readGrokGoal(this.directory))?.state.goal_id !== beforeIdentity)
        ) {
          this.changed(current.value);
          return current;
        }
        // The ACP reply and persistence actor are independent. Even a finished control
        // must wait for its durable state instead of treating the earlier snapshot as final.
        await delay(50);
      }
      return failure("Grok goal change was not confirmed; re-read native state before retrying");
    } finally {
      this.#mutating = false;
    }
  }
}
