import { describe, expect, it } from "vitest";

import { rendererInjectionSkipReason } from "../src/renderer-injection-skip.js";

describe("rendererInjectionSkipReason", () => {
  it.each(["win32", "linux"] as const)("keeps the 26.1106 skip on %s", (platform) => {
    expect(rendererInjectionSkipReason("26.1106.51428", platform)).toContain("26.1106.51428");
  });

  it("allows Renderer installation on macOS 26.1106.51428", () => {
    expect(rendererInjectionSkipReason("26.1106.51428", "darwin")).toBeNull();
    expect(rendererInjectionSkipReason(" 26.1106.51428 ", "darwin")).toBeNull();
  });

  it.each(["darwin", "win32", "linux"] as const)("keeps other skipped builds on %s", (platform) => {
    expect(rendererInjectionSkipReason(" 26.1103.41825 ", platform)).toContain("26.1103.41825");
    expect(rendererInjectionSkipReason("26.1106.99999", platform)).toContain("26.1106.99999");
  });

  it("uses the Controller process platform by default", () => {
    expect(rendererInjectionSkipReason("26.1106.51428")).toBe(
      rendererInjectionSkipReason("26.1106.51428", process.platform),
    );
  });

  it("keeps 26.1027 Renderer injection", () => {
    expect(rendererInjectionSkipReason("26.1027.51404")).toBeNull();
    expect(rendererInjectionSkipReason("26.1027.61615")).toBeNull();
    expect(rendererInjectionSkipReason(undefined)).toBeNull();
    expect(rendererInjectionSkipReason("")).toBeNull();
  });
});
