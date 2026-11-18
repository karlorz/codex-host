# Module: enroll relay-link and KeepAlive

> **Source pin:** `karlorz/codex-host` @ `v0.20.0-0-2-gfb8145cc4` (`fb8145cc`)
> **Analyzed:** `2026-11-18`
> **Skill:** `codebase-architecture-analyze` v0.1.2
> **Output root:** `docs/architecture/instance-lifecycle/`

## Purpose

Keep an outbound Mac link to the enrolled MCP hop so Muse (and later full-dispatch clients) can call Host routes without binding a public Mac port.

## Product interface (in-repo)

`codexhost enroll relay-link --client muse --hop <tailscale-ipv4> [--port 4401] --link-secret-file <absolute-path>`

**Observed:**

- Routed as a blocking foreground CLI (`crates/launcher/src/main.rs` enroll → `run_delegation_cli`).
- Implementation `runEnrollmentRelayLink` in `packages/host-runtime/src/client-enrollment-relay-link.ts`: one TCP connection, JSONL frames, SIGINT/SIGTERM stop. No reconnect loop, no daemonize, no plist.
- Contract: “It is a foreground process, like `enroll serve`.” (`docs/architecture/enrolled-mcp-relay.md:195`).
- “There is no service installation.” (`docs/architecture/client-enrollment.md:125`).
- Disconnected link drops in-flight frames; no replay (`enrolled-mcp-relay.md:214`).

Upstream is the live enroll bootstrap or the stored `record.endpoint`. After Host stop, the link process can remain connected to the hop while Host POSTs fail `RUNTIME_UNREACHABLE` (`client-enrollment.md:21`).

## Operator adapter (out of repo)

**Observed on host 2026-11-18** (not in git):

- Label `com.codexhost.enroll-relay-link-muse`
- Path `~/Library/LaunchAgents/com.codexhost.enroll-relay-link-muse.plist`
- `RunAtLoad` true, `KeepAlive` true, `ThrottleInterval` 10
- Program: `/bin/bash ~/.codexhost/enroll/relay-link-muse/link.sh`
- Child: `/Applications/codexhost.app/Contents/MacOS/codexhost enroll relay-link ...`

Repo mention is an incident line only (`docs/architecture/enrolled-mcp-relay.md:290`).

**Inferred:** KeepAlive supplies the reconnect the binary omits. Socket close or `codexhost stop` (which never signals this process) leaves launchd to restart it.

## Product autostart is a different module

| | Product autostart | Operator enroll agent |
| --- | --- | --- |
| Label | `ai.bytepioneer.codexhost.autostart` | `com.codexhost.enroll-relay-link-muse` |
| Command | `codexhost web --background` | `enroll relay-link` |
| KeepAlive | absent (`crates/platform/src/autostart.rs:150-153`; tests assert no KeepAlive) | true |
| `launchctl` | write/delete plist only; next login (`autostart_macos.rs:43`) | bootstrap/bootout |
| `codexhost stop` | must not modify (`spec.md:74`) | not in stop_all at all |
| `codexhost status` | Autostart line for this plist | separate unmanaged Enroll lines |

Broker LaunchAgents use prefix `ai.bytepioneer.codexhost.` + suffix `-broker` (`crates/launcher/src/native_harness_broker.rs`). The enroll label matches neither, so broker stop skips it.

## Relationship to Threads

Enrollment issues `enrollment_id`, `thread_id`, and token (`client-enrollment.md:25-31`). That Thread survives process death. The link process stamps `callerThreadId` on read/wait/send (`client-enrollment-relay-link.ts` `stampLegacyEnrollmentBody`). Stopping Host interrupts dispatch; it does not revoke Muse or delete the enrollment store.

`codexhost status` lists `com.codexhost.enroll-*.plist` as unmanaged. `codexhost stop` prints leftover lines for those labels and does not unload KeepAlive.

## Depth

The in-repo module is a deep CLI (connect, auth, frame, fail-closed) behind a small flag set. The operator LaunchAgent is a second, undocumented supervisor with no install/uninstall interface. Together they are a **shallow** machine-level service: callers must know launchd, KeepAlive, bootout, and that `codexhost stop` will not finish the job.

## Deletion test

Deleting the LaunchAgent restores the documented foreground contract. Complexity of “Muse stays up across Desktop/Host restarts” then sits on the operator. Productizing KeepAlive would move that complexity into an explicit supervisor module with a stop target.
