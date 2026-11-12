import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ENROLLMENT_LIST_METHOD } from "@codexhost/shared-contracts";
import { runSharedHostService } from "../src/shared-host-service.js";
import { connectLocalSharedHost } from "../src/local-shared-host.js";
import { EnrollmentAuthority } from "../src/client-enrollment-authority.js";
import { createStubEnrollmentConsent } from "../src/client-enrollment-consent.js";
import { ModelPriceCatalog } from "../src/model-prices.js";

vi.mock("../src/delegation-skill.js", () => ({ installDelegationSkills: async () => [] }));

afterEach(() => {
  vi.restoreAllMocks();
});

it("lists persisted enrollments on Console before and after a Desktop session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-shared-enrollment-"));
  vi.spyOn(ModelPriceCatalog.prototype, "start").mockResolvedValue();
  const seed = new EnrollmentAuthority({
    hostToken: "seed-host-token",
    dataDirectory: root,
    consent: createStubEnrollmentConsent("approve"),
    createId: () => "enroll-muse",
    createToken: () => "listed-token-muse",
    createThread: async () => "thread-muse",
    now: () => Date.parse("2026-11-07T00:00:00.000Z"),
  });
  await seed.publishBootstrap("http://127.0.0.1:9");
  await seed.enroll({
    clientId: "muse",
    executablePath: "/synthetic/muse",
    pairing: "machine",
    attendedHostApprove: true,
  });
  await seed.close();

  const runtime = path.join(root, "app", "host-runtime.mjs");
  const environment = {
    CODEXHOST_DATA_DIR: root,
    CODEX_HOME: path.join(root, "codex-home"),
    CODEXHOST_HOST_RUNTIME_PATH: runtime,
    CODEXHOST_LAUNCHER_PID: String(process.ppid),
  };
  const ready = path.join(root, "ready");
  const running = runSharedHostService(
    ["--data", root, "--ready-file", ready],
    environment,
    import.meta.url,
  );
  void running.catch(() => undefined);
  let desktop: Awaited<ReturnType<typeof connectLocalSharedHost>> | undefined;
  try {
    await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready\n"));
    const consoleDescriptor = JSON.parse(
      await readFile(path.join(root, "console", "hosts", `host-${process.pid}.json`), "utf8"),
    ) as { port: number; token: string };
    const listed = {
      result: {
        enrollments: [
          {
            enrollmentId: "enroll-muse",
            clientId: "muse",
            pairing: "machine",
            executablePath: "/synthetic/muse",
          },
        ],
      },
    };
    const listFromConsole = async () => {
      const response = await fetch(`http://127.0.0.1:${consoleDescriptor.port}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${consoleDescriptor.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: ENROLLMENT_LIST_METHOD, params: {} }),
      });
      return response.json();
    };
    const beforeDesktop = await listFromConsole();
    expect(beforeDesktop).toMatchObject(listed);
    expect(JSON.stringify(beforeDesktop)).not.toContain("listed-token-muse");

    desktop = await connectLocalSharedHost({
      launcher: path.join(root, "launcher"),
      runtime,
      dataDirectory: root,
    });
    const afterDesktop = await listFromConsole();
    expect(afterDesktop).toMatchObject(listed);
    expect(JSON.stringify(afterDesktop)).not.toContain("listed-token-muse");
    await expect(desktop.request(ENROLLMENT_LIST_METHOD, {})).resolves.toMatchObject(listed);
  } finally {
    desktop?.close();
    await runSharedHostService(["--data", root, "--stop"], {}, import.meta.url);
    await running;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
