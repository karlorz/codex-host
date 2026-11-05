import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { GrokAcpTransport } from "../src/acp-transport.js";
import type { GrokPlanApprovalResponse } from "../src/grok-plan-approval.js";

async function fixture(scenario: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-plan-"));
  const command = path.join(root, "grok.mjs");
  const records = path.join(root, "wire.jsonl");
  await writeFile(
    command,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = process.env.PLAN_SCENARIO;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
let operation;
const ask = (method='_x.ai/exit_plan_mode') => {
 const params = { sessionId: scenario==='foreign'?'foreign':'fixture', toolCallId:'exit-1',
   planContent: scenario==='empty'?undefined:'# Plan' };
 if(scenario==='malformed') params.toolCallId = '';
 send({id:'plan',method:scenario==='unknown'?'_x.ai/unsupported':method,params});
};
createInterface({input:process.stdin}).on('line', line => {
 const req=JSON.parse(line);
 appendFileSync(process.env.PLAN_RECORDS, line+'\\n');
 const reply = result => send({id:req.id,result});
 if(req.id==='plan') {
   if(operation!==undefined) send({id:operation,result:{stopReason:'end_turn'}});
 } else if(req.method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{}}},authMethods:[]});
 else if(req.method==='session/new' || req.method==='session/load') {
   reply({sessionId:'fixture'});
   if(scenario==='idle') ask();
 } else if(req.method==='session/prompt') {
   operation=req.id; ask(scenario==='unprefixed'?'x.ai/exit_plan_mode':'_x.ai/exit_plan_mode');
 } else if(req.method==='session/set_mode') {
   if(scenario==='set-mode-fail') send({id:req.id,error:{code:-32601,message:'Method not found'}});
   else reply({});
 } else if(req.method==='session/close') { reply({}); setTimeout(()=>process.exit(0),10); }
 else if(req.method==='_x.ai/session/info') reply({result:{sessionId:'fixture'}});
 else if(req.id!==undefined) send({id:req.id,error:{code:-32601,message:'Method not found'}});
});
`,
    { mode: 0o755 },
  );
  const transport = new GrokAcpTransport({
    command,
    cwd: root,
    environment: {
      GROK_HOME: root,
      PLAN_SCENARIO: scenario,
      PLAN_RECORDS: records,
    },
    commandTimeoutMs: 2000,
    closeTimeoutMs: 500,
  });
  try {
    await transport.open({
      kind: "create",
      permissionModeId: harnessPermissionModeIdSchema.parse(
        scenario === "open-plan" ? "plan" : "ask",
      ),
    });
  } catch (error) {
    await transport.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    transport,
    async requests() {
      return (await readFile(records, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    async response() {
      const entries = (await readFile(records, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return entries.find((entry) => entry.id === "plan");
    },
    async close() {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")("Grok ACP plan mode", () => {
  it("sets native session/set_mode to plan without a YOLO notification", async () => {
    const f = await fixture("set-mode");
    try {
      await f.transport.setSessionMode("plan");
      const requests = await f.requests();
      expect(requests.filter((r) => r.method === "session/set_mode").map((r) => r.params)).toEqual([
        { sessionId: "fixture", modeId: "plan" },
      ]);
      expect(requests.some((r) => r.method === "_x.ai/yolo_mode_changed")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("writes approved/cancelled/abandoned outcomes back over ACP", async () => {
    const f = await fixture("answer");
    const onPlanApproval = vi.fn(async (): Promise<GrokPlanApprovalResponse> => ({
      outcome: "approved",
    }));
    try {
      await f.transport.runTurn(
        "ask",
        () => undefined,
        async () => ({ outcome: { outcome: "cancelled" } }),
        async () => ({ outcome: "cancel" as const }),
        async () => ({ outcome: "cancelled" }),
        onPlanApproval,
      );
      expect(onPlanApproval).toHaveBeenCalledWith({
        sessionId: "fixture",
        toolCallId: "exit-1",
        planContent: "# Plan",
      });
      expect(await f.response()).toMatchObject({
        result: { outcome: "approved" },
      });
    } finally {
      await f.close();
    }
  });

  it("forwards an empty plan body and still waits for approval", async () => {
    const f = await fixture("empty");
    const onPlanApproval = vi.fn(async (): Promise<GrokPlanApprovalResponse> => ({
      outcome: "approved",
    }));
    try {
      await f.transport.runTurn(
        "ask",
        () => undefined,
        async () => ({ outcome: { outcome: "cancelled" } }),
        async () => ({ outcome: "cancel" as const }),
        async () => ({ outcome: "cancelled" }),
        onPlanApproval,
      );
      expect(onPlanApproval).toHaveBeenCalledWith({
        sessionId: "fixture",
        toolCallId: "exit-1",
        planContent: null,
      });
      expect(await f.response()).toMatchObject({
        result: { outcome: "approved" },
      });
    } finally {
      await f.close();
    }
  });

  it("rejects session/set_mode failures", async () => {
    const f = await fixture("set-mode-fail");
    try {
      await expect(f.transport.setSessionMode("plan")).rejects.toThrow(/method not found/i);
    } finally {
      await f.close();
    }
  });

  it("opens a Plan create Session with Ask flags rather than a YOLO plan policy", async () => {
    const f = await fixture("open-plan");
    try {
      const created = (await f.requests()).find((entry) => entry.method === "session/new");
      expect(created?.params?._meta).toMatchObject({ yoloMode: false, autoMode: false });
    } finally {
      await f.close();
    }
  });

  it("accepts the unprefixed native exit_plan_mode method name", async () => {
    const f = await fixture("unprefixed");
    const onPlanApproval = vi.fn(async (): Promise<GrokPlanApprovalResponse> => ({
      outcome: "cancelled",
      feedback: "add tests",
    }));
    try {
      await f.transport.runTurn(
        "ask",
        () => undefined,
        async () => ({ outcome: { outcome: "cancelled" } }),
        async () => ({ outcome: "cancel" as const }),
        async () => ({ outcome: "cancelled" }),
        onPlanApproval,
      );
      expect(onPlanApproval).toHaveBeenCalled();
      expect(await f.response()).toMatchObject({
        result: { outcome: "cancelled", feedback: "add tests" },
      });
    } finally {
      await f.close();
    }
  });

  it.each(["foreign", "malformed", "unknown", "idle"] as const)(
    "rejects or cancels %s plan approval without a UI callback",
    async (scenario) => {
      const f = await fixture(scenario);
      const onPlanApproval = vi.fn(async (): Promise<GrokPlanApprovalResponse> => ({
        outcome: "approved",
      }));
      try {
        if (scenario !== "idle")
          await f.transport.runTurn(
            "ask",
            () => undefined,
            async () => ({ outcome: { outcome: "cancelled" } }),
            async () => ({ outcome: "cancel" as const }),
            async () => ({ outcome: "cancelled" }),
            onPlanApproval,
          );
        await expect.poll(() => f.response()).toBeDefined();
        const response = await f.response();
        if (scenario === "malformed" || scenario === "unknown")
          expect(response).toMatchObject({
            error: { code: scenario === "malformed" ? -32602 : -32601 },
          });
        else expect(response).toMatchObject({ result: { outcome: "cancelled" } });
        expect(onPlanApproval).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
});
