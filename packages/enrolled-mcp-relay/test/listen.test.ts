import { describe, expect, it } from "vitest";

import { runEnrolledMcpRelayCli } from "../src/cli.js";
import { assertRelayBindAddresses } from "../src/listen.js";
import { startEnrolledMcpRelay } from "../src/relay.js";
import { sha256Hex } from "../src/secret.js";

describe("enrolled MCP relay listen split", () => {
  it("requires MCP on loopback and allows a distinct tailnet link address", () => {
    expect(() => assertRelayBindAddresses("127.0.0.1", "127.0.0.1")).not.toThrow();
    expect(() => assertRelayBindAddresses("127.0.0.1", "100.118.12.90")).not.toThrow();
    expect(() => assertRelayBindAddresses("100.118.12.90", "100.118.12.90")).toThrow(
      /mcp-listen must be 127\.0\.0\.1/,
    );
    expect(() => assertRelayBindAddresses("127.0.0.1", "0.0.0.0")).toThrow(/0\.0\.0\.0/);
  });

  it("rejects a shared non-loopback --listen", async () => {
    await expect(runEnrolledMcpRelayCli(["--listen", "100.118.12.90"])).rejects.toThrow(
      /loopback-only/,
    );
  });

  it("requires OAuth when the link listener is not loopback", async () => {
    await expect(
      startEnrolledMcpRelay({
        expectedNodeId: "nTest",
        linkSecretHash: sha256Hex("secret"),
      }),
    ).rejects.toThrow(/OAuth is required/);
  });
});
