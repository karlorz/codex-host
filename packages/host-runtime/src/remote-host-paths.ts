import { createHash } from "node:crypto";
import path from "node:path";

export function remoteHostSocketPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  name = "app-server-control",
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const home =
    platform === "win32" ? (environment.USERPROFILE ?? environment.HOME) : environment.HOME;
  const codexHome = environment.CODEX_HOME ?? (home ? paths.join(home, ".codex") : undefined);
  if (!codexHome) throw new Error("CODEX_HOME or HOME is required for remote Host lifecycle");
  if (platform === "win32") {
    const identity = createHash("sha256")
      .update(paths.resolve(codexHome).toLowerCase())
      .digest("hex")
      .slice(0, 24);
    return `\\\\.\\pipe\\codexhost-ssh-${name}-${identity}`;
  }
  return paths.join(codexHome, "app-server-control", `${name}.sock`);
}
