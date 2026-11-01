import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { GrokAcpTransport, type GrokTransportEvent } from "../src/acp-transport.js";

async function createSdkFixture(scriptContent: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-bg-"));
  const command = path.join(root, "fixture.mjs");
  await writeFile(
    command,
    `#!${process.execPath}
${scriptContent}
`,
    { mode: 0o755 },
  );
  const transport = new GrokAcpTransport({
    cwd: root,
    command,
    environment: { HOME: root, GROK_HOME: root },
    commandTimeoutMs: 2000,
    closeTimeoutMs: 100,
  });
  await transport.open({
    kind: "create",
    permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
  });
  return {
    transport,
    root,
    async close() {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")(
  "Grok ACP background notifications and control",
  () => {
    it("accepts direct notifications matching session and ignores wrong session", async () => {
      const fixture = await createSdkFixture(`
import { createInterface } from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (r.method === 'session/new') {
    send({ id: r.id, result: { sessionId: 'sess-bg' } });
    setTimeout(() => {
      // 1. matching session: task_backgrounded
      send({
        method: 'x.ai/task_backgrounded',
        params: {
          sessionId: 'sess-bg',
          update: {
            sessionUpdate: 'task_backgrounded',
            taskId: 'task-1',
            toolCallId: 'call-1',
            command: 'sleep 5',
            cwd: '/tmp',
            outputFile: '/tmp/task-1.log',
            description: 'background sleeper',
          },
        },
      });

      // 2. wrong session: should be ignored
      send({
        method: 'x.ai/task_backgrounded',
        params: {
          sessionId: 'other-session',
          update: {
            sessionUpdate: 'task_backgrounded',
            taskId: 'task-wrong',
            toolCallId: 'call-wrong',
            command: 'sleep 999',
          },
        },
      });

      // 3. matching session: monitor_event
      send({
        method: 'x.ai/monitor_event',
        params: {
          sessionId: 'sess-bg',
          update: {
            sessionUpdate: 'monitor_event',
            taskId: 'task-mon',
            eventText: 'DONE build finished',
            description: 'build watcher',
          },
        },
      });

      // 4. wrong session: monitor_event (should be ignored)
      send({
        method: 'x.ai/monitor_event',
        params: {
          sessionId: 'wrong-session',
          update: {
            sessionUpdate: 'monitor_event',
            taskId: 'task-mon-wrong',
            eventText: 'FAILED wrong session',
          },
        },
      });

      // 5. matching session: scheduled_task_created
      send({
        method: 'x.ai/scheduled_task_created',
        params: {
          sessionId: 'sess-bg',
          update: {
            sessionUpdate: 'scheduled_task_created',
            taskId: 'sched-1',
            prompt: 'run periodic check',
            humanSchedule: 'every 5m',
            nextFireAt: '2026-11-01T12:00:00Z',
          },
        },
      });

      // 6. matching session: scheduled_task_fired
      send({
        method: 'x.ai/scheduled_task_fired',
        params: {
          sessionId: 'sess-bg',
          update: {
            sessionUpdate: 'scheduled_task_fired',
            taskId: 'sched-1',
            prompt: 'run periodic check',
            humanSchedule: 'every 5m',
            nextFireAt: '2026-11-01T12:05:00Z',
            subagentId: 'sub-1',
          },
        },
      });

      // 7. matching session: scheduled_task_deleted
      send({
        method: 'x.ai/scheduled_task_deleted',
        params: {
          sessionId: 'sess-bg',
          update: {
            sessionUpdate: 'scheduled_task_deleted',
            taskId: 'sched-1',
            reason: 'manual deletion',
          },
        },
      });
    }, 20);
  }
});
`);
      try {
        const received: GrokTransportEvent[] = [];
        const done = Promise.withResolvers<undefined>();
        fixture.transport.observeBackground({
          onEvent: (event) => {
            received.push(event);
            if (event.type === "scheduled.deleted") done.resolve(undefined);
          },
          onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
          onElicitation: async () => ({ outcome: "cancel" }),
          onQuestion: async () => ({ outcome: "cancelled" }),
        });

        await done.promise;

        // Ensure no events from 'other-session' or 'wrong-session' were admitted
        const taskIds = received.map((e) => ("taskId" in e ? e.taskId : undefined));
        expect(taskIds).not.toContain("task-wrong");
        expect(taskIds).not.toContain("task-mon-wrong");

        expect(received).toEqual([
          {
            type: "task.backgrounded",
            taskId: "task-1",
            toolCallId: "call-1",
            command: "sleep 5",
            cwd: "/tmp",
            outputFile: "/tmp/task-1.log",
            kind: "run",
            description: "background sleeper",
          },
          {
            type: "monitor.event",
            taskId: "task-mon",
            text: "DONE build finished",
            description: "build watcher",
          },
          {
            type: "scheduled.created",
            taskId: "sched-1",
            prompt: "run periodic check",
            humanSchedule: "every 5m",
            nextFireAt: "2026-11-01T12:00:00Z",
          },
          {
            type: "scheduled.fired",
            taskId: "sched-1",
            prompt: "run periodic check",
            humanSchedule: "every 5m",
            nextFireAt: "2026-11-01T12:05:00Z",
            subagentId: "sub-1",
          },
          {
            type: "scheduled.deleted",
            taskId: "sched-1",
            reason: "manual deletion",
          },
        ]);
      } finally {
        await fixture.close();
      }
    });

    it("handles task/list and returns tasks snapshot", async () => {
      const fixture = await createSdkFixture(`
import { createInterface } from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (r.method === 'session/new') send({ id: r.id, result: { sessionId: 'sess-list' } });
  else if (r.method === 'x.ai/task/list') send({id:r.id,error:{code:-32601,message:'prefix required'}});
  else if (r.method === '_x.ai/task/list') {
    if (r.params.sessionId === 'sess-list') {
      send({
        id: r.id,
        result: {
          tasks: [
            {
              task_id: 'task-101',
              command: 'sleep 60',
              completed: false,
              is_backgrounded: true,
              description: 'long sleeper',
            },
          ],
        },
      });
    } else {
      send({ id: r.id, error: { code: -32602, message: 'Invalid session' } });
    }
  }
});
`);
      try {
        const list = await fixture.transport.listTasks();
        expect(list).toEqual({
          tasks: [
            {
              task_id: "task-101",
              command: "sleep 60",
              completed: false,
              is_backgrounded: true,
              description: "long sleeper",
            },
          ],
        });
      } finally {
        await fixture.close();
      }
    });

    it("validates task/kill strict outcomes and rejects malformed or missing identity", async () => {
      const fixture = await createSdkFixture(`
import { createInterface } from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (r.method === 'session/new') send({ id: r.id, result: { sessionId: 'sess-kill' } });
  else if (r.method === 'x.ai/task/kill') {
    const { taskId } = r.params;
    if (taskId === 'task-killed') {
      send({ id: r.id, result: { taskId: 'task-killed', outcome: 'killed' } });
    } else if (taskId === 'task-exited') {
      send({ id: r.id, result: { taskId: 'task-exited', outcome: 'already_exited' } });
    } else if (taskId === 'task-notfound') {
      send({ id: r.id, result: { taskId: 'task-notfound', outcome: 'not_found' } });
    } else if (taskId === 'task-wrong-id') {
      // Identity mismatch in response
      send({ id: r.id, result: { taskId: 'different-task', outcome: 'killed' } });
    } else if (taskId === 'task-malformed-outcome') {
      // Unknown outcome variant
      send({ id: r.id, result: { taskId: 'task-malformed-outcome', outcome: 'unknown_variant' } });
    } else if (taskId === 'task-no-record') {
      // Non-record result
      send({ id: r.id, result: 'not-a-record' });
    }
  }
});
`);
      try {
        // Strict valid outcomes
        expect(await fixture.transport.killTask("task-killed")).toBe("killed");
        expect(await fixture.transport.killTask("task-exited")).toBe("already_exited");
        expect(await fixture.transport.killTask("task-notfound", "teardown")).toBe("not_found");

        // Identity mismatch in response -> protocolError
        await expect(fixture.transport.killTask("task-wrong-id")).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "protocolError",
            message: "Malformed Grok task kill response",
          }),
        );

        // Malformed outcome variant -> protocolError
        await expect(fixture.transport.killTask("task-malformed-outcome")).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "protocolError",
            message: "Malformed Grok task kill response",
          }),
        );

        // Missing record -> protocolError
        await expect(fixture.transport.killTask("task-no-record")).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "protocolError",
            message: "Malformed Grok task kill response",
          }),
        );
      } finally {
        await fixture.close();
      }
    });

    it("validates scheduler/delete true/false strict validation and rejects malformed response", async () => {
      const fixture = await createSdkFixture(`
import { createInterface } from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (r.method === 'session/new') send({ id: r.id, result: { sessionId: 'sess-sched' } });
  else if (r.method === 'x.ai/scheduler/delete') {
    const { taskId } = r.params;
    if (taskId === 'sched-true') {
      send({ id: r.id, result: { taskId: 'sched-true', deleted: true } });
    } else if (taskId === 'sched-false') {
      send({ id: r.id, result: { taskId: 'sched-false', deleted: false } });
    } else if (taskId === 'sched-mismatch-id') {
      send({ id: r.id, result: { taskId: 'other-sched', deleted: true } });
    } else if (taskId === 'sched-non-bool') {
      send({ id: r.id, result: { taskId: 'sched-non-bool', deleted: 'yes' } });
    }
  }
});
`);
      try {
        expect(await fixture.transport.deleteScheduledTask("sched-true")).toBe(true);
        expect(await fixture.transport.deleteScheduledTask("sched-false")).toBe(false);

        await expect(fixture.transport.deleteScheduledTask("sched-mismatch-id")).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "protocolError",
            message: "Malformed Grok scheduler delete response",
          }),
        );

        await expect(fixture.transport.deleteScheduledTask("sched-non-bool")).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "protocolError",
            message: "Malformed Grok scheduler delete response",
          }),
        );
      } finally {
        await fixture.close();
      }
    });

    it("maps JSONRPC -32601 to GrokTransportError with unsupported kind", async () => {
      const fixture = await createSdkFixture(`
import { createInterface } from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (r.method === 'session/new') send({ id: r.id, result: { sessionId: 'sess-unsupported' } });
  else if (r.id !== undefined) {
    send({ id: r.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`);
      try {
        await expect(fixture.transport.killTask("task-1")).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "unsupported",
            message: "Grok does not support x.ai/task/kill",
          }),
        );

        await expect(fixture.transport.listTasks()).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "unsupported",
            message: "Grok does not support x.ai/task/list",
          }),
        );

        await expect(fixture.transport.deleteScheduledTask("sched-1")).rejects.toThrow(
          expect.objectContaining({
            name: "GrokTransportError",
            kind: "unsupported",
            message: "Grok does not support x.ai/scheduler/delete",
          }),
        );
      } finally {
        await fixture.close();
      }
    });
  },
);
