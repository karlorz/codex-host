import type { Socket } from "node:net";

import { RELAY_MAX_BODY_BYTES } from "@codexhost/shared-contracts";

const MAX_BUFFER = RELAY_MAX_BODY_BYTES + 4096;

export function writeJsonl(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

export function attachJsonl(
  socket: Socket,
  onFrame: (value: unknown) => void,
  onOverflow: () => void,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER) {
      onOverflow();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          onOverflow();
          return;
        }
        onFrame(parsed);
      }
      newline = buffer.indexOf("\n");
    }
  });
}
