# Tech debt: stop/start and instance naming

> **Source pin:** `karlorz/codex-host` @ `v0.20.0-0-2-gfb8145cc4` (`fb8145cc`)
> **Analyzed:** `2026-11-18`
> **Skill:** `codebase-architecture-analyze` v0.1.2
> **Output root:** `docs/architecture/instance-lifecycle/`

## Architecture

| ID | Debt | Evidence | Cost |
| --- | --- | --- | --- |
| D1 | Six stop adapters, six identity schemes | `services.rs:261-345` vs ready files vs health vs launchd | `codexhost stop` can print idle while Console/enroll/Web Node remain |
| D2 | Console health `*-stopping` is not a live console | `open.ts:31-44`, `server.ts:365,488-493` | CLI exit 3; port 4399 stays bound |
| D3 | Web reconnect `ensureOwner` after Host stop | HostClientChannel connect; `web_service::ensure` always host-ensures | Host returns unless Web really exited |
| D4 | Operator KeepAlive enroll outside stop/status/autostart | no plist generator; `stop_all` has no enroll branch | “full stop” requires `launchctl bootout` + disable |
| D5 | Dual data roots on macOS | `~/.codexhost` vs `~/Library/Application Support/codexhost` | GUI stop and Host stop look at different folders |
| D6 | `codexhost stop` vs `npm stop` | records vs `ps` command-line match | two truths for the same machine |
| D7 | `status` omits Console and enroll | `services.rs:350-381` | operators cannot see leftovers that block start |

## Docs / naming

| ID | Debt | Evidence |
| --- | --- | --- |
| N1 | “instance” means Desktop runtime, Host process, Web supervisor, Host epoch, Mapping Store object, and enrollment | `runtime_instance.rs`, ReadyOwner, `host-client-channel.md:68`, mapping-store lock |
| N2 | Enrollment `threadId` sits next to process PIDs in operator mental model | `client-enrollment.md:28` vs `ps` |
| N3 | Independent Codex Desktop trees look like leftover codexhost | ChatGPT.app `codex app-server`, cua_node; spec keeps them |
| N4 | Host `pid` is the Node child; Web `pid` is the supervisor | `host_service.rs` vs `web_service.rs` ReadyOwner |
| N5 | Glossary omits Host Runtime / process instance / Console | `docs/project/领域术语表.md` |

## Code

| ID | Debt | Evidence |
| --- | --- | --- |
| C1 | Web orphan scan Unix-only and requires dead parent | `web_service.rs:380-414` |
| C2 | Host `--stop` succeeds when no channel descriptor | shared-host-service prints not running, `wait_for_shutdown(None)` |
| C3 | Console `serviceCommand` omits `--data` | `packages/console-server/src/services.ts:20-30` |

## Infra

Operator LaunchAgent `com.codexhost.enroll-relay-link-muse` is live operations, not product. Broker and autostart plists are product. Mixing the three under “LaunchAgent” hides KeepAlive.

## Suggested next skill

`improve-codebase-architecture` (temp review) then grill one candidate before `architecture-to-spec`.
