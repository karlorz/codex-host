import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import {
  RELAY_LINK_PROTOCOL_VERSION,
  relayLinkHelloSchema,
  relayLinkReplySchema,
  type RelayLinkReply,
  type RelayLinkRequest,
} from "@codexhost/shared-contracts";

import { attachJsonl, writeJsonl } from "./jsonl.js";
import { bindListeningPort } from "./listen.js";
import { hashesEqual, sha256Hex } from "./secret.js";
import type { WhoisFn } from "./whois.js";

export interface LinkListener {
  readonly port: number;
  session(): ActiveLink | undefined;
  close(): Promise<void>;
}

export interface ActiveLink {
  send(
    request: Omit<RelayLinkRequest, "requestId"> & { requestId?: string },
  ): Promise<RelayLinkReply>;
}

export async function listenEnrolledLink(input: {
  listen: string;
  port: number;
  expectedNodeId: string;
  linkSecretHash: string;
  whois: WhoisFn;
}): Promise<LinkListener> {
  let active: { socket: Socket; pending: Map<string, (reply: RelayLinkReply) => void> } | undefined;
  const failPending = () => {
    const pending = active?.pending;
    active = undefined;
    if (!pending) return;
    for (const resolve of pending.values()) {
      resolve({
        requestId: "dropped",
        error: { code: "outcome_unknown", message: "Mac link dropped" },
      });
    }
    pending.clear();
  };

  const server: Server = createServer((socket) => {
    const remote = `${socket.remoteAddress ?? ""}:${socket.remotePort ?? 0}`.replace(
      /^::ffff:/u,
      "",
    );
    let authed = false;
    attachJsonl(
      socket,
      (value) => {
        if (!authed) {
          const hello = relayLinkHelloSchema.safeParse(value);
          void (async () => {
            const nodeId = await input.whois(remote).catch(() => undefined);
            const secretOk =
              hello.success && hashesEqual(sha256Hex(hello.data.secret), input.linkSecretHash);
            if (nodeId !== input.expectedNodeId || !secretOk) {
              socket.destroy();
              return;
            }
            if (active) {
              active.socket.destroy();
              failPending();
            }
            authed = true;
            active = { socket, pending: new Map() };
            writeJsonl(socket, { v: RELAY_LINK_PROTOCOL_VERSION, ok: true });
          })();
          return;
        }
        const reply = relayLinkReplySchema.safeParse(value);
        if (!reply.success || !active) {
          socket.destroy();
          return;
        }
        const waiter = active.pending.get(reply.data.requestId);
        if (waiter) {
          active.pending.delete(reply.data.requestId);
          waiter(reply.data);
        }
      },
      () => socket.destroy(),
    );
    socket.on("close", () => {
      if (active?.socket === socket) failPending();
    });
    socket.on("error", () => socket.destroy());
  });

  const port = await bindListeningPort(server, input.port, input.listen);

  return {
    port,
    session: () => {
      if (!active) return undefined;
      const session = active;
      return {
        send: async (request) => {
          const requestId = request.requestId ?? randomUUID();
          const frame: RelayLinkRequest = {
            requestId,
            deadlineMs: request.deadlineMs,
            route: request.route,
            body: request.body,
          };
          return await new Promise<RelayLinkReply>((resolve) => {
            const waitMs = Math.max(1, frame.deadlineMs - Date.now());
            const timer = setTimeout(() => {
              session.pending.delete(requestId);
              resolve({
                requestId,
                error: {
                  code: "outcome_unknown",
                  message: "Link deadline hit before a complete Mac reply",
                },
              });
            }, waitMs);
            session.pending.set(requestId, (reply) => {
              clearTimeout(timer);
              resolve(reply);
            });
            try {
              writeJsonl(session.socket, frame);
            } catch {
              clearTimeout(timer);
              session.pending.delete(requestId);
              resolve({
                requestId,
                error: { code: "outcome_unknown", message: "Mac link dropped" },
              });
            }
          });
        },
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        active?.socket.destroy();
        failPending();
        server.close(() => resolve());
      }),
  };
}
