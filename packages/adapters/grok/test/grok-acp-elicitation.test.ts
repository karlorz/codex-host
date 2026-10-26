import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  GROK_ASK_USER_QUESTION_METHOD,
  GROK_QUESTION_ACTIVITY_METHOD,
  GrokQuestions,
} from "../src/grok-questions.js";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { GrokAcpTransport } from "../src/acp-transport.js";
import {
  GROK_CLOCK_ELICIT_FIXTURE,
  GROK_MCP_ELICIT_METHOD,
  grokMcpElicitAccept,
  grokMcpElicitCancel,
} from "../src/grok-elicitation.js";

const permissionModeId = harnessPermissionModeIdSchema.parse("ask");

async function withFixture(
  script: string,
  run: (transport: GrokAcpTransport, capture: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-elicit-"));
  const command = path.join(root, "fixture.mjs");
  const capture = path.join(root, "captured.jsonl");
  await writeFile(command, script.replaceAll("__CAPTURE__", JSON.stringify(capture)), {
    mode: 0o755,
  });
  const transport = new GrokAcpTransport({
    cwd: root,
    command,
    environment: { HOME: root, GROK_HOME: root },
    commandTimeoutMs: 4000,
    closeTimeoutMs: 200,
  });
  try {
    await run(transport, capture);
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}

const clockParams = {
  ...GROK_CLOCK_ELICIT_FIXTURE,
  sessionId: "created",
};

describe.skipIf(process.platform === "win32")("Grok ACP MCP elicitation wire", () => {
  it("keeps empty clientCapabilities and replies to _x.ai/mcp/elicit with a flat outcome", async () => {
    await withFixture(
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = __CAPTURE__;
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let promptId;
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(capture, line + '\\n');
  if (request.method === 'initialize') {
    send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
  } else if (request.method === 'session/new') {
    send({id:request.id,result:{sessionId:'created'}});
  } else if (request.method === 'session/prompt') {
    promptId = request.id;
    send({id:'elicit-1', method:'${GROK_MCP_ELICIT_METHOD}', params:${JSON.stringify(clockParams)}});
  } else if (request.id === 'elicit-1') {
    send({id:promptId,result:{stopReason:'end_turn'}});
  }
});
`,
      async (transport, capture) => {
        await transport.open({ kind: "create", permissionModeId });
        const response = await transport.runTurn(
          "open clock",
          () => undefined,
          async () => ({ outcome: { outcome: "cancelled" } }),
          async () => grokMcpElicitAccept(),
        );
        expect(response).toEqual({ stopReason: "end_turn" });
        const lines = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const initialize = lines.find((line) => line.method === "initialize");
        expect((initialize?.params as { clientCapabilities?: unknown }).clientCapabilities).toEqual(
          {},
        );
        const elicitReply = lines.find((line) => line.id === "elicit-1");
        expect(elicitReply).toMatchObject({
          id: "elicit-1",
          result: grokMcpElicitAccept(),
        });
        expect(elicitReply && "error" in elicitReply).toBe(false);
      },
    );
  });

  it("cancels elicitation with no active prompt and rejects an unknown extension method", async () => {
    await withFixture(
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = __CAPTURE__;
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(capture, line + '\\n');
  if (request.method === 'initialize') {
    send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
  } else if (request.method === 'session/new') {
    send({id:request.id,result:{sessionId:'created'}});
    send({id:'elicit-idle', method:'${GROK_MCP_ELICIT_METHOD}', params:${JSON.stringify(clockParams)}});
    send({id:'unknown-ext', method:'elicitation/create', params:{}});
  }
});
`,
      async (transport, capture) => {
        await transport.open({ kind: "create", permissionModeId });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const lines = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines.find((line) => line.id === "elicit-idle")).toMatchObject({
          result: grokMcpElicitCancel(),
        });
        const unknown = lines.find((line) => line.id === "unknown-ext") as {
          error?: { code?: number };
        };
        expect(unknown?.error?.code).toBe(-32601);
      },
    );
  });
});

const nativeQuestion = {
  sessionId: "created",
  toolCallId: "ask-1",
  mode: "default",
  questions: [
    {
      question: "Which letter?",
      multiSelect: false,
      options: [
        { label: "Alpha", description: "First" },
        { label: "Beta", description: "Second" },
      ],
    },
  ],
};

function questionFixture(
  params: unknown,
  withdraw = false,
  idle = false,
  permissionResolved = false,
  activityReply: unknown = { result: { timeout: null } },
): string {
  return `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = __CAPTURE__;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', ...value })+'\\n');
let promptId;
createInterface({ input:process.stdin }).on('line', line => {
 const request=JSON.parse(line); appendFileSync(capture,line+'\\n');
 if (request.method==='initialize') send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if (request.method==='session/new') {
   send({id:request.id,result:{sessionId:'created'}});
   if (${idle}) send({id:'ask-wire',method:'${GROK_ASK_USER_QUESTION_METHOD}',params:${JSON.stringify(params)}});
 } else if (request.method==='session/prompt') {
   promptId=request.id;
   if (${permissionResolved}) send({method:'_x.ai/session_notification',params:{sessionId:'created',update:{sessionUpdate:'interaction_resolved',tool_call_id:'ask-1'}}});
   send({id:'ask-wire',method:'${GROK_ASK_USER_QUESTION_METHOD}',params:${JSON.stringify(params)}});
   if (${withdraw}) setTimeout(() => send({method:'_x.ai/session_notification',params:{sessionId:'created',update:{sessionUpdate:'interaction_resolved',tool_call_id:'ask-1'}}}), 20);
 } else if (request.method==='${GROK_QUESTION_ACTIVITY_METHOD}') {
   send({id:request.id,...${JSON.stringify(activityReply)}});
 } else if (request.id==='ask-wire') {
   if (promptId !== undefined) send({id:promptId,result:{stopReason:'end_turn'}});
 }
});
`;
}

async function capturedReply(capture: string) {
  const lines = (await readFile(capture, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return lines.find((line) => line.id === "ask-wire");
}

describe.skipIf(process.platform === "win32")("Grok ACP native question wire", () => {
  it.each([
    {
      result: { timeout: { deadlineUnixMs: 12345, action: "recommended", resetOnActivity: true } },
    },
    { result: { timeout: null } },
    { error: { code: -32601, message: "Method not found" } },
    { result: { timeout: { deadlineUnixMs: -1, action: "recommended" } } },
  ])("requests native activity while the reverse question is open: %j", async (reply) => {
    await withFixture(
      questionFixture(nativeQuestion, false, false, false, reply),
      async (transport, capture) => {
        await transport.open({ kind: "create", permissionModeId });
        expect(await transport.questionActivity("ask-1")).toBeNull();
        await transport.runTurn(
          "ask",
          () => undefined,
          async () => ({ outcome: { outcome: "cancelled" } }),
          async () => grokMcpElicitCancel(),
          async () => {
            const activity = transport.questionActivity("ask-1");
            if ("result" in reply && reply.result.timeout?.deadlineUnixMs === -1)
              await expect(activity).rejects.toThrow();
            else
              await expect(activity).resolves.toEqual(
                "result" in reply ? reply.result.timeout : null,
              );
            // The activity acknowledgement must not complete the reverse question.
            expect(await capturedReply(capture)).toBeUndefined();
            return { outcome: "cancelled" };
          },
        );
        const calls = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call.method === GROK_QUESTION_ACTIVITY_METHOD)).toMatchObject(
          [{ params: { sessionId: "created", toolCallId: "ask-1" } }],
        );
      },
    );
  });
  it.each([
    { permissionResolved: false, multiple: false },
    { permissionResolved: true, multiple: false },
    { permissionResolved: false, multiple: true },
    { permissionResolved: true, multiple: true },
  ])("answers the actual extension: %j", async ({ permissionResolved, multiple }) => {
    const selected = multiple ? ["Alpha", "Beta"] : ["Alpha"];
    await withFixture(
      questionFixture(
        {
          ...nativeQuestion,
          questions: [{ ...nativeQuestion.questions[0], multiSelect: multiple }],
        },
        false,
        false,
        permissionResolved,
      ),
      async (transport, capture) => {
        await transport.open({ kind: "create", permissionModeId });
        const outputs: HarnessOutput[] = [];
        const questions = new GrokQuestions(
          hostTurnIdSchema.parse("turn"),
          () => "question",
          (output) => {
            outputs.push(output);
            if (output.kind === "interaction") {
              const result = questions.respond({
                type: "interaction.respond",
                interactionId: output.interaction.interactionId,
                response: { type: "question", answers: { q0: selected } },
              });
              expect(result.ok).toBe(true);
            }
          },
        );
        const result = await transport.runTurn(
          "ask",
          (event) => {
            if (event.type === "interaction.resolved") questions.withdraw(event.toolCallId);
          },
          async () => ({ outcome: { outcome: "cancelled" } }),
          async () => grokMcpElicitCancel(),
          (request) => questions.ask(request),
        );
        expect(result.stopReason).toBe("end_turn");
        expect(await capturedReply(capture)).toEqual({
          jsonrpc: "2.0",
          id: "ask-wire",
          result: { outcome: "accepted", answers: { "Which letter?": selected } },
        });
        expect(outputs[0]).toMatchObject({
          kind: "interaction",
          interaction: { type: "question" },
        });
        expect(outputs[1]).toMatchObject({
          kind: "event",
          event: { type: "interaction.closed", reason: "responded" },
        });
      },
    );
  });

  it("observes native timeout withdrawal without submitting a default answer or adding a Host timer", async () => {
    await withFixture(questionFixture(nativeQuestion, true), async (transport, capture) => {
      await transport.open({ kind: "create", permissionModeId });
      const outputs: HarnessOutput[] = [];
      const questions = new GrokQuestions(
        hostTurnIdSchema.parse("turn"),
        () => "question",
        (output) => outputs.push(output),
      );
      await transport.runTurn(
        "ask",
        (event) => {
          if (event.type === "interaction.resolved") questions.withdraw(event.toolCallId);
        },
        async () => ({ outcome: { outcome: "cancelled" } }),
        async () => grokMcpElicitCancel(),
        (request) => questions.ask(request),
      );
      expect(await capturedReply(capture)).toMatchObject({ result: { outcome: "cancelled" } });
      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toMatchObject({ kind: "interaction", interaction: { type: "question" } });
      expect(outputs[1]).toMatchObject({
        kind: "event",
        event: { type: "interaction.closed", reason: "cancelled" },
      });
    });
  });

  it.each([
    [{ ...nativeQuestion, sessionId: "foreign" }, "cancelled"],
    [{ ...nativeQuestion, questions: [] }, "invalid"],
    [
      {
        ...nativeQuestion,
        questions: [{ ...nativeQuestion.questions[0], multiSelect: "invalid" }],
      },
      "invalid",
    ],
  ] as const)(
    "does not show a card for foreign or unsupported native requests: %j",
    async (params, result) => {
      await withFixture(questionFixture(params), async (transport, capture) => {
        await transport.open({ kind: "create", permissionModeId });
        await transport.runTurn(
          "ask",
          () => undefined,
          async () => ({ outcome: { outcome: "cancelled" } }),
          async () => grokMcpElicitCancel(),
          async () => {
            throw new Error("Must not show a question");
          },
        );
        const reply = await capturedReply(capture);
        expect(reply).toMatchObject(
          result === "cancelled"
            ? { result: { outcome: "cancelled" } }
            : { error: { code: -32602 } },
        );
      });
    },
  );

  it("cancels a reverse-request outside an active Turn", async () => {
    await withFixture(questionFixture(nativeQuestion, false, true), async (transport, capture) => {
      await transport.open({ kind: "create", permissionModeId });
      await expect
        .poll(async () => capturedReply(capture))
        .toMatchObject({ result: { outcome: "cancelled" } });
    });
  });
});
