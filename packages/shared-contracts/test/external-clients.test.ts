import { describe, expect, it } from "vitest";

import {
  EXTERNAL_MCP_TOOL_NAMES,
  RELAY_MCP_TOOL_NAMES,
  externalClientCreateParamsSchema,
  isProtectedDirectMcpUrl,
  mapExternalMcpToolCall,
} from "../src/index.ts";

describe("shared external MCP contracts", () => {
  it("publishes the eleven-tool catalog separately from the legacy four-tool hop", () => {
    expect([...EXTERNAL_MCP_TOOL_NAMES]).toEqual([
      "harness_list",
      "harness_inspect",
      "delegate_start",
      "thread_read",
      "thread_wait",
      "thread_list",
      "thread_send",
      "thread_cancel",
      "thread_watch",
      "thread_watches",
      "events_poll",
    ]);
    expect([...RELAY_MCP_TOOL_NAMES]).toEqual([
      "enroll_status",
      "thread_read",
      "thread_wait",
      "thread_send",
    ]);
  });

  it("maps shared tool calls onto Host dispatch routes without treating OAuth names as identity", () => {
    expect(
      mapExternalMcpToolCall("delegate_start", { harnessId: "grok", task: "go", cwd: "/w" }),
    ).toEqual({
      route: "/v1/delegate/start",
      body: { harnessId: "grok", task: "go", cwd: "/w" },
    });
    expect(
      mapExternalMcpToolCall("thread_read", { thread: "codex://threads/t1" }).body,
    ).toMatchObject({
      threadId: "t1",
    });
  });

  it("rejects Console create payloads that are only an OAuth app name", () => {
    expect(externalClientCreateParamsSchema.safeParse({ name: "Muse App" }).success).toBe(false);
    expect(externalClientCreateParamsSchema.safeParse({ name: "grok-bot" }).success).toBe(true);
  });

  it("accepts only protected Direct MCP URLs", () => {
    expect(isProtectedDirectMcpUrl("https://mcp.example.com/mcp")).toBe(true);
    expect(isProtectedDirectMcpUrl("http://100.118.12.90/mcp")).toBe(true);
    expect(isProtectedDirectMcpUrl("http://127.0.0.1:4398/mcp")).toBe(false);
    expect(isProtectedDirectMcpUrl("http://192.168.1.8/mcp")).toBe(false);
    expect(isProtectedDirectMcpUrl("https://mcp.example.com/mcp?token=1")).toBe(false);
  });
});
