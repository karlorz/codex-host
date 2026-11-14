import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DelegationControlError } from "../src/delegation-types.js";
import { withExternalClientAccess } from "../src/external-client-access.js";
import { ExternalClientRegistry } from "../src/external-clients.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("external client access enforcement", () => {
  it("allows all-threads clients everywhere and restricts selected workspaces", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ext-access-"));
    cleanup.push(directory);
    const allowed = await mkdtemp(path.join(os.tmpdir(), "ext-allowed-"));
    cleanup.push(allowed);
    const other = await mkdtemp(path.join(os.tmpdir(), "ext-other-"));
    cleanup.push(other);
    const clients = new ExternalClientRegistry(path.join(directory, "clients.json"));
    await clients.create("open-bot", {
      access: "all-threads",
      connectionMode: "public-relay",
      dispatchGrant: "full-dispatch",
    });
    await clients.create("limited-bot", {
      access: "selected-workspaces",
      workspaces: [allowed],
      connectionMode: "public-relay",
      dispatchGrant: "full-dispatch",
    });
    const calls: Array<{ client: string; route: string; cwd?: unknown }> = [];
    const route = withExternalClientAccess(
      async (call, dispatched, body) => {
        calls.push({ client: call.client, route: dispatched, cwd: body.cwd });
        if (dispatched === "/v1/thread/list") {
          return {
            threads: [
              { threadId: "in", cwd: allowed },
              { threadId: "out", cwd: other },
            ],
          };
        }
        if (dispatched === "/v1/thread/watches") {
          return { watches: [{ threadId: "in" }, { threadId: "out" }] };
        }
        if (dispatched === "/v1/events/poll") {
          return { events: [{ threadId: "in" }, { threadId: "out" }] };
        }
        return { ok: true };
      },
      {
        clients,
        workspaceOf: async (threadId) => (threadId === "in" ? allowed : other),
      },
    );
    const dummy = { request: undefined as never, response: undefined as never };
    await expect(
      route({ ...dummy, client: "open-bot" }, "/v1/delegate/start", {
        harnessId: "codex",
        task: "x",
        cwd: other,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/delegate/start", {
        harnessId: "codex",
        task: "x",
        cwd: other,
      }),
    ).rejects.toBeInstanceOf(DelegationControlError);
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/delegate/start", {
        harnessId: "codex",
        task: "x",
        cwd: allowed,
      }),
    ).resolves.toEqual({ ok: true });
    const listed = await route({ ...dummy, client: "limited-bot" }, "/v1/thread/list", {});
    expect(listed).toEqual({ threads: [{ threadId: "in", cwd: allowed }] });
    expect(calls.map((call) => call.client)).toContain("limited-bot");
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/delegate/start", {
        harnessId: "codex",
        task: "x",
        cwd: allowed,
        parentThreadId: "out",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/thread/read", { threadId: "out" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/thread/wait", { threadId: "out" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/thread/send", {
        threadId: "out",
        message: "x",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/thread/cancel", { threadId: "out" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/thread/watch", { threadId: "out" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/delegate/start", {
        harnessId: "codex",
        task: "x",
        cwd: path.join(os.tmpdir(), "missing-ext-ws-root"),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    const watches = await route({ ...dummy, client: "limited-bot" }, "/v1/thread/watches", {});
    expect(watches).toEqual({ watches: [{ threadId: "in" }] });
    const events = await route({ ...dummy, client: "limited-bot" }, "/v1/events/poll", {});
    expect(events).toEqual({ events: [{ threadId: "in" }] });
  });

  it("denies a later wait after the client is revoked and does not cancel the Thread", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ext-access-revoke-"));
    cleanup.push(directory);
    const allowed = await mkdtemp(path.join(os.tmpdir(), "ext-allowed-"));
    cleanup.push(allowed);
    const clients = new ExternalClientRegistry(path.join(directory, "clients.json"));
    await clients.create("limited-bot", {
      access: "selected-workspaces",
      workspaces: [allowed],
      connectionMode: "public-relay",
      dispatchGrant: "full-dispatch",
    });
    let cancelled = false;
    const route = withExternalClientAccess(
      async (call, dispatched) => {
        if (dispatched === "/v1/thread/wait") {
          await clients.remove(call.client);
          return { threadId: "in", cwd: allowed };
        }
        if (dispatched === "/v1/thread/cancel") cancelled = true;
        return { ok: true };
      },
      {
        clients,
        workspaceOf: async () => allowed,
      },
    );
    const dummy = { request: undefined as never, response: undefined as never };
    await expect(
      route({ ...dummy, client: "limited-bot" }, "/v1/thread/wait", { threadId: "in" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_TARGET" });
    expect(cancelled).toBe(false);
    await expect(clients.has("limited-bot")).resolves.toBe(false);
  });
});
