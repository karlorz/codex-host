import { describe, expect, it, vi } from "vitest";
import { remoteSshSetupParamsSchema, type RuntimeStatus } from "@codexhost/shared-contracts";
import {
  createRemoteConnectionsControl,
  remoteUpdateTarget,
} from "../src/remote-connections-control.js";
import { remoteInstallVersion } from "../src/settings/remote-connections-card.js";

const status = (version: string, changes: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  runningVersion: version,
  installedVersion: version,
  restartRequired: false,
  remote: true,
  updateSupported: true,
  update: { phase: "idle", targetVersion: null, error: null },
  ...changes,
});
describe("remote version policy", () => {
  it("permits numeric published release revisions while rejecting development labels", () => {
    expect(remoteInstallVersion(status("0.22.0-2"))).toBe("0.22.0-2");
    expect(remoteInstallVersion(status("0.22.0"))).toBe("0.22.0");
    for (const version of ["0.22.0-dev", "0.22.0-rc.1", "0.22.0-2;echo bad", "0.22.0-"]) {
      expect(remoteInstallVersion(status(version))).toBeNull();
    }
  });
  it("updates older versions but never downgrades a newer remote", () => {
    expect(remoteUpdateTarget(status("0.11.0"), status("0.9.0"))).toBe("0.11.0");
    expect(remoteUpdateTarget(status("0.9.0"), status("0.11.0"))).toBeNull();
  });
  it("restarts changed files at the same version and leaves matching services alone", () => {
    expect(remoteUpdateTarget(status("0.11.0"), status("0.11.0", { restartRequired: true }))).toBe(
      "0.11.0",
    );
    expect(remoteUpdateTarget(status("0.11.0"), status("0.11.0"))).toBeNull();
  });
  it("does not retry failed updates, guess prerelease order, or operate on non-SSH services", () => {
    expect(
      remoteUpdateTarget(
        status("0.12.0"),
        status("0.11.0", {
          update: { phase: "failed", targetVersion: "0.12.0", error: "Unpublished" },
        }),
      ),
    ).toBeNull();
    expect(remoteUpdateTarget(status("0.12.0-dev"), status("0.11.0"))).toBeNull();
    expect(remoteUpdateTarget(null, status("0.11.0"))).toBeNull();
    expect(remoteUpdateTarget(status("0.12.0"), status("0.11.0", { remote: false }))).toBeNull();
  });
});

it("never starts installation or updates in the background", () => {
  const getClient = vi.fn();
  const ownerWindow = { setInterval: vi.fn(), setTimeout: vi.fn() } as unknown as Window;
  createRemoteConnectionsControl(ownerWindow, getClient);
  expect(getClient).not.toHaveBeenCalled();
  expect(ownerWindow.setInterval).not.toHaveBeenCalled();
  expect(ownerWindow.setTimeout).not.toHaveBeenCalled();
});

it.each([false, true])(
  "uninstalls through the local SSH helper with explicit package removal: %s",
  async (uninstallPackage) => {
    const setupSsh = vi.fn(async (input) => {
      expect(remoteSshSetupParamsSchema.parse(input)).toEqual(input);
      return { state: "not-installed" as const };
    });
    const getClient = vi.fn(() => ({ setupSsh }));
    const control = createRemoteConnectionsControl({} as Window, getClient);
    await expect(
      control.setup(
        {
          hostId: "office",
          displayName: "Office",
          source: "codex-managed",
          sshHost: "user@office",
          sshAlias: null,
          sshPort: 22,
          identity: null,
          autoConnect: false,
        },
        "uninstall",
        undefined,
        uninstallPackage,
      ),
    ).resolves.toEqual({ state: "not-installed" });
    expect(getClient).toHaveBeenCalledWith("local");
    expect(setupSsh).toHaveBeenCalledWith({
      hostname: "user@office",
      port: 22,
      identity: null,
      action: "uninstall",
      version: null,
      uninstallPackage,
    });
  },
);
