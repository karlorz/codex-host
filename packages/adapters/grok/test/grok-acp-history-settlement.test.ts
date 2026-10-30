import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import type { GrokTransportEvent } from "../src/acp-transport.js";
import { GrokAcpTransport } from "../src/acp-transport.js";

describe.skipIf(process.platform === "win32")("Grok native persistence ordering", () => {
  it("waits for the matching persisted terminal before admitting the next command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-history-"));
    const command = path.join(root, "fixture.mjs");
    await writeFile(
      command,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
const directory = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(${JSON.stringify(root)}), 'fixture');
mkdirSync(directory, { recursive: true });
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
let ordinal = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: 'fixture' } });
  else if (request.method === 'session/prompt') {
    const promptId = 'prompt-' + ++ordinal;
    send({ id: request.id, result: { stopReason: 'end_turn', _meta: { promptId, totalTokens: 0 } } });
    setTimeout(() => {
      const records = [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/goal status' }, _meta: { host_turn: true } },
        { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' },
      ];
      appendFileSync(path.join(directory, 'updates.jsonl'), records.map(update => JSON.stringify({ params: { sessionId: 'fixture', update } })).join('\\n') + '\\n');
    }, 100);
  }
});
`,
      { mode: 0o755 },
    );
    const transport = new GrokAcpTransport({
      cwd: root,
      command,
      environment: { HOME: root, GROK_HOME: root },
      closeTimeoutMs: 100,
    });
    try {
      await transport.open({
        kind: "create",
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      });
      for (const ordinal of [1, 2]) {
        await transport.runTurn(
          "/goal status",
          () => undefined,
          async () => ({ outcome: { outcome: "cancelled" } }),
          async () => ({ outcome: "cancel" }),
        );
        const history = await transport.getHistory();
        expect(history.filter((event) => event.type === "turn.completed")).toHaveLength(ordinal);
        expect(history.at(-1)).toMatchObject({
          type: "turn.completed",
          nativeTurnKey: `prompt-${ordinal}`,
        });
        expect(history[0]?.metadata).toMatchObject({ host_turn: true });
      }
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.platform === "win32")(
  "delivers independent goal and worker updates while the goal control response has no history Turn",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-goal-transport-"));
    const command = path.join(root, "fixture.mjs");
    await writeFile(
      command,
      `#!${process.execPath}
import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(r.method==='session/new')send({id:r.id,result:{sessionId:'goal-session'}});
 else if(r.method==='session/prompt'){
  send({method:'_x.ai/session/update',params:{sessionId:'goal-session',update:{sessionUpdate:'goal_updated',goal_id:'g',objective:'native',status:'active',tokens_used:0,elapsed_ms:0}}});
  send({id:r.id,result:{stopReason:'end_turn',_meta:{totalTokens:0}}});
  setTimeout(()=>{
   send({method:'session/update',params:{sessionId:'goal-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'worker result'}}}});
   send({method:'_x.ai/session/update',params:{sessionId:'goal-session',update:{sessionUpdate:'turn_completed',prompt_id:'real-worker',stop_reason:'end_turn'}}});
  },25);
 }
});`,
      { mode: 0o755 },
    );
    const transport = new GrokAcpTransport({
      cwd: root,
      command,
      environment: { HOME: root, GROK_HOME: root },
      closeTimeoutMs: 100,
    });
    try {
      await transport.open({
        kind: "create",
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      });
      const received: GrokTransportEvent[] = [];
      const worker = Promise.withResolvers<undefined>();
      transport.observeBackground({
        onEvent: (event) => {
          received.push(event);
          if (event.type === "turn.completed") worker.resolve(undefined);
        },
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onElicitation: async () => ({ outcome: "cancel" }),
        onQuestion: async () => ({ outcome: "cancelled" }),
      });
      expect(await transport.goalControl("/goal native")).toMatchObject({ stopReason: "end_turn" });
      await worker.promise;
      expect(received.map((e) => e.type)).toEqual(["goal.changed", "agent.text", "turn.completed"]);
      expect(received.at(-1)).toMatchObject({ nativeTurnKey: "real-worker" });
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
