import { describe, expect, it, vi } from "vitest";
import {
  hostTurnIdSchema,
  THREAD_QUESTIONS_LIST_METHOD,
  THREAD_QUESTION_RESPOND_METHOD,
  THREAD_QUESTION_ACTIVITY_METHOD,
} from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
  requestId,
  method,
} from "./app-server-host-fixture.js";

const question = {
  id: "letters",
  type: "choice" as const,
  prompt: "Choose letters",
  multiple: true,
  allowOther: false,
  optional: false,
  options: [
    { value: "a", label: "Alpha" },
    { value: "g", label: "Gamma" },
  ],
};

describe("shared multi-select questions", () => {
  it("validates activity ownership and publishes only a native ack without answering", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const initial = {
        deadlineUnixMs: Date.now() + 2000,
        action: "recommended" as const,
        resetOnActivity: true,
      };
      const ack = { ...initial, deadlineUnixMs: Date.now() + 120000 };
      const reset = vi.fn(async () => ({ ok: true as const, value: ack }));
      Object.assign(session, { questionActivity: reset });
      const interactionId = session.askQuestion(question, { autoResolution: initial });
      let id = 400;
      const rpc = async (method: string, params: JsonObject) => {
        const n = id++;
        writeRequest(fixture.desktopInput, { id: n, method, params });
        return fixture.collector.waitFor((message) => requestId(message, n));
      };
      await vi.waitFor(async () =>
        expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
          result: { questions: [{ interactionId }] },
        }),
      );
      const params = { threadId, turnId, interactionId };
      for (const foreign of [
        { threadId: "foreign" },
        { turnId: "foreign" },
        { interactionId: "foreign" },
      ])
        expect(await rpc(THREAD_QUESTION_ACTIVITY_METHOD, { ...params, ...foreign })).toMatchObject(
          { error: { code: -32080 } },
        );
      expect(reset).not.toHaveBeenCalled();
      expect(await rpc(THREAD_QUESTION_ACTIVITY_METHOD, { ...params, answers: {} })).toMatchObject({
        error: { code: -32602 },
      });
      expect(await rpc(THREAD_QUESTION_ACTIVITY_METHOD, params)).toMatchObject({
        result: { autoResolution: ack },
      });
      expect(reset).toHaveBeenCalledWith(interactionId);
      expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
        result: { questions: [{ autoResolution: ack }] },
      });
      expect(session.interactionResponses).toHaveLength(0);
      let complete!: (value: { ok: true; value: typeof ack }) => void;
      reset.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const late = rpc(THREAD_QUESTION_ACTIVITY_METHOD, params);
      await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(2));
      session.emitEvent({
        type: "interaction.closed",
        turnId: hostTurnIdSchema.parse(turnId),
        interactionId,
        reason: "cancelled",
      });
      // Desktop requests are read serially; let native output retire the question
      // before releasing the pending acknowledgement, then list it afterwards.
      await new Promise((resolve) => setImmediate(resolve));
      complete({ ok: true, value: ack });
      expect(await late).toMatchObject({ result: { autoResolution: null } });
      expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
        result: { questions: [] },
      });
      session.failTurn({ code: "unavailable", message: "End activity fixture", retryable: false });
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([false, true])(
    "does not reset without native support (advertised=%s)",
    async (advertised) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Missing Session");
        const reset = vi.fn();
        if (!advertised) Object.assign(session, { questionActivity: reset });
        const interactionId = session.askQuestion(question, {
          autoResolution: { deadlineUnixMs: 1, action: "decline", resetOnActivity: advertised },
        });
        let id = 450;
        await vi.waitFor(async () => {
          const n = id++;
          writeRequest(fixture.desktopInput, {
            id: n,
            method: THREAD_QUESTION_ACTIVITY_METHOD,
            params: { threadId, turnId, interactionId },
          });
          expect(await fixture.collector.waitFor((message) => requestId(message, n))).toMatchObject(
            { result: { autoResolution: null } },
          );
        });
        expect(reset).not.toHaveBeenCalled();
        session.failTurn({
          code: "unavailable",
          message: "End disabled activity",
          retryable: false,
        });
      } finally {
        await stopFixture(fixture);
      }
    },
  );
  it("publishes a native countdown without cancelling at its display deadline", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const autoResolution = { deadlineUnixMs: Date.now() - 1000, action: "recommended" as const };
      const interactionId = session.askQuestion(question, { autoResolution });
      let id = 300;
      const list = async () => {
        const n = id++;
        writeRequest(fixture.desktopInput, {
          id: n,
          method: THREAD_QUESTIONS_LIST_METHOD,
          params: { threadId },
        });
        return fixture.collector.waitFor((message) => requestId(message, n));
      };
      await vi.waitFor(async () =>
        expect(await list()).toMatchObject({
          result: { questions: [{ interactionId, autoResolution }] },
        }),
      );
      expect(session.interactionResponses).toHaveLength(0);
      expect(await list()).toMatchObject({ result: { questions: [{ interactionId }] } });
      session.failTurn({ code: "unavailable", message: "End countdown fixture", retryable: false });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps single-choice Other questions outside the native blocking Composer", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const interactionId = session.askQuestion({ ...question, multiple: false, allowOther: true });
      let id = 200;
      const rpc = async (method: string, params: JsonObject) => {
        const n = id++;
        writeRequest(fixture.desktopInput, { id: n, method, params });
        return fixture.collector.waitFor((message) => requestId(message, n));
      };
      await vi.waitFor(async () =>
        expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
          result: {
            questions: [{ interactionId, questions: [{ multiple: false, allowOther: true }] }],
          },
        }),
      );
      expect(fixture.collector.messages.some((m) => method(m, "item/tool/requestUserInput"))).toBe(
        false,
      );
      const params = {
        threadId,
        turnId,
        interactionId,
        answers: { letters: ["Other layout test"] },
      };
      expect(
        await rpc(THREAD_QUESTION_RESPOND_METHOD, { ...params, answers: { letters: ["a", "g"] } }),
      ).toMatchObject({ error: { code: -32602 } });
      expect(await rpc(THREAD_QUESTION_RESPOND_METHOD, params)).toMatchObject({
        result: { accepted: true },
      });
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "question", answers: { letters: ["Other layout test"] } } },
      ]);
      session.succeedTurn();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("lists only extended questions and validates ownership, answers and duplicate submissions", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const interactionId = session.askQuestion(question);
      let id = 100;
      const rpc = async (method: string, params: JsonObject) => {
        const n = id++;
        writeRequest(fixture.desktopInput, { id: n, method, params });
        return fixture.collector.waitFor((message) => requestId(message, n));
      };
      await vi.waitFor(async () =>
        expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
          result: { questions: [{ interactionId, turnId, questions: [{ multiple: true }] }] },
        }),
      );
      expect(fixture.collector.messages.some((m) => method(m, "item/tool/requestUserInput"))).toBe(
        false,
      );
      expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId: "foreign" })).toMatchObject({
        result: { questions: [] },
      });
      const params = { threadId, turnId, interactionId, answers: { letters: ["a", "g"] } };
      expect(
        await rpc(THREAD_QUESTION_RESPOND_METHOD, { ...params, threadId: "foreign" }),
      ).toMatchObject({ error: { code: -32080 } });
      expect(
        await rpc(THREAD_QUESTION_RESPOND_METHOD, { ...params, turnId: "foreign" }),
      ).toMatchObject({ error: { code: -32080 } });
      for (const answers of [
        { letters: ["a", "a"] },
        { letters: ["unknown"] },
        { letters: [] },
        { foreign: ["a"] },
      ])
        expect(await rpc(THREAD_QUESTION_RESPOND_METHOD, { ...params, answers })).toMatchObject({
          error: { code: -32602 },
        });
      expect(session.interactionResponses).toHaveLength(0);
      // A guessed native request id cannot answer a custom card.
      writeRequest(fixture.desktopInput, {
        id: -1,
        result: { answers: { letters: { answers: ["Alpha"] } } },
      });
      expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
        result: { questions: [{ interactionId }] },
      });
      expect(await rpc(THREAD_QUESTION_RESPOND_METHOD, params)).toMatchObject({
        result: { accepted: true },
      });
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "question", answers: { letters: ["a", "g"] } } },
      ]);
      expect(await rpc(THREAD_QUESTION_RESPOND_METHOD, params)).toMatchObject({
        error: { code: -32080 },
      });
      expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
        result: { questions: [] },
      });
      session.succeedTurn();
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["cancel", "withdraw", "expire", "finish"])(
    "cleans up on %s and refuses late answers",
    async (action) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const turnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Missing Session");
        const interactionId = session.askQuestion(
          question,
          action === "expire" ? { expiresAt: new Date(Date.now() + 200).toISOString() } : {},
        );
        let id = 100;
        const rpc = async (method: string, params: JsonObject) => {
          const n = id++;
          writeRequest(fixture.desktopInput, { id: n, method, params });
          return fixture.collector.waitFor((message) => requestId(message, n));
        };
        await vi.waitFor(async () =>
          expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
            result: { questions: [{ interactionId }] },
          }),
        );
        if (action === "cancel")
          expect(
            await rpc(THREAD_QUESTION_RESPOND_METHOD, {
              threadId,
              turnId,
              interactionId,
              answers: {},
              cancelled: true,
            }),
          ).toMatchObject({ result: { accepted: true } });
        if (action === "withdraw")
          session.emitEvent({
            type: "interaction.closed",
            turnId: hostTurnIdSchema.parse(turnId),
            interactionId,
            reason: "cancelled",
          });
        if (action === "finish")
          session.failTurn({ code: "unavailable", message: "Native Turn ended", retryable: false });
        await vi.waitFor(async () =>
          expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).toMatchObject({
            result: { questions: [] },
          }),
        );
        expect(
          await rpc(THREAD_QUESTION_RESPOND_METHOD, {
            threadId,
            turnId,
            interactionId,
            answers: { letters: ["a", "g"] },
          }),
        ).toMatchObject({ error: { code: -32080 } });
      } finally {
        await stopFixture(fixture);
      }
    },
  );
});
