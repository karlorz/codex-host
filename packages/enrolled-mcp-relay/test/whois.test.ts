import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTailscaleWhois } from "../src/whois.js";

describe("Tailscale WhoIs localapi", () => {
  it("sends Host local-tailscaled.sock and reads StableID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codexhost-whois-"));
    const socketPath = join(dir, "tailscaled.sock");
    let host: string | undefined;
    const server = http.createServer((request, response) => {
      host = request.headers.host;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ Node: { StableID: "nbXrpeDAZd11CNTRL", ID: 4681277357771578 } }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const whois = createTailscaleWhois(socketPath);
      await expect(whois("100.94.152.93:4401")).resolves.toBe("nbXrpeDAZd11CNTRL");
      expect(host).toBe("local-tailscaled.sock");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
