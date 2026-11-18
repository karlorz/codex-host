# Blueprint: one machine instance inventory

> **Source pin:** `karlorz/codex-host` @ `v0.20.0-0-2-gfb8145cc4` (`fb8145cc`)
> **Analyzed:** `2026-11-18`
> **Skill:** `codebase-architecture-analyze` v0.1.2
> **Output root:** `docs/architecture/instance-lifecycle/`

This is a **slice** blueprint for stop/start identity, not a rebuild of Host protocol or Harness Adapters.

## Goal

One deep module answers: which **process instances** belong to this installation on this machine, and what `stop` / `status` / `web` may do to each. Threads stay in Host Runtime.

## Current end-to-end (observed)

```text
codexhost web
  → host ensure (reuse shared-host-ready.json or spawn host serve)
  → web-service serve (reuse web-service-ready.json or spawn)
  → print login URL

codexhost stop
  → managed GUI if desktop-runtime-v1.json + control port
  → Web if web-service-ready.json matches pid+start
  → Host if shared-host-ready.json matches
  → remote if manifest exists
  → Brokers matching ai.bytepioneer.codexhost.*-broker
  → Console if :4399 health is exactly codexhost-console
  → print stopped | No codexhost services are running

KeepAlive enroll relay-link
  → never listed, never signaled
```

## Target shape

A **machine instance inventory** interface:

- `list()` → Host, Web, Console, managed GUI, Brokers, product autostart, optional named enroll supervisors
- `stop(kind)` uses that list, not a second identity scheme
- `status` prints the same list
- Thread ids never appear as process instances

KeepAlive enroll becomes either (a) documented operator-only, visible in status as unmanaged, or (b) a product supervisor with install/uninstall and a stop target. Do not reuse `ai.bytepioneer.codexhost.autostart` (refresh would rewrite it; it has no KeepAlive).

## Milestones

1. **Inventory read-only.** Enumerate Host/Web/Console/enroll/Broker/autostart with pid, record path, and “stop would see this: yes/no”. Verify: `codexhost status` after planting a stuck Console (`*-stopping`) and a KeepAlive enroll shows both.
2. **Console stop treats `*-stopping` as live.** Escalate SIGTERM if health stays stopping. Verify: fixture from `packages/console-server/test/server.test.ts` stop/shutdown plus a hung-close case.
3. **Stop does not return idle while inventory is non-empty.** Verify: `crates/launcher/tests/web_service.rs` stop cases; add enroll-unmanaged warning without unloading product autostart.
4. **Web cannot host-ensure during an in-progress machine stop.** Verify: HostClientChannel with a stop-in-progress marker; Web reconnect does not spawn Host until stop completes or a new `web`/`launch` runs.
5. **Glossary locality.** One page: process instance vs Thread vs enrollment Thread vs independent Desktop. Link from `docs/project/领域术语表.md`.

## Verify commands

```bash
codexhost status
codexhost stop
curl -sS http://127.0.0.1:4399/api/health || true
pgrep -fl 'enroll relay-link|console-server.mjs serve|host serve|web-service serve' || true
launchctl print "gui/$(id -u)/com.codexhost.enroll-relay-link-muse" || true
```

Focused tests: `packages/console-server/test/open.test.ts`, `packages/console-server/test/server.test.ts` (stop/shutdown), `crates/launcher/tests/web_service.rs`, `tools/dev-desktop/stop.test.mjs`.

## NFRs

- Do not kill independently opened Codex Desktop.
- Do not disable product autostart from `stop` unless the operator asks (`autostart off`).
- Session data and enrollment stores remain.
- Secrets stay out of status output.

## Next

Improve review: `$TMPDIR/architecture-review-*.html`. Grill before writing a work-item spec.
