import { describe, expect, it } from "vitest";

import { localizeRemoteFailure } from "../../src/settings/remote-failure-messages.js";

const zh = (chinese: string): string => chinese;

describe("remote failure messages", () => {
  it("recognises a failure followed by a detail or recorded with its error class", () => {
    expect(
      localizeRemoteFailure(
        "The requested release is unavailable or npm cannot reach the registry: remote update command failed (exit status: 1)",
        zh,
      ),
    ).toBe("目标版本不存在，或远程电脑无法访问 npm 仓库");
    expect(localizeRemoteFailure("Error: Remote updater is unavailable", zh)).toBe(
      "远程更新程序不可用",
    );
    expect(localizeRemoteFailure("Remote stop failed: timed out", zh)).toBe(
      "更新已安装，但停止旧服务失败",
    );
  });

  it("leaves SSH and Codex output it does not know unchanged", () => {
    const native = "ssh: connect to host 100.110.60.56 port 22: Operation timed out";
    expect(localizeRemoteFailure(native, zh)).toBe(native);
    expect(localizeRemoteFailure("远程服务已修复，正在连接", zh)).toBe("远程服务已修复，正在连接");
  });

  it("replaces the Desktop POSIX Windows SSH probe dump with Console copy", () => {
    const dump =
      "OpenSSH_9.9p2 Authenticated to 100.103.147.52 using publickey. /usr/bin/bash: -c: line 2: syntax error: unexpected end of file from `if' command on line 1 '[' is not recognized";
    expect(localizeRemoteFailure(dump, zh)).toContain("无法完成到原生 Windows 电脑的 SSH");
    expect(
      localizeRemoteFailure("AppServerSshSetupError: operation=codex_path_probe", (_cn, en) => en),
    ).toContain("does not make this card Connected");
  });
});
