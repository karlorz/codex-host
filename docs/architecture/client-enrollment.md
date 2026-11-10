# Client enrollment for unmanaged CLIs

`codexhost enroll` lets a local unmanaged client such as Grok Bot on the same Mac use Host Runtime without copying another process's `CODEXHOST_RUNTIME_*` variables or Thread id.

Host injects Runtime endpoint and token only into processes it started. An unmanaged shell without an enrollment exits `RUNTIME_UNREACHABLE` / `missing_runtime_environment`. Enrollment issues a distinct client token and caller Thread identity after approval.

## Commands

| Command | Purpose |
| --- | --- |
| `enroll --client <id> [--allow <threadId:verb[,verb][;...]>] [--executable <path>] [--machine] [--session]` | Request attended enrollment |
| `enroll status [--client <id>] [--enrolled-client <id>]` | Show the local store and selected authentication source without printing the token |
| `enroll revoke [--client <id>] [--enrolled-client <id>]` | Revoke at Runtime and delete the local store |
| `enroll serve --client <id> --listen <tailscale-ipv4> [--port 4398] --export-file <absolute-path>` | Expose one existing enrollment over Tailscale |

`--client grok-bot` is the v1 client id. `--allow` is optional and defaults to empty besides the newly issued Thread (`read`, `watch`, `send`, `cancel`). A parent Thread such as `70afcd8a-2124-44e3-aa9d-9a7d4695f97c` is reachable only when that id is listed; the fixture allowlist is `read,watch` only. `send` does not grant `cancel`.

The CLI talks to a loopback enroll bootstrap published when Desktop/Runtime starts. The last published descriptor remains on disk through shutdown and is atomically replaced by the next Runtime, so an older Runtime cannot delete a newer Runtime's discovery file. It is discovery metadata, not a liveness guarantee: requests to a stopped Runtime fail with `RUNTIME_UNREACHABLE`. That bootstrap token is not the Host session bearer token used by Host-started processes.

## Issued credentials

On Approve, Runtime creates:

- `enrollment_id`
- `thread_id` — a native idle Codex Thread created in the Host before credentials are issued (never the parent Thread; `thread read` of this id must work without a prior client send)
- `token` distinct from the Host token and bootstrap token
- `pairing`: `machine` (recorded ten-year expiry unless revoked sooner, the default) or `session` (24-hour TTL with `--session`)
- `allowlist[]` of `{thread_id, verbs}` plus a digest of the canonical allowlist

The CLI writes the record to a user-private mode `600` store under `$CODEXHOST_DATA_DIR/enroll/clients/<client>.json` (default `~/.codexhost/...`). Deny or timeout writes nothing.

Native Thread creation starts no Turn. Failure prevents issuance and leaves an existing pairing valid. Reusing a machine pairing retains its original caller identity. A credential whose caller id has no native Thread can still access its allowlisted targets; obtaining a native own Thread requires attended replacement and a refreshed handoff. Runtime port changes alone do not require replacement.

Later `codexhost thread *` uses Host-injected `CODEXHOST_RUNTIME_ENDPOINT` / `CODEXHOST_RUNTIME_TOKEN` when both are present, unless `--enrolled-client <id>` is set. That option uses the named enrollment and fails if the store is missing or invalid; it does not fall back to Host credentials. When neither Host env nor `--enrolled-client` is set, the CLI reads `CODEXHOST_ENROLL_CLIENT` (default `grok-bot`). A missing default store keeps `missing_runtime_environment`.

## Authorization

Every enrolled request sends the enrollment token. Runtime enforces the allowlist:

- Unknown Thread → `UNAUTHORIZED_TARGET`
- `read` / `wait` require `read`; `watch` requires `watch`; `send` requires `send`; `cancel` requires `cancel`. Existing `send` grants do not include `cancel`; re-enroll with an explicit `cancel` verb to authorize cancellation. Newly issued enrollments include `cancel` on the client's own Thread.
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

Production Desktop has no enrollment consent UI. An unmanaged bootstrap request fails immediately with `consent_ui_unavailable` and issues nothing. Request enrollment from an authorized Host session (`codexhost enroll --client <id> --machine`). That session auto-approves under the user's attended authorization. It must use its own supplied Runtime credentials; these credentials are never transferred to the client.

## Machine pairing

Enrollment defaults to machine pairing for that client id, like an SSH authorized key, with a recorded ten-year expiry unless revoked sooner. A Host-authenticated calling session is the trust step: it auto-approves issuance the same way it already issues any enrollment. Unmanaged bootstrap fails immediately with `consent_ui_unavailable` and cannot mint or reuse a machine pairing. Later Host-session `enroll` with the same client and allowlist returns the same credentials and does not prompt again. Changing the allowlist is a new trust step and replaces the previous key. `enroll revoke` removes the key. `--session` issues a 24-hour token. The CLI stores the record only when the issued pairing matches the request; a Runtime that omits pairing is treated as session and is rejected for `--machine` with `pairing_mismatch`. Until Desktop loads this Runtime, only `--session` succeeds against the previous 24-hour issuer.

## Local collaborator send

A Host-authenticated session issues enrollment. Later `thread read` / `thread send` from an unmanaged shell should pass `--enrolled-client <id>`. That uses the enrollment store even when Host Runtime env is inherited, and fails if the store is missing or invalid.

`enroll status` uses the same client selector (`--client`, `--enrolled-client`, or `CODEXHOST_ENROLL_CLIENT`, default `grok-bot`) and reports `authentication.source` without the token: `host-session` when both Host Runtime variables are set and `--enrolled-client` is omitted, `incomplete-host-session` with the missing variable names when only one is set, and `enrollment` when `--enrolled-client` is set or both Host Runtime variables are absent. For a loopback store, `endpoint` is the live Runtime bootstrap port when published; the on-disk client file is not rewritten and tokens are not rotated. A tailnet handoff keeps its Tailscale URL. Partial Host credentials fail with `missing_runtime_environment` on thread commands; they do not fall back to enrollment. The store file must remain mode `600`. Invalid stores fail closed with `expired`, `insecure_store_mode`, or `missing_store`, including client id and path.

```sh
codexhost enroll --client muse \
  --allow '<target-thread-id>:read,watch,send' \
  --executable /absolute/path/to/codexhost \
  --machine

codexhost enroll status --enrolled-client muse
codexhost thread read <target-thread-id> --enrolled-client muse --format compact
codexhost thread wait <target-thread-id> --enrolled-client muse --timeout-ms 30000 --format compact
codexhost thread send <target-thread-id> --enrolled-client muse --message connectivity --format compact
```

If the target is already running, wait or read until idle, then send again. `running` on send means a new Turn started. `thread watch` notifies the enrolled client's own Thread; it is not a callback to an external chat such as Muse.ai. Enrollment authorizes Host access; it does not install a Muse connector.

`THREAD_BUSY` means the allowlisted send reached Host and the target already has an active Turn. No new Turn started (`notStarted: true`). That is authorization success, not a missing enrollment. Wait until the Thread is idle, then send again. The collaborator send ritual never cancels another Thread's Turn to clear busy. A `cancel` grant is only a technical prerequisite for cancellation; interrupting another Turn also requires explicit user authorization. An idle send returns immediately with `status: running` for the new Turn.

Clearing Host env remains valid when `--enrolled-client` is unavailable:

```sh
env -u CODEXHOST_RUNTIME_ENDPOINT -u CODEXHOST_RUNTIME_TOKEN \
  -u CODEXHOST_THREAD_ID -u CODEX_THREAD_ID \
  CODEXHOST_ENROLL_CLIENT=muse \
  codexhost thread send <target-thread-id> --message connectivity --format compact
```

Do not look up Codex Desktop Threads through ChatGPT or `api.openai.com`. Codex Host enrollment plus `thread send` is the connection path. The enrolled client's own `thread_id` is distinct from every allowlisted target Thread.

## Tailscale handoff without restarting Desktop

Pair a dedicated client from an authorized Host session, with only the required target and verbs:

```sh
codexhost enroll --client cursor-box-grok --allow '70afcd8a-2124-44e3-aa9d-9a7d4695f97c:read,send' --executable /absolute/path/to/remote/grok
codexhost enroll serve --client cursor-box-grok --listen <mac-tailscale-ipv4> --export-file /private/client-handoff/cursor-box-grok.json
```

Each enrolled client needs its own listener, port, and handoff file. Default port `4398` is one listener, not a shared enrollment endpoint. A second client such as `muse` must use another port and a new exclusive export path. Copying another client's handoff does not authorize `muse`: Thread commands, status, revoke, and serve reject a store whose recorded client differs from the selected client with `client_mismatch`.

```sh
codexhost enroll serve --client muse --listen <mac-tailscale-ipv4> --port 4397 --export-file /private/client-handoff/muse.json
```

`serve` runs as a separate foreground CLI process using only the client's local enrollment store. On POSIX it requires a user-owned mode-700 export directory. It creates a new mode-600 handoff file exclusively, and reports only endpoint, client, PID, expiry and file path. It does not replace the running Runtime or stop Desktop. The caller can remove Host credentials from this process's environment before starting it.

The listener binds before creating the export. A bind failure such as `EADDRINUSE` preserves an existing handoff. Use a fresh export path for each start attempt; operator supervisors must not delete a canonical handoff before binding. A supervisor can atomically publish the new handoff only after the private attempt file exists. Restarting the listener with the same enrollment does not rotate its token, and an existing remote store keeps working at the same Tailscale address and port.

The listener accepts only that client's bearer, forwards only `thread read`, `thread send`, `enroll status` and `enroll revoke` to the live loopback Runtime from the local enroll bootstrap when present, and disables redirects. Runtime remains the authorization authority. Reads always use the issued client identity and cannot route to another Host. Requests are limited to 2 MiB with a 30-second upstream deadline. It does not expose enrollment issuance, delegation, cancel, wait or watch. Tailscale provides encrypted transport; configure tailnet access so only the intended peers can reach the listener. Only IPv4 is supported by this command.

Transfer **only this client's handoff record** over verified SSH into the box's private `$CODEXHOST_DATA_DIR/enroll/clients/cursor-box-grok.json` (or the default `~/.codexhost/...`). Use the updated CLI and select it with the non-secret `CODEXHOST_ENROLL_CLIENT=cursor-box-grok`. Do not set Runtime credentials or a parent Thread identity in the TUI. Do not copy an existing grok-bot store. An isolated CLI bundle and data directory can coexist with the box's installed remote Host. Delete the Mac export file after that copy is confirmed; the listener does not reread it. The box keeps using the remote store until revoke; later `--machine` calls with the same allowlist do not need a new copy.

The first switch from a session pairing to machine pairing issues a new token and caller Thread and revokes the previous session token. Restart the listener with a new `--export-file` path, then copy that handoff to the box once.

The listener stops on SIGINT/SIGTERM. Session pairing also stops it at token expiry. Machine pairing does not time out with the listener. Revocation at Runtime invalidates all requests immediately, even while the listener remains open. After a Runtime restart, persisted machine pairings stay valid and the listener follows the new loopback port from bootstrap. Restart the listener if it was stopped, or after a pairing switch that issued a new token. Write a new handoff file when the remote store is missing or the token changed. To roll back, revoke this client from its Mac local store, stop this listener, then remove the handoff and remote client store. Existing enrollments and native Threads/schedules are independent. There is no service installation.

## Settings and console

Desktop Settings and the local console share an **Enrollment** page. It lists active Runtime records (client id, pairing, expiry, allowlist, executable) and can revoke one enrollment. Machine pairing shows the recorded expiry, valid until that date unless revoked earlier. Tokens are never shown. The page does not start or stop `enroll serve`; that remains a foreground CLI. Listing and revoke go through Host methods `codexhost/enrollment/list` and `codexhost/enrollment/revoke`, which the console may call only while the local Host is running.

## Out of scope

- Direct Linux VM access to Mac loopback, Web/Relay, and general remote Host routing
- Copying `CODEXHOST_*` from Cursor/parent processes, launchd, or shared files
- Attaching a client to a parent Thread id as if it were that chat
- Unattended first pairing, a daemon, or `launchctl setenv`
- Live Mac UAT of production Grok Bot
