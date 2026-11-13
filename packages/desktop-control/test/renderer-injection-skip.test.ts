import { describe, expect, it } from "vitest";

import { rendererInjectionSkipReason } from "../src/renderer-injection-skip.js";

describe("rendererInjectionSkipReason", () => {
  it("skips unaudited 26.1106 and 26.1103 product versions", () => {
    expect(rendererInjectionSkipReason("26.1106.51428")).toContain("26.1106.51428");
    expect(rendererInjectionSkipReason(" 26.1103.41825 ")).toContain("26.1103.41825");
  });

  it("keeps 26.1027 Renderer injection", () => {
    expect(rendererInjectionSkipReason("26.1027.51404")).toBeNull();
    expect(rendererInjectionSkipReason("26.1027.61615")).toBeNull();
    expect(rendererInjectionSkipReason(undefined)).toBeNull();
    expect(rendererInjectionSkipReason("")).toBeNull();
  });
});
