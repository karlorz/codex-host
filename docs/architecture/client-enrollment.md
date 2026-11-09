# Client enrollment for unmanaged CLIs

`codexhost enroll` lets a local unmanaged client such as Grok Bot on the same Mac use Host Runtime without copying another process's `CODEXHOST_RUNTIME_*` variables or Thread id.

Host injects Runtime endpoint and token only into processes it started. An unmanaged shell without an enrollment exits `RUNTIME_UNREACHABLE` / `missing_runtime_environment`. Enrollment issues a distinct client token and caller Thread identity after approval.

## Commands

| Command | Purpose |
| --- | --- |
| `enroll --client <id> [--allow <threadId:verb[,verb][;...]>] [--executable <path>] [--machine] [--session]` | Request attended enrollment |
| `enroll status [--client <id>]` | Show the local store without printing the token |
| `enroll revoke [--client <id>]` | Revoke at Runtime and delete the local store |
| `enroll serve --client <id> --listen <tailscale-ipv4> [--port 4398] --export-file <absolute-path>` | Expose one existing enrollment over Tailscale |

`--client grok-bot` is the v1 client id. `--allow` is optional and defaults to empty besides the newly issued Thread (`read`, `watch`, `send`). A parent Thread such as `70afcd8a-2124-44e3-aa9d-9a7d4695f97c` is reachable only when that id is listed; the fixture allowlist is `read,watch` only.

The CLI talks to a loopback enroll bootstrap published while Desktop/Runtime is running. That bootstrap token is not the Host session bearer token used by Host-started processes.

## Issued credentials

On Approve, Runtime creates:

- `enrollment_id`
- `thread_id` (the client's own Thread; never the parent Thread)
- `token` distinct from the Host token and bootstrap token
- `pairing`: `machine` (revoke-only, the default) or `session` (24-hour TTL with `--session`)
- `allowlist[]` of `{thread_id, verbs}` plus a digest of the canonical allowlist

The CLI writes the record to a user-private mode `600` store under `$CODEXHOST_DATA_DIR/enroll/clients/<client>.json` (default `~/.codexhost/...`). Deny or timeout writes nothing.

Later `codexhost thread *` uses Host-injected `CODEXHOST_RUNTIME_ENDPOINT` / `CODEXHOST_RUNTIME_TOKEN` when both are present. When both are absent, it reads a valid enrollment store. A missing store keeps `missing_runtime_environment`.

## Authorization

Every enrolled request sends the enrollment token. Runtime enforces the allowlist:

- Unknown Thread → `UNAUTHORIZED_TARGET`
- `read` / `wait` require `read`; `watch` requires `watch`; `send` / `cancel` require `send`
- `thread list` returns only allowlisted Threads plus the client's own Thread
- `delegate start` and Harness commands are denied for enrolled clients
- `thread watch` notify Thread must be the enrolled client's own Thread

Revoke, expiry, allowlist digest mismatch, clock skew beyond five minutes, and a store that is not mode `600` fail closed.

## Fail-closed sources

Enrollment does not mint credentials from:

- another process's environ (`--from-pid` / `CODEXHOST_ENROLL_FROM_PID`)
- a parent env file or Runtime descriptor (`--from-env-file` / `CODEXHOST_ENROLL_FROM_ENV_FILE`)
- an impersonating parent Thread id (`--as-thread` with the parent id)

The enroll bootstrap and local Runtime record endpoints remain loopback (`127.0.0.1`, `localhost`, or `[::1]`). A client handoff record with explicit `networkScope: "tailnet"` accepts a root HTTP URL on a literal Tailscale IPv4 address in `100.64.0.0/10`. DNS names, wildcard/LAN/public addresses, URL credentials, paths, queries and fragments are rejected for this transport. This client uses its handoff endpoint, ignoring any local bootstrap on the box.

## Desktop consent

Bootstrap requests use an Approve/Deny consent interface carrying the client name, executable path, Thread allowlist and verbs. Production currently uses a timeout stub, so an unmanaged bootstrap request times out and issues nothing. An already Host-authenticated calling session can issue an enrollment under the user's attended authorization. It must use its own supplied Runtime credentials; these credentials are never transferred to the client.

## Machine pairing

Enrollment defaults to revoke-only machine pairing for that client id, like an SSH authorized key. A Host-authenticated calling session is the trust step: it auto-approves issuance the same way it already issues any enrollment. Unmanaged bootstrap still times out and cannot mint or reuse a machine pairing. Later Host-session `enroll` with the same client and allowlist returns the same credentials and does not prompt again. Changing the allowlist is a new trust step and replaces the previous key. `enroll revoke` removes the key. `--session` issues a 24-hour token. The CLI stores the record only when the issued pairing matches the request; a Runtime that omits pairing is treated as session and is rejected for `--machine` with `pairing_mismatch`. Until Desktop loads this Runtime, only `--session` succeeds against the previous 24-hour issuer.

## Tailscale handoff without restarting Desktop

Pair a dedicated client from an authorized Host session, with only the required target and verbs:

```sh
codexhost enroll --client cursor-box-grok --allow '70afcd8a-2124-44e3-aa9d-9a7d4695f97c:read,send' --executable /absolute/path/to/remote/grok
codexhost enroll serve --client cursor-box-grok --listen <mac-tailscale-ipv4> --export-file /private/client-handoff/cursor-box-grok.json
```

`serve` runs as a separate foreground CLI process using only the client's local enrollment store. On POSIX it requires a user-owned mode-700 export directory. It creates a new mode-600 handoff file exclusively, and reports only endpoint, client, PID, expiry and file path. It does not replace the running Runtime or stop Desktop. The caller can remove Host credentials from this process's environment before starting it.

The listener accepts only that client's bearer, forwards only `thread read`, `thread send`, `enroll status` and `enroll revoke` to the live loopback Runtime from the local enroll bootstrap when present, and disables redirects. Runtime remains the authorization authority. Reads always use the issued client identity and cannot route to another Host. Requests are limited to 2 MiB with a 30-second upstream deadline. It does not expose enrollment issuance, delegation, cancel, wait or watch. Tailscale provides encrypted transport; configure tailnet access so only the intended peers can reach the listener. Only IPv4 is supported by this command.

Transfer **only this client's handoff record** over verified SSH into the box's private `$CODEXHOST_DATA_DIR/enroll/clients/cursor-box-grok.json` (or the default `~/.codexhost/...`). Use the updated CLI and select it with the non-secret `CODEXHOST_ENROLL_CLIENT=cursor-box-grok`. Do not set Runtime credentials or a parent Thread identity in the TUI. Do not copy an existing grok-bot store. An isolated CLI bundle and data directory can coexist with the box's installed remote Host. Delete the Mac export file after that copy is confirmed; the listener does not reread it. The box keeps using the remote store until revoke; later `--machine` calls with the same allowlist do not need a new copy.

The first switch from a session pairing to machine pairing issues a new token and caller Thread and revokes the previous session token. Restart the listener with a new `--export-file` path, then copy that handoff to the box once.

The listener stops on SIGINT/SIGTERM. Session pairing also stops it at token expiry. Machine pairing does not time out with the listener. Revocation at Runtime invalidates all requests immediately, even while the listener remains open. After a Runtime restart, persisted machine pairings stay valid and the listener follows the new loopback port from bootstrap. Restart the listener if it was stopped, or after a pairing switch that issued a new token. Write a new handoff file when the remote store is missing or the token changed. To roll back, revoke this client from its Mac local store, stop this listener, then remove the handoff and remote client store. Existing enrollments and native Threads/schedules are independent. There is no service installation.

## Out of scope

- Direct Linux VM access to Mac loopback, Web/Relay, and general remote Host routing
- Copying `CODEXHOST_*` from Cursor/parent processes, launchd, or shared files
- Attaching a client to a parent Thread id as if it were that chat
- Unattended first pairing, a daemon, or `launchctl setenv`
- Live Mac UAT of production Grok Bot
