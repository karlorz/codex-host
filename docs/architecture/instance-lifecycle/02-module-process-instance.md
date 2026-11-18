# Module: process instance identity

> **Source pin:** `karlorz/codex-host` @ `v0.20.0-0-2-gfb8145cc4` (`fb8145cc`)
> **Analyzed:** `2026-11-18`
> **Skill:** `codebase-architecture-analyze` v0.1.2
> **Output root:** `docs/architecture/instance-lifecycle/`

## Purpose

Name the live OS process that owns Host, Web, Console, or managed Desktop, without mixing it with a **Thread**.

## Interface (what a caller must know)

A process instance is live when `process_instance(pid, started_at_micros)` returns the same start time (`crates/platform/src/process_identity.rs:11-15`). PID reuse without that timestamp is a different instance.

Callers must also know:

- Which data root wrote the record (`~/.codexhost` vs Application Support).
- Which parent relationship proves the child is still this supervisor's Node (`web_service.rs` `web_running`: parent of `web_pid` equals supervisor pid).
- Console has no ready file: liveness is `GET /api/health` with `service === "codexhost-console"` (`packages/console-server/src/open.ts:26-47`).

## Implementation locations

| Kind | Record | Liveness |
| --- | --- | --- |
| Host | `shared-host-ready.json` | **`pid` is the Node child** + start time (`host_service.rs` writes `child.id()`) |
| Web | `web-service-ready.json` | **`pid` is the supervisor**; `web_pid` is the Node child; `web_running` requires parent of `web_pid` == supervisor |
| Console | none | port 4399 health |
| Managed Desktop | `desktop-runtime-v1.json` | control port open + controller child of launcher; path **ignores `CODEXHOST_DATA_DIR`** |
| Host channel | `client-hosts/host-<pid>-<epoch>.json` | PID + epoch hello; newest `startedAt` wins |
| Console Host list | `console/hosts/host-<pid>.json` | discovery metadata, not liveness (`docs/architecture/client-enrollment.md:21`) |
| Mapping Store lock | `instanceId` UUID in `store.lock` | store object, not an OS process |

## Depth

Shallow cluster: each kind exposes a different record shape and probe. Deleting any one helper does not remove the need to know all the others. **Locality** of “is this machine's codexhost running?” is spread across Launcher, Console, Web, and launchd.

## Seam

The durable seam for Host/Web is the data-directory ready file plus `process_instance`. Console sits on a different seam (loopback health). Managed Desktop sits on a third (Application Support descriptor + TCP nonce). Operator enroll sits on a fourth (launchd label), with no in-repo adapter.

**Observed:** one adapter per kind, so these seams are hypothetical in the Feathers sense until a second adapter (for example a unified inventory used by both `stop` and `status`) exists.

## Dependents

- `codexhost stop` / `status` / `web`
- Console `POST /api/stop` and `POST /api/web/open`
- Web `ensureOwner` → `host ensure`
- `npm stop` command-line matcher (`tools/dev-desktop/stop-processes.mjs:107-160`)

## Confusion with Threads

| Noun | Meaning | File |
| --- | --- | --- |
| Thread | Harness session | `docs/project/领域术语表.md:35-37` |
| Native Session | Harness-owned session state | glossary |
| enrollment `threadId` | idle Codex Thread issued at enroll | `docs/architecture/client-enrollment.md:28` |
| Host process instance | supervisor + Node | `host_service.rs` ReadyOwner |
| Desktop runtime instance | launcher pid + control port + nonce | `runtime_instance.rs:51-58` |
| Web instance | supervisor + web_pid | `web_service.rs:36-45` |
| Host epoch | UUID scoping cursors and snapshots | `host-client-channel.md:68` |
| Mapping Store `instanceId` | store object UUID | `packages/mapping-store` lock file |

The project glossary has **no** entries for Host Runtime, process instance, epoch, Web service, or Console. Thread IDs contain no PID or port (`packages/shared-contracts` `HostThreadId` is an opaque UUID). Spec forbids Thread IDs in the Desktop runtime descriptor (`openspec/specs/running-desktop-attachment/spec.md`).

Enrollment identity is not a Thread id (`packages/host-runtime` rejects `enrollmentId === threadId`). The enroll **process** is a disposable pipe (`docs/architecture/enrolled-mcp-relay.md:195,214`). KeepAlive makes that pipe look like a service instance.

Independent Codex Desktop (`ChatGPT.app`, `codex app-server`, cua_node) is a separate process tree. Spec: `codexhost stop` leaves user-opened Desktop running (`openspec/specs/web-background-service/spec.md:88-90`).
