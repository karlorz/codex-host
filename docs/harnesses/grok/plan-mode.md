# Grok plan mode and plan approval

Grok's native plan mode is ACP session mode `plan`, independent of Ask / Auto / Always approve. The Grok plugin exposes Plan in the Desktop permission picker and projects native `x.ai/exit_plan_mode` as a **Review plan** question so the user can stay in plan mode, approve and implement, or turn plan mode off.

## User-visible behavior

Selecting **Plan** sends ACP `session/set_mode` with `modeId: "plan"`. Tool permission stays the last confirmed Ask, Auto, or Always approve setting. Selecting Ask, Auto, or Always approve while Plan is active sends `session/set_mode` `default`, then applies that permission policy.

When Grok finishes a plan it issues `_x.ai/exit_plan_mode` (native name `x.ai/exit_plan_mode`) with optional `planContent`. CodexHost shows a closed Host Question, not a one-time tool approval:

- The full native plan body is shown. An empty plan still offers approve; Grok allows leaving plan mode without a written plan.
- **Stay in plan mode** is first. It returns native `cancelled`. Optional comments are native `feedback` and keep Grok planning.
- **Approve plan and start implementation** returns native `approved`. Grok exits plan mode and may begin implementation under the current permission policy.
- **Exit plan mode without implementing** returns native `abandoned`.
- Dismissing the card is `cancelled` (stay in plan mode). Undeclared options, multi-select, and missing answers cannot approve.

The picker follows native `current_mode_update`. After approve or abandon, `plan` leaves the picker when Grok reports `default`. If that update is missing, the user can still leave Plan from the picker. Card dismiss is stay-in-plan, not native pager `q` (abandon).

Idle, foreign-Session, replay, compaction, and duplicate tool-call IDs cancel the reverse request without a second card, which keeps Grok in plan mode. A parked approval restored on resume before a user Turn uses the same fail-closed cancel; send a follow-up in Plan or switch the picker. Resume with Host `plan` calls `session/set_mode` and leaves native YOLO flags unchanged; the picker treats Ask as the policy under Plan until the user selects Ask, Auto, or Always approve.

Plan-mode interview extras on `_x.ai/ask_user_question` (**Chat about this** / **Skip interview**) remain unprojected. Ordinary accept/cancel still work.

## Ownership

- `packages/adapters/grok/src/permission-modes.ts` lists Plan in the catalog. YOLO/auto flags never use the Plan id.
- `packages/adapters/grok/src/acp-transport.ts` owns `session/set_mode` and the `exit_plan_mode` reverse request.
- `packages/adapters/grok/src/grok-plan-approval.ts` maps the request to a Host Question and maps the answer back to `approved` / `cancelled` / `abandoned`.
- The Adapter does not call `session/set_mode` when the user answers the review card. Native Grok exits or stays; Host state follows `current_mode_update`.

## Verification

```sh
npx vitest run --config tests/vitest.config.js \
  packages/adapters/grok/test/grok-permission-modes.test.ts \
  packages/adapters/grok/test/grok-plan-approval.test.ts \
  packages/adapters/grok/test/grok-adapter.test.ts \
  packages/adapters/grok/test/grok-acp-plan-mode.test.ts \
  packages/adapters/grok/test/grok-acp-session-rules.test.ts
```
