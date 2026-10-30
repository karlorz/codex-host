# ZCode capability inventory

Harness ID: `zcode`. Native interface: installed ZCode Desktop bundled CLI, JSON-RPC/V4. Existing native qualification: ZCode 3.14.3/3.14.4 on macOS, documented in [integration guide](../../../docs/harnesses/zcode/zcode-harness-integration.md). Current goal changes have fixture coverage; ZCode is not installed on this implementation host. Scope: existing preinstalled plugin plus native goal control/background ownership repair.

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A2 | 工厂 | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A3 | 检查 | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A6 | 取消 | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| A10 | 关闭 | 必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B5 | Fork | 原生有则必做 | P1 | 不支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 不支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 不支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 受限 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B14 | 请求级计量 | 原生有则必做 | P2 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C4 | 首次安装 | 可选 | P2 | 不支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C6 | 会话导入 | 可选 | P2 | 不支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C7 | 全局用量统计 | 可选 | P2 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| C8 | 账号额度 | 可选 | P2 | 不支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| D4 | 文档 | 预装时必做 | P1 | 支持 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| D5 | 其他 | 可选 | P2 | 不适用 | manifest.json / src/plugin.ts / src/installation.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B5 | Fork | 原生有则必做 | P1 | 不支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/session.ts / src/adapter.ts | test/session.test.ts / test/native.test.ts / integration document | Native qualification limits in linked integration document |

## Shared native goals

P1 implemented: native goal commands settle as ephemeral controls; native workers use independent autonomous Turn events; active goal state prevents idle release. Evidence: `src/session.ts`, `test/session.test.ts`. Full native-panel capability is omitted: native goal-level token/time/timestamp mappings are unqualified. Native model-facing goal tools remain unverified. No Host scheduler or official tool injection.

## Limits

B11 has native child state observation without transcript reads. B12 goal continuation/control ordering has fixture coverage; current installed ZCode goal acceptance is unavailable. B15 retains prior integration scope; full delegated goal acceptance is unverified. B16 is unverified. Unsupported history/installation/import/account capabilities above have no empty success implementation. Windows/Linux native behavior remains unqualified; see integration guide.

## Changes outside plugin

Optional shared goal state schemas and HarnessSession capability, generic Host routing and protocol projection, documentation and feature matrices. No ZCode-specific Host/Renderer branch. Grok supplies the current qualified accounting producer.

## Validation

Focused Session regression covers native goal control before worker start and active/paused background ownership. Build/typecheck and focused checks are recorded in the work-item evidence. Native ZCode and Desktop goal acceptance remain pending; no app restart or installation was performed.
