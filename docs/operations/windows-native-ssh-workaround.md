# Native Windows SSH: dedicated-key workaround and verified connection

Codex Desktop 26.1106.51428 connected from macOS to native Windows `msi-1` on 2026-11-26, using native `codex-cli 0.172.0`. The successful path uses a native Windows app-server daemon started without elevation and a dedicated SSH key whose forced command passes Desktop's POSIX payload to Git for Windows Bash. Windows OpenSSH retains its default cmd.exe shell for other keys and tools.

This is an operator-configured workaround. The codexhost Windows remote installer does not configure it. The verified connection reaches the stock native Codex daemon; it does not prove that external Harnesses are routed through codexhost's separate named-pipe listener.

## Requirements and ownership

- Git for Windows at `C:\Program Files\Git\bin\bash.exe` and native Windows Codex CLI. Version 0.172.0 was tested.
- A non-elevated Windows process that can start the managed daemon. Administrator SSH sessions cannot start it, including when it is already running.
- A separate SSH key used only for this connection, authorized with a forced command. Keep the original SSH key for cmd.exe, PowerShell, screenshots, file transfers and other tools.
- Permission to maintain the Windows account's authorized keys. OpenSSH's existing configuration determines the file: `msi-1` uses `%ProgramData%\ssh\administrators_authorized_keys` because the account is an administrator.

Neither the wrapper nor the daemon changes SSH authentication, the OpenSSH service, `HKLM\SOFTWARE\OpenSSH\DefaultShell`, system PATH, the existing Codex Desktop processes, or other connections. The wrapper executes authenticated commands with the SSH account's existing token; it does not lower that token's integrity level.

## Start the native daemon without elevation

Run in a non-elevated Windows terminal:

```powershell
codex app-server daemon start
codex app-server daemon version
```

The successful result includes `status: "started"` followed by `status: "running"`, `appServerVersion: "0.172.0"`, and the socket `%USERPROFILE%\.codex\app-server-control\app-server-control.sock`. This is Windows AF_UNIX, not a named pipe.

The limited diagnostic task returned these fields from the real commands:

```json
{"status":"started","backend":"pid","pid":14912,"managedCodexVersion":"0.172.0","cliVersion":"0.172.0","appServerVersion":"0.172.0"}
{"status":"running","backend":"pid","managedCodexVersion":"0.172.0","cliVersion":"0.172.0","appServerVersion":"0.172.0"}
```

For the live diagnostic, an elevated SSH session created a temporary scheduled task using the current account, `LogonType Interactive`, and `RunLevel Limited`. That task ran these commands in the logged-in user's medium-integrity session. The task was removed after completion; the daemon and its native updater remain running. No logon task or reboot startup was installed.

An elevated `codex app-server daemon start` still returns:

```text
Error: start the Windows daemon from a non-elevated terminal;
shared clients must not inherit administrator privileges
```

After a reboot or daemon stop, start it again without elevation before connecting. Automatic cold startup from the elevated SSH session is not established by this workaround. Do not stop a daemon that has active work just to test this limitation.

Inspect the control directory when startup reports an ACL error:

```powershell
Get-Acl "$env:USERPROFILE\.codex\app-server-control" |
  Format-List Owner,AreAccessRulesProtected,AccessToString
```

The daemon created a protected, current-user-only FullControl ACL on `msi-1`; no manual ACL change was necessary. If a pre-existing directory fails validation, preserve its security descriptor before a targeted repair. Do not relax the daemon's ownership checks.

## Restrict the shell change to a dedicated key

1. Generate a new SSH key on the client and keep the private key there. The diagnostic used `~/.ssh/id_ed25519_msi-1_codex_native`.
2. Copy [`force-command.ps1`](../../tools/windows-ssh/force-command.ps1) to `%USERPROFILE%\.codexhost\native-ssh\force-command.ps1` on Windows. Protect the script and its parent directory from modification by other users, and preserve the authorized-keys file's existing owner and permissions.
3. Back up the active authorized-keys file, then append the new public key with this option. Substitute the account path and public key; retain every existing key line:

   ```text
   command="powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:/Users/REMOTE_USER/.codexhost/native-ssh/force-command.ps1" ssh-ed25519 PUBLIC_KEY codex-native
   ```

4. Test the new key against the explicit `user@address` target:

   ```sh
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519_msi-1_codex_native user@address \
     'printf "POSIX_OK\n"; printf "shell=%s\n" "$SHELL"; command -v codex; codex --version; codex app-server daemon version'
   ```

5. In **Other computers (SSH)**, set the Windows connection's SSH address to that explicit `user@address`, select the dedicated private key, and connect. Keep its existing name and host ID. A separate SSH alias is also possible if it selects only the dedicated key; that alias variant was not tested.

The script reads `SSH_ORIGINAL_COMMAND`, passes it as one correctly quoted Windows argument to Bash `-c`, sets `SHELL=/bin/bash` for that process, inherits the SSH standard handles, waits, and returns Bash's exit status. It rejects an empty command. It does not parse, synthesize or claim app-server success, and it does not redirect the remote stream through PowerShell text pipelines.

The explicit address matters on the tested client. `ssh -i <new-key> msi-1 ...` still authenticated with the old agent-loaded key selected by the existing `Host msi-1` configuration. Desktop consequently kept hitting cmd.exe. Using `user@address` avoided that alias's extra identity, and the forced-command key was actually selected. Do not assume that adding `-i` alone forces the server to authenticate that key.

The dedicated key supplies POSIX command execution, not an interactive shell or SFTP compatibility contract. Other tools should retain the original key. An original-key check after connection returned `CMD_DEFAULT_STILL_OK` from `echo ... & codex app-server daemon version`, while `DefaultShell` remained absent from the registry.

## Live acceptance evidence

At `2026-11-26T09:26:40.971Z`, the existing authenticated Desktop Controller channel returned the following from the unchanged native connection API:

```json
{"result":{"state":"connected","error":null}}
```

Its existing host enumeration also returned both connections online:

```json
[
  {"displayName":"box","state":"connected","online":true},
  {"displayName":"msi-1","state":"connected","online":true}
]
```

Desktop's own log, `codex-desktop-9e87b248-a111-47a6-bb6f-c6ac3b36900f-34317-t0-i1-000001-4.log`, records:

| Line | UTC time | Native observation |
| --- | --- | --- |
| 13720 | 09:26:00.623 | `codex_path_probe`, `code=0` |
| 13749 | 09:26:02.703 | `codex_version_probe`, `code=0`, stdout `codex-cli 0.172.0` |
| 13772 | 09:26:04.901 | `app_server_bootstrap`, `code=0` |
| 13810 | 09:26:08.826 | app-server compression negotiation completes |
| 13815 | 09:26:08.891 | reported app-server version `0.172.0` |
| 13818 | 09:26:08.956 | `initialized=true`, `targetReadyState=1`, `next=connected`, no connection error |
| 13821 | 09:26:08.979 | native primary Renderer receives `state=connected` |

Windows process inspection independently showed the managed native executable running `app-server --listen unix:// --analytics-default-enabled --managed-daemon`, its `pid-update-loop`, and the npm native executable running `app-server proxy`. The temporary task's token had SID `S-1-16-8192` (Medium Mandatory Level); ordinary SSH had `S-1-16-12288` (High Mandatory Level). `afunix` was running. These observations establish an actual native connection rather than a projected Connected state.

Focused live checks against the installed wrapper also passed POSIX quotes, shell metacharacters, backslashes and Unicode; an exact eight-byte binary stdin/stdout round trip containing NUL, CRLF and `0xff`; and propagation of remote exit status 23. The repository script is byte-identical to the installed wrapper. No build, local application installation, or full repository test suite was needed for this operator script and documentation change.

No Mac Desktop process was stopped. The `box` / `cursor-box` connection remained connected. No native session or credential store was removed.

## Failed experiments and remaining limits

| Experiment or candidate | Result and implication |
| --- | --- |
| Original cmd.exe SSH path | Authentication succeeded, then POSIX `sh -c` / `[` parsing failed. Console copy does not repair this. |
| Elevated daemon start | Rejected even with a running daemon. Use a non-elevated start. |
| Daemon version before startup | Failed to connect with Windows error 10050; `afunix` was running and no control directory existed. It succeeded after non-elevated startup; this was not evidence that Windows AF_UNIX is unsupported. |
| Dedicated key with the original `msi-1` alias | The old authorized key won authentication, so the forced command did not run. An explicit address plus the dedicated key worked. |
| Per-connection `RemoteCommand` | OpenSSH returned `Cannot execute command-line and remote command.` Desktop already supplies its own command, so this option cannot wrap it. |
| A `sh.cmd` shim on PATH | Not installed. cmd.exe parses the POSIX single-quoted command's metacharacters before a shim could receive them; the original log already demonstrates both Bash and cmd.exe parsing fragments of the same probe. A key-level forced command preserves the original payload in `SSH_ORIGINAL_COMMAND`. |
| `sshd Match User ForceCommand` | Not installed. It would also affect existing tools using the same account. The authorized-key option is narrower. |
| Git Bash auxiliary proxy | Desktop logged `pkill: command not found`, an auxiliary `desktop_mcp_unavailable: socket hang up`, and one proxy failure because `/proc/net/tcp` was absent. It then completed initialization through the stock app-server proxy. Connected does not establish full Desktop MCP or every remote tool capability. |
| codexhost named-pipe service | Left unchanged. The verified stock-daemon connection does not establish selection of `%USERPROFILE%\.codexhost\remote\bin\codex.exe` or external Harness routing. No named-pipe/AF_UNIX bridge was needed for the Connected result. |

The in-repository SSH Adapter calls native `remoteConnections.setAutoConnect` and `getState` directly in [`codex-ssh-adapter.ts:116`](../../packages/renderer-extension/src/codex-ssh-adapter.ts#L116) and preserves its reported state at line 279. Its saved configuration at line 177 and [`remote-connections.ts:20`](../../packages/shared-contracts/src/remote-connections.ts#L20) expose hostname, port and identity, with no remote-command, Codex executable, or socket URL option. The Desktop Controller forwards those fixed operations in [`remote-connections-control.ts:15`](../../packages/desktop-control/src/remote-connections-control.ts#L15); it does not own Desktop's bootstrap. No production interception or fake connection state was introduced.

## Upstream evidence

- [openai/codex PR #42381](https://github.com/openai/codex/pull/42381), merged 2026-09-02: detached Windows daemon lifecycle, process identity checks and private state directories.
- [openai/codex PR #42405](https://github.com/openai/codex/pull/42405), merged 2026-09-03: Windows AF_UNIX daemon discovery, non-elevated startup and socket security. Its [daemon README at the merge commit](https://github.com/openai/codex/blob/b7f710273e14ef2d79d510a06385c2a67285585a/codex-rs/app-server-daemon/README.md) describes the platform and lifecycle constraints.
- [openai/codex issue #56794](https://github.com/openai/codex/issues/56794): a reported native Windows connection after a global Git Bash override and current-user-only socket ACL repair. The dedicated-key wrapper avoids that report's machine-wide shell override; CLI 0.172.0 created the correct ACL on this host.
- [openai/codex issue #26164](https://github.com/openai/codex/issues/26164): the independent POSIX bootstrap failure after successful Windows SSH authentication.

## Rollback

Change only the `msi-1` card back to its prior SSH address and original identity if the workaround is no longer wanted. Remove only the public-key line carrying the dedicated key, then the wrapper and dedicated client key after confirming that no connection uses them. The diagnostic preserved the original authorized-keys file under `%USERPROFILE%\.codexhost\native-ssh\administrators_authorized_keys.before`; do not restore it wholesale over later key changes. The prior connection draft was saved locally in `/tmp/codex-native-ssh/previous-connection.json` for the attended session.

The stock daemon is independent of the forced-command key. Stop it through its native lifecycle command only when interruption of its work is intended. No global shell or sshd configuration needs reverting.
