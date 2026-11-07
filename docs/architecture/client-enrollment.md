# Client enrollment for unmanaged local CLIs

`codexhost enroll` lets a local unmanaged client such as Grok Bot on the same Mac use Host Runtime without copying another process's `CODEXHOST_RUNTIME_*` variables or Thread id.

Host injects Runtime endpoint and token only into processes it started. An unmanaged shell has no those variables and exits `RUNTIME_UNREACHABLE` / `missing_runtime_environment`. Enrollment issues a **new** Runtime session and Thread after attended Desktop consent.

## Commands

| Command | Purpose |
| --- | --- |
| `enroll --client <id> [--allow <threadId:verb[,verb][;...]>] [--executable <path>]` | Request attended enrollment |
| `enroll status [--client <id>]` | Show the local store without printing the token |
| `enroll revoke [--client <id>]` | Revoke at Runtime and delete the local store |

`--client grok-bot` is the v1 client id. `--allow` is optional and defaults to empty besides the newly issued Thread (`read`, `watch`, `send`). A parent Thread such as `70afcd8a-2124-44e3-aa9d-9a7d4695f97c` is reachable only when that id is listed; the fixture allowlist is `read,watch` only.

The CLI talks to a loopback enroll bootstrap published while Desktop/Runtime is running. That bootstrap token is not the Host session bearer token used by Host-started processes.

## Issued credentials

On Approve, Runtime creates:

- `enrollment_id`
- `thread_id` (the client's own Thread; never the parent Thread)
- expiring `token` distinct from the Host token and bootstrap token
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

The enroll bootstrap and store endpoints must be loopback (`127.0.0.1`, `localhost`, or `[::1]`).

## Desktop consent

Desktop is asked to Approve or Deny the client name, requesting executable path, requested Thread allowlist, and verbs. Tests stub Approve/Deny. When no attended Desktop prompt can run, the Host times out and issues nothing.

## Out of scope

- Grok Bot Linux VM shells reaching Mac loopback
- Copying `CODEXHOST_*` from Cursor/parent processes, launchd, or shared files
- Attaching a client to a parent Thread id as if it were that chat
- Unattended auto-enroll, a daemon, or `launchctl setenv`
- Live Mac UAT of production Grok Bot
