# Grok 能力清单

## 基本信息

- Harness ID：`grok`；原生 ACP stdio + `x.ai/*` 扩展，每个 Host Session 使用独立 `--no-leader` 进程。
- 原生验证：Grok `1.0.67`（`2fe064390d07`），2026-10-23，macOS，本机登录，隔离 GROK_HOME 与项目；权限探针未调用模型。
- 交付范围：现有预装插件的 ACP 原生提问接入；权限等其余能力保留既有验证记录。
- 原生提问依据：本机 grokgod 的 grok-build 源码 `ask_user_question/types.rs`、`session/acp_session_impl/spawn.rs`，以及 grokgod 补丁 `0011`、`0025`、`0026`、`0027`、`0028`。
- 参考实现：Grok MCP elicitation 的原生请求生命周期；公共 Host Question 校验与投影。

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | test/account-presentation.test.ts |  |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts |  |
| A3 | 检查 | 必做 | P0 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| A6 | 取消 | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/grok-history.ts | test/grok-history.test.ts | Indexed hidden responses require fresh terminal identity plus native execution evidence; real task/subagent completion responses are retained, notification-only/reused no-output groups are ephemeral; zero-Item cancelled native goal workers are retained |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| A10 | 关闭 | 必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts |  |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/grok-adapter.ts、src/grok-models.ts | test/grok-adapter.test.ts |  |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/grok-adapter.ts、src/grok-models.ts | test/grok-adapter.test.ts |  |
| B3 | 权限模式 | 原生有则必做 | P1 | 受限 | src/permission-modes.ts、src/acp-transport.ts、src/grok-adapter.ts | test/grok-acp-permissions.test.ts、test/grok-permission-confirmation.test.ts、test/grok-permission-live.test.ts | 空闲时可切换；依赖原生实际状态信号 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/grok-adapter.ts | test/grok-adapter.test.ts | unattended-full-access 映射为 always-approve |
| B5 | Fork | 原生有则必做 | P1 | 支持 | src/grok-fork.ts、src/grok-adapter.ts | test/grok-fork.test.ts、test/grok-adapter.test.ts |  |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 支持 | src/grok-fork.ts、src/grok-adapter.ts | test/grok-adapter.test.ts |  |
| B7 | 回滚最后一轮 / checkpoint | 原生有则必做 | P1 | 受限 | src/grok-rewind.ts、src/grok-adapter.ts | test/grok-rewind.test.ts、test/grok-adapter.test.ts |  |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/grok-tool-output.ts、src/grok-file-change.ts、src/grok-adapter.ts | test/grok-tool-output.test.ts、test/grok-file-change.test.ts |  |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/grok-adapter.ts、src/acp-transport.ts | test/grok-adapter.test.ts | ACP request_permission |
| B10 | 提问 | 原生有则必做 | P0 | 受限 | src/acp-transport.ts、src/grok-questions.ts、src/grok-adapter.ts | test/grok-questions.test.ts、test/grok-acp-elicitation.test.ts、test/grok-adapter.test.ts；原生 AskUserQuestionExtRequest / AskUserQuestionExtResponse | 单选、Other、预览文本与取消；多选由共享 Renderer 卡片承载，真机已回传 Alpha + Beta，用户认可卡片样式；倒计时另需 0027 原生元数据；活动重置与倒计时同步需 0028 及原生配置开启；Plan 专属按钮不投影；真实 Desktop 已验收单选与文本 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 支持 | src/grok-subagent.ts、src/grok-subagent-lifecycle.ts、src/grok-goal-helpers.ts | test/grok-subagent.test.ts、test/grok-adapter.test.ts、test/grok-goal-helpers.test.ts | Native goal helper child links and final transcript hydration implemented; installed helper click-through pending; streaming unclaimed |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/grok-adapter.ts | test/grok-adapter.test.ts | Structured goal updates and independent native worker observation; installed Desktop lifecycle pending |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/grok-usage.ts、src/grok-adapter.ts | test/grok-usage.test.ts、test/grok-acp-usage.test.ts |  |
| B14 | 请求级计量 | 原生有则必做 | P2 | 受限 | src/grok-usage.ts、src/grok-adapter.ts | test/grok-adapter.test.ts | 当前发布原生费用快照，不发布 usage.request / usage.history |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/grok-adapter.ts | test/grok-adapter.test.ts | 执行策略与环境有测试；真实完整委派未验收 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | — | 本次未进行真实向下委派 |  |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、src/permission-modes.ts | test/account-presentation.test.ts、test/grok-permission-modes.test.ts |  |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | test/installation.test.ts |  |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts | test/installation.test.ts |  |
| C4 | 首次安装 | 可选 | P2 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts |  |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | src/command.ts、src/plugin.ts | test/grok-command.test.ts | CODEXHOST_GROK_COMMAND |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/session-import.ts | test/session-import.test.ts |  |
| C7 | 全局用量统计 | 可选 | P2 | 支持 | src/usage-statistics.ts | test/usage-statistics.test.ts |  |
| C8 | 账号额度 | 可选 | P2 | 支持 | src/grok-credits.ts、src/grok-adapter.ts | test/grok-credits.test.ts |  |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | tsconfig.json、package-lock.json | 既有 Workspace 注册 |  |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json | 既有预装清单 |  |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts |  |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/grok/ | docs/index.md |  |
| D5 | 其他 | 可选 | P2 | 不适用 | — | 无需新增插件或展示分支 |  |

## 受限与已知缺口

- Checkpoint rollback: implemented through optional `history.rollbackToCheckpoint` and native conversation-only rewind; validates exact retained Turn identities and supports an empty prefix. Isolated 1.0.45 real-model history trial passed; installed Desktop acceptance is pending. Legacy unmarked goal-control history is rejected before mutation.
- `/grok-goal`: implemented native objective / optional trailing budget / status / pause / resume / clear routing. Local no-goal controls and same-ID reopen passed on 1.0.45 with zero model calls. Independent background continuation projection is implemented; active-control, budget and installed Desktop acceptance remain partly unqualified; B12 remains limited. Host owns no goal scheduler or goal state.
- Installed Desktop acceptance for these extensions requires an approved restart. Running codexhost/Desktop sessions must remain untouched until Karl approves.

- B3：Grok 1.0.67 的权限扩展没有 RPC 回执，`session/info` 和 `configOptions` 不包含权限。生效确认必须取自原生权限管理器的实际状态，不能由发送结果推断。仅在无活动 Turn 或压缩操作时切换；通知作用于独立进程内的匹配会话。原生受管策略和 Auto 功能开关始终生效。
- B10：原生超时仍由 grokgod 管理，Host 不合成计时器或自动选择。原生撤回通知没有区分超时原因，Host 仅记录取消。多选复用 Host multiple 与答案数组，通过共享 Renderer 卡片承载；原生 Desktop 卡片仍无多选字段。Plan 专属按钮不投影。活动重置通过可选 questionActivity 与原生确认同步，需补丁 0028 及原生配置开启。
- 倒计时与 Desktop 活动转发仅在共享提问卡片上提供；纯文本问题组仍走原生 Desktop 卡片，矩阵对这两项标为部分支持。
- B12、B14、B15、B16：范围见表中备注；自主 Turn 与委派能力保留既有边界。

## 插件外改动

- `docs/harnesses/grok/permission-modes.md`、`docs/index.md`：权限接线、生效确认与验证范围。
- `docs/architecture/harness-plugin-architecture.md`：更新 Grok 当前权限语义。
- `openspec/specs/harness-permission-mode-control/spec.md`、`openspec/specs/grok-cli-acp-session/spec.md`：会话内切换与原生确认要求。
- `.agents/skills/codexhost-add-harness/references/implementations.md`、`spec-session-core.md`：移除过期的 Grok 创建时固定权限示例。
- `packages/host-runtime/test/external-thread-runtime.test.ts`：Grok 恢复夹具使用 live 能力，验证保存的权限仍经 open 传入。
- 原生提问文档：`docs/harnesses/grok/questions.md`、能力边界、三种语言 README、MCP/Computer Use 依赖说明及 `docs/index.md`。
- 公共产品扩展：浏览器安全的待答问题/回复/活动 RPC、Host 多选路由及 Renderer 复选框卡片；不按 Harness ID 分支。Harness Question 契约已具备 multiple；活动同步新增可选 HarnessSession.questionActivity，旧插件保留兼容。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| 原生边界 | 1.0.67 隔离协议探针 | 带 `_` 前缀的通知实际改变权限管理器；无前缀被拒绝；modelCalls=0 |
| Adapter 与 Transport | Grok 包测试；关闭与并发改动后增量复验 | 通过：首次全包 251 项；随后含 Host / Renderer 的 118 项及 ACP 增量 10 项均通过 |
| 类型 / 格式 | npm run typecheck；改动 TS 文件 ESLint 与 Prettier 检查；git diff --check | 通过 |
| 真实原生验收 | CODEXHOST_GROK_PERMISSION_LIVE=1 的原生测试；macOS，1.0.67，本机登录，grok-4.7，local | 切换、重复选择、同 ID Resume 均通过；modelCalls=0 |
| 插件加载 / Host | buildHarnessPlugin + 临时根 loadHarnessPlugins；external-thread-runtime.test.ts | 通过；未修改 Host / Renderer 生产代码 |
| 原生提问：Adapter / ACP | Grok 包与 installed-harness-plugins.test.ts | 342 项通过、2 项跳过；覆盖真实 SDK stdio 派发、先权限解决后提问的问题回传与清理；对端为协议夹具 |
| 原生提问：构建 / 类型 / 静态检查 | npm run build:typescript；npm run typecheck；改动 TS 的 ESLint / Prettier；node tools/check-boundaries.mjs；git diff --check | 通过；Markdown 在仓库默认 Prettier 忽略范围内，新提问文档另以空 ignore 文件检查 |
| 原生提问：真实模型 / Adapter | grokgod、grok-4.6、隔离目录；通过真实 GrokAdapter 自动回复 Alpha | Host Question 已发出并接受回复，原生 AskUserQuestion.UserAnswered 记录 Alpha；不代表 Desktop 界面验收 |
| 原生提问：Desktop | 2026-10-26，更新应用并重启后的新 Grok 会话；人工单选与文本回复 | 通过：Alpha（40.096 秒）、Other + notes hello（16.467 秒）；原生 UserAnswered，均早于 120 秒超时；未验收预览或 Plan 专属控件，未运行 SSH / Windows 或完整委派 |

多选实现验证：440 项聚焦测试通过、2 项 opt-in 原生测试跳过；真实 grokgod / grok-4.6 经 GrokAdapter 自动选择 Alpha + Gamma，原生 UserAnswered 保留两项。共享卡片、Host 边界及多选 ACP 回传均有测试。安装版 Desktop 人工多选已在 117.012 秒后回传 Alpha + Beta，用户确认功能正常；用户已认可 Grok 卡片样式；允许 Other 的单选组也使用共享卡片以保留聊天输入框。只读倒计时需 grokgod 0027，用户已确认显示并递减；活动重置及同步需 0028 与原生配置开启，22:34 JST 手动重启后，用户确认交互会重置倒计时；该次最终由原生超时选择推荐 Alpha，未提交多选答案，未测量最后交互至超时的精确时长。

## Goal and checkpoint implementation evidence (2026-10-30)

- Current native trial version: Grok `1.0.45 (2bdd1d6a6369)` at `/Users/karlchow/.grokgod/bin/grok`; the earlier 1.0.67 permission result above is separate evidence.
- Implementation: `src/grok-commands.ts`, `src/grok-rewind.ts`, `src/acp-transport.ts`, `src/grok-adapter.ts`. Transport preserves update-level host-Turn metadata and waits for matching persisted prompt/rewind terminal records.
- Public extension: optional browser-safe `history.rollbackToCheckpoint`, `RollbackToCheckpointSessionInput`, generic Host dispatch and Mapping Store expected-revision prefix replacement. Unsupported adapters reject the new open kind. No Harness-specific Host or Renderer branch was added.
- Regression evidence: `test/grok-commands.test.ts`, `test/grok-rewind.test.ts`, `test/grok-acp-history-settlement.test.ts`, Adapter tests, Host multi-Turn rollback tests, Mapping Store conflict tests and legacy capability-schema coverage.
- Native opt-in test: `CODEXHOST_GROK_GOAL_HISTORY_LIVE=1` verifies local controls/reopen without inference; `CODEXHOST_GROK_MODEL_HISTORY_LIVE=1` verifies real model-backed checkpoint rewind. Both isolate GROK_HOME/project, preserve workspace sentinel contents and close only their own processes.
- User-facing limitations and matrix criteria: `docs/harnesses/grok/goals-and-history.md`. Running installed sessions were not restarted or replaced.

## Shared native goals

Desktop Goal-mode entry: curated `/goal` admits the new-chat opening Turn; the matching `thread/goal/set` shares in-flight creation or acknowledges the same confirmed native ID/objective/budget/active state. The isolated native alias + duplicate-set + worker + pause/reopen/clear trial passed. Installed UI acceptance remains pending. Model-created goals from ordinary natural language remain a separate missing native tool; native `update_goal` only updates progress/completion of an existing goal.

Installed Desktop trial on `27dff829` failed at the first worker Item because the Grok Adapter omitted `turn.started` after autonomous admission. The Adapter now emits both lifecycle events; full Host regression covers worker projection and native identity persistence. The real-executable full Host trial also passed worker projection, pause with a cancelled native terminal/mapping, and clear (`CODEXHOST_GROK_GOAL_HOST_LIVE=1`). Earlier adapter-only native success did not establish Host/Desktop acceptance. A new candidate and attended retry are required.

P1: optional public goals capability, native goal accounting and autonomous worker observation are implemented. Native hidden goal input is hydrated from persisted Prompt Index boundaries; real terminal IDs remain required. Focused regressions: `test/grok-goals.test.ts`, autonomous worker test in `test/grok-adapter.test.ts`, Host goal routing/unknown-plugin test. Native 1.0.45 active-control acceptance passed creation, worker observation, cancelled terminal identity, pause, same-ID paused reopen and clear (`CODEXHOST_GROK_GOAL_CONTROL_LIVE=1`). The disposable full-Host completion trial passed with an explicit Always approve policy and 150,000-token test budget: completed parent, clear, at least five readable helper histories and correct file (`CODEXHOST_GROK_GOAL_HOST_COMPLETE_LIVE=1`). A separate native TUI run reached budget_limited; shared-panel budget behavior and installed Desktop acceptance remain unqualified. Native goal scheduler stays in Grok; no Host-managed fallback.

## Background responses and goal helpers

- One native history classifier supplies replay, background settlement and usage. Completion-name prefixes are not origin markers. Real response backfill preserves existing Host mappings and native rewind checkpoints; reused IDs with execution fail explicitly.
- Completed-goal clear waits for worker/summarizer completion within the existing operation deadline, with no delayed clear after timeout or replacement. Active/paused-goal clear and pause keep native cancellation.
- Standalone helpers retain child/session/attempt/parent identity. Live publication waits for the worker terminal key; replay places pre-input planners and post-terminal summaries by that key. Unknown ownership creates no guessed parent. Native descriptions/models survive; generic type is not a role.
- Natural-language goal creation is unsupported pending a model-facing native creation tool. Desktop `/goal` and `/grok-goal` are the qualified entry points.
- Regression coverage: Grok history/usage/Adapter/transport/lifecycle and full Host goal-worker/child-transcript fixtures. Installed Desktop acceptance remains separate and requires Karl's manual restart of an authorized candidate.

- Pre-worker planning approvals: the shared interaction contract needs an active Turn. A planner approval before worker admission cannot be presented as a parent interaction; native planning can pause. Native permission policy must be selected deliberately; the Adapter does not elevate it.

Goal presentation: Desktop `/goal` creation omits the static status reply; explicit `/grok-goal` controls retain it. Successful autonomous settlement publishes native persisted closing messages before the Turn completes and assigns the final-answer phase. Persisted summarizer splitting matches the full raw native output rather than its bounded display summary. Full-Host regressions cover streamed and PersistOnly answers with helper bookkeeping; installed visual acceptance remains pending.

Goal history restoration: the first durable worker displays the native `goal_created` objective as `/goal <objective>` without adding a Turn or checkpoint. Native user/terminal timestamps retain worker and child elapsed time. The optional generic `goals.readLastCompleted()` capability returns validated native completion accounting after clear; Host replays completion display with current goal null and discards restoration on concurrent goal changes. Focused disk-reader and Host regressions cover original request, timing, no native mutation and concurrent reads. Opened idle helper recency uses native Turn times; unhydrated list recency remains Mapping Store based. Installed restart/reopen visual acceptance is separate.
