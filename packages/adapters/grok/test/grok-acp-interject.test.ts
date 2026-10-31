import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GrokAcpTransport } from "../src/acp-transport.js";
import { GROK_INTERJECT_METHOD } from "../src/grok-interject.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-interject-"));
  const command = path.join(root, "grok.mjs");
  const records = path.join(root, "requests.jsonl");
  await writeFile(
    command,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let promptId;
createInterface({input:process.stdin}).on('line', line => {
  const req = JSON.parse(line);
  appendFileSync(process.env.GROK_INTERJECT_RECORDS, line+'\\n');
  const reply = (result) => send({id:req.id,result});
  if (req.method === 'initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
  else if (req.method === 'session/new') reply({sessionId:'fixture'});
  else if (req.method === 'session/prompt') promptId = req.id;
  else if (req.method === 'x.ai/interject') reply({status:'queued'});
  else if (req.method === 'session/cancel' && promptId !== undefined) {
    send({id:promptId,result:{stopReason:'cancelled'}});
    promptId = undefined;
  } else if (req.method === 'session/close') reply({});
  else if (req.id !== undefined) send({id:req.id,error:{code:-32601,message:'Method not found'}});
});
`,
    { mode: 0o755 },
  );
  const transport = new GrokAcpTransport({
    command,
    cwd: root,
    environment: { GROK_HOME: root, GROK_INTERJECT_RECORDS: records },
    commandTimeoutMs: 2_000,
    closeTimeoutMs: 50,
    onFault: () => undefined,
  });
  await transport.open({
    kind: "create",
    permissionModeId: harnessPermissionModeIdSchema.parse("always-approve"),
  });
  return {
    transport,
    requests: async () =>
      (await readFile(records, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    close: async () => {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")("Grok ACP interject wire", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("queues x.ai/interject on the in-flight Prompt without cancelling it", async () => {
    const f = await fixture();
    cleanup = f.close;
    const prompt = f.transport.runTurn(
      "run",
      () => undefined,
      async () => ({ outcome: { outcome: "cancelled" } }),
      async () => ({ outcome: "cancel" }),
      async () => ({ outcome: "cancelled" }),
    );
    await vi.waitFor(async () => {
      const requests = await f.requests();
      expect(requests.some((request) => request.method === "session/prompt")).toBe(true);
    });
    await expect(f.transport.interject("skip remaining", "steer-1")).resolves.toEqual({
      status: "queued",
    });
    await f.transport.cancel();
    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
    const requests = await f.requests();
    expect(requests.some((request) => request.method === GROK_INTERJECT_METHOD)).toBe(true);
    expect(
      requests.find((request) => request.method === GROK_INTERJECT_METHOD)?.params,
    ).toMatchObject({
      sessionId: "fixture",
      text: "skip remaining",
      interjectionId: "steer-1",
    });
  });
});
