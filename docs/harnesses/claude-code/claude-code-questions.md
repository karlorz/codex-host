# Claude Code questions

Claude Code's native `AskUserQuestion` maps onto the public Host Question contract. Each native question has `allowOther: true`, so the group uses the shared codexhost card. By default that card mounts in the transcript; Codex Host Settings → Appearance can restore the above-Composer overlay. Official Codex questions stay on Desktop's layout. Plan-exit review is a separate Host Question and is not an `AskUserQuestion` call; see [plan mode](claude-code-plan-mode.md).

## Native answers

Live answers use the existing Host question respond path. After reopen, the read-only record returns only from native session history:

- `tool_result` content is the prose `"Which letters?"="Alpha, Beta"`.
- Structured answers sit on the parent user message as `toolUseResult.answers`.
- `"User cancelled the Question"` with `is_error` is a skip.
- JSON tool-result payloads remain understood.

Updating only the Host does not restore Claude cards; the Claude plugin must include this mapping.

## Placement

Shared-card placement is the Host/Renderer Appearance switch, not a Claude setting. Overlay mode closes the live picker after Send or Skip and still keeps the read-only record in the transcript. In-chat mode keeps the live picker in the matching transcript row. During Working the answered record stays visible as a full-width history block, then parks on that turn's remaining visible reply.

## Verification

Focused Adapter tests cover JSON answers, native prose, `toolUseResult.answers`, and native cancel. Attended installed Desktop checks on a Grok and Claude thread confirmed the answered in-chat record after a manual `codexhost.app` restart.
