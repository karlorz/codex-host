<div align="center">

# CodexHost

**在 Codex Desktop 中运行 Pi 和其他 Harness**

我们认为 **Codex Desktop** 提供了目前最好的桌面开发体验

但 **Codex** 并不是唯一优秀的 **Agent Harness**，还有 **Claude Code**、**Pi**

**CodexHost** 让你在 **Codex Desktop** 中原生使用其他 **Harness**，并让它们协作完成任务

⭐ 如果这个项目对你有帮助，请给我们一个 Star！⭐

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="../imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="../imgs/badge-opencode.svg" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="../imgs/badge-omp-v5.svg" /></a><br />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek_Harness-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="../imgs/badge-agy.svg" /></a>
  <a href="https://kiro.dev/docs/cli/"><img alt="Kiro CLI" src="../imgs/badge-kiro.svg" /></a>
  <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="../imgs/badge-codebuddy.svg" /></a>
  <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="../imgs/badge-workbuddy.svg" /></a>
  <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="../imgs/badge-cursor.svg" /></a>
  <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="../imgs/badge-hermes.svg" /></a>
  <a href="https://qoder.com/cli"><img alt="Qoder" src="../imgs/badge-qoder.svg" /></a>
  <a href="../harnesses/copilot/copilot-harness-integration.md"><img alt="GitHub Copilot" src="https://img.shields.io/badge/Copilot-181717?logo=githubcopilot&logoColor=white" /></a>
</p>
<br />

<p align="center"><a href="https://github.com/karlorz/codex-host/releases"><strong>下载</strong></a> · <a href="#跨-agent-协作">跨 Agent 协作</a> · <a href="#远程连接-harness">远程连接</a> · <a href="#加入交流群">微信交流群</a> · <a href="../../README.md">English</a> · <a href="README.ko.md">한국어</a></p>

<br />

</div>

## 赞助

<details open>
<summary>点击收起</summary>

<table>
<tr>
<td width="180"><a href="https://vibeapi.cc/sign-up?aff=AOYp"><img src="../imgs/sponsors/vibeapi.jpg" alt="VibeAPI" width="160"></a></td>
<td>感谢 <b>VibeAPI</b> 赞助本项目！VibeAPI 主要面向重度开发者与团队，提供主流 AI 模型统一接入。主打 Codex 与 Claude 系列，坚持自建号池可溯源。首流响应极速，SLA 稳定性达 99.9%，缓存命中率高达 95%+。提供 7×24 小时人工技术支持，全面支持对公开票与企业合作。<a href="https://vibeapi.cc/sign-up?aff=AOYp">点此前往薅赛博鸡蛋</a></td>
</tr>
</table>
</details>

## 界面预览

无需切换应用，**Pi、Claude Code、Grok Build 等十余个 Harness** 都可以在同一个 Codex Desktop 窗口中直接使用。

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### 界面

<div align="center">
  <img width="90%" src="../imgs/codexhost-native-overview.png" alt="Claude Code、Pi、Grok Build、Oh My Pi 的会话运行在 Codex Desktop 中，并可使用 Diff 审查、Fork、Worktree 和 Agent 切换">
</div>

## 快速使用

**方式一：npm**（macOS / Windows / Linux）

```bash
npm install -g @karlorz/codexhost-cli
codexhost
```

**方式二：安装包**（macOS / Windows）

从 [Releases](https://github.com/karlorz/codex-host/releases) 下载对应平台的安装包。

> Linux 支持 x64 / ARM64，详见 [Linux 说明](../platforms/linux/linux.zh-CN.md)。

运行 `codexhost update` 可在终端检查并准备升级到最新版本。有更新时请先退出 Codex Desktop；准备完成后由后台更新器安装并重新启动 codexhost。已是最新版本时直接退出。

<details>
<summary>安装问题排查</summary>

**codexhost 启动失败，或 Codex 打开了但没有 codexhost 功能**

运行 `codexhost console`（Windows：开始菜单 →“codexhost console”），打开本地控制台 `http://127.0.0.1:4399/`。可以查看上次启动失败的原因、Codex Desktop 版本、Host Runtime 日志，并在 Codex 未运行时更新 codexhost。控制台随 codexhost 一起启动：安装包启动时自动在浏览器打开，终端启动时会输出访问地址。

**macOS：首次打开提示「应用无法验证」**

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

**Windows：使用绿色解压版 Codex Desktop**

1. 将 `CODEXHOST_INSTALL_ROOT` 设置为 Codex Desktop 的解压目录：

   ```powershell
   [Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
   ```

2. 完全退出 Codex Desktop，重新打开终端，再运行 `codexhost`。

</details>

### 功能介绍

<table>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>完整工作界面</strong><br /><sub>不同 Harness 的会话在同一个侧边栏里，输入框右下角随时切换 Agent</sub></p>
      <div align="center">
        <img width="90%" src="../imgs/codexhost-full-workspace.png" alt="Codex Desktop 中 codexhost 的完整工作界面，展示项目结构、对话区域和多个 Agent 选择器">
      </div>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Diff 审查面板</strong><br /><sub>每轮改动自动汇总，点「审核」在右侧查看完整 Diff</sub></p>
      <img src="../imgs/highlight-diff-review.png" alt="对话中的改动汇总卡片与右侧审查面板中的 Diff">
    </td>
    <td width="50%" valign="top">
      <p><strong>从任意消息 Fork</strong><br /><sub>在当前工作空间，或新建 Worktree 并行开发</sub></p>
      <img src="../imgs/highlight-fork-worktree.png" alt="从消息创建分支的菜单：在此工作空间或新工作树中创建分支">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>输入 # 委派给其他 Agent</strong><br /><sub>多个 Agent 各开独立会话，并行执行 · <a href="#跨-agent-协作">了解更多</a></sub></p>
      <img src="../imgs/highlight-delegation.png" alt="输入 # 选择 Codex、Claude Code、Grok 等 Agent，任务分别在独立会话中并行运行">
    </td>
    <td width="50%" valign="top">
      <p><strong>工具调用与思考过程</strong><br /><sub>每次 edit、命令、思考都可展开查看细节</sub></p>
      <img src="../imgs/highlight-tool-details.png" alt="展开编辑记录后显示新建文件的 Diff">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Subagent 可见</strong><br /><sub>每个 Subagent 有独立图标，可在右侧查看完整对话</sub></p>
      <img src="../imgs/highlight-subagent.png" alt="主对话中显示 4 个 Subagent 的状态，右侧打开其中一个的完整对话">
    </td>
    <td width="50%" valign="top">
      <p><strong>远程开发</strong><br /><sub>把 VPS 添加为项目，Agent 直接在远程机器上执行 · <a href="#远程连接-harness">了解更多</a></sub></p>
      <img src="../imgs/highlight-remote.png" alt="侧边栏中的远程 VPS 项目，对话返回远程机器的工作目录">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>用量一目了然</strong><br /><sub>缓存命中率、费用估算、上下文占用实时显示</sub></p>
      <img src="../imgs/highlight-usage.png" alt="用量浮层：上下文、缓存命中率、缓存读写、Token 总数、费用估算">
    </td>
    <td width="50%" valign="top">
      <p><strong>账号一键导入</strong><br /><sub>本机已登录的 Codex、Grok 凭证一键复制给 Pi，额度实时可见</sub></p>
      <img src="../imgs/highlight-account-import.png" alt="账号设置页：账号的 5 小时与 7 天剩余额度，以及已导入 Pi 的账号">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid 图表可视化渲染</strong><br /><sub>左：Codex Desktop + Pi，图表直接渲染；右：Pi TUI，只能看到源码</sub></p>
      <img src="../imgs/codex-vs-pi-agent-tui.png" alt="Pi + Codex Desktop 与 Pi Agent TUI 的 Mermaid 图表可视化渲染对比">
    </td>
  </tr>
</table>


## 功能状态

此矩阵描述本 fork 的外部 Harness 在 Codex Desktop 中的接入，包括原生界面与共享 codexhost 提问卡片。支持范围取决于插件原生协议、所需补丁及已验证的 Desktop 行为；限制见下方说明。

<details>
<summary>查看完整功能矩阵</summary>

| 能力 | <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/-000000?logo=pi&logoColor=white" /></a> | <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="../imgs/harness-icon-omp-v5.svg" /></a> | <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/-D97757?logo=claudecode&logoColor=white" /></a> | <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="../imgs/harness-icon-opencode.svg" /></a> | <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/-000000?logo=x&logoColor=white" /></a> | <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH" src="https://img.shields.io/badge/-4D6BFE?logo=deepseek&logoColor=white" /></a> | <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="../imgs/harness-icon-agy.svg" /></a> | <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="../imgs/harness-icon-codebuddy.svg" width="24" height="24" /></a> | <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="../../packages/adapters/workbuddy/assets/icon.svg" width="24" height="24" /></a> | <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="../imgs/harness-icon-cursor.svg" /></a> | <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="../imgs/harness-icon-hermes.svg" /></a> | <a href="https://qoder.com/cli"><img alt="Qoder" src="../../packages/adapters/qoder/assets/icon.svg" width="28" height="28" /></a> | <a href="https://moonshotai.github.io/kimi-code/"><img alt="Kimi Code" src="../../packages/adapters/kimi-code/assets/icon.svg" width="28" height="28" /></a> | <a href="../harnesses/copilot/copilot-harness-integration.md"><img alt="Copilot" src="../../packages/adapters/copilot/assets/icon.png" width="28" height="28" /></a> |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 流式回复 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工具状态 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 提问 / 取消 | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Model / Thinking 选择 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工具审批 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 权限模式 | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Agent 间任务协作 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Usage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| Fork | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ |
| 上下文压缩 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| 斜杠命令 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| 修订上一条消息 | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 原生目标生命周期 | ? | ? | ? | ? | ◐ | ✅ | ? | — | — | ? | ? | ? | ? | ? |
| Shared goal panel | — | — | — | — | ◐ | — | — | — | — | — | — | — | — | — |
| Host-managed goals | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 模型创建目标 | ? | ? | ? | ? | — | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| 实时语音 | ? | ? | ✅ | ? | ◐ | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| 多选提问 | — | ◐ | ◐ | ◐ | ✅ | ◐ | — | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ |
| 提问超时倒计时 | — | — | — | — | ◐ | — | — | — | — | — | — | — | — | — |
| 提问交互重置超时 | — | — | — | — | ◐ | — | — | — | — | — | — | — | — | — |
| 子代理 | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | ◐ | — | — | — | — |
| Computer Use / 内置浏览器 | — | — | — | — | ◐ | — | — | — | — | — | — | — | — | — |
| 生成图片 | — | — | — | — | ◐ | — | — | — | — | — | — | — | — | — |

图例：✅ 已接入 · ◐ 部分接入、降级或仅保存意向 · — 当前插件未投影该能力 · ? 未验证。

- **Native goals and Grok editing**: Grok implements the shared native-goal bridge and independent background worker observation; ◐ retains pending installed Desktop lifecycle acceptance. DSH's ✅ describes its existing native command lifecycle, not shared-panel parity. ZCode has typed native controls/background ownership, but its shared-panel accounting remains unqualified. Unsupported shared goal RPCs fail explicitly; no Host-managed scheduler or official goal-tool injection is enabled. Other ? cells remain unverified. Grok editing uses conversation-only native rewind. See [Native goal bridge](../architecture/harness-goals.md).
- **Grok goal boundaries**: Desktop `/goal` and `/grok-goal` create native goals; ordinary natural-language requests cannot create one on the qualified native build. Real background responses retain native history/checkpoints. Goal helpers have final read-only child transcripts; their links wait for confirmed parent identity, and post-terminal helpers appear on reopen. Child transcript streaming is unclaimed. Goal/helper changes retain pending installed Desktop acceptance; the goal cells remain ◐.
- **实时语音**使用本 fork 按 Desktop 版本审计的 hook 与已配置的 gateway。Host 的 `thread/realtime/*` 和新会话继承所选 Harness 的路径是通用的。Claude Code 有已记录的有人值守 Desktop 通话；Grok 标为 ◐，因为验证覆盖真实 gateway 通话和公共插件的隔离 Host 试验，尚不等于已安装 Desktop 按钮验收。其他 Harness 未验证（?）。详见 [CPA live-voice Desktop hook](../operations/cpa-live-voice-desktop-hook.md)。
- **多选提问**：Adapter 发出 `multiple: true` 时使用共享 codexhost 复选框卡片，选中值以数组回传；允许 Other 的单选组也使用 Composer 上方的共享卡片，保留普通聊天输入框；其他单选/文本组仍使用原生 Desktop 卡片。Grok 保留原生多选标记及全部选中标签。共享 Host/浏览器路径有回归测试，安装版 Desktop 人工测试已同时回传 Alpha 与 Beta。其他 Adapter 的原生多选全链路未验证时仍标为 ◐。OMP 使用独立单选/文本交互；Pi 固定单选，Antigravity 拒绝多选。详见 [Grok 原生提问](../harnesses/grok/questions.md)、[Antigravity 提问交互复盘](../harnesses/antigravity/antigravity-question-interaction-postmortem.md) 与 [OMP 交互](../harnesses/omp/omp-interactions.md)。
- **提问倒计时与活动重置**目前仅由 Grok 插件在共享提问卡片上提供。纯文本问题组保留原生 Desktop 卡片，不显示该倒计时或转发该活动。倒计时需 grokgod 补丁 `0027`；确认式重置还需 `0028` 与原生 `timeout_reset_on_activity = true`。两行因界面与构建限制标为 ◐，其他插件目前未提供（—）。这些行描述外部 Harness 接入，不代表原生 Codex 模型提问工具的能力。详见 [Grok 原生提问](../harnesses/grok/questions.md)。
- **Grok 构建与提问**：本 fork 使用补丁版 **grokgod Grok build**；补丁依赖行为不能视为 stock Grok 的能力保证。Host 独立处理原生 `_x.ai/ask_user_question`，与 MCP 同意审批分开，支持单选、文本、Other 与多选答案。提问 / 取消仍标为 ◐，因为原生 Plan 专属操作仍受限。补丁 `0011-ask-question-timeout-action` 管理可配置的原生超时选择/重置；Host 不自设 Grok 计时器或自动作答。只读倒计时额外依赖 grokgod 补丁 `0027-ask-question-timeout-metadata`；未提供原生截止时间的构建不显示倒计时。活动重置及倒计时同步额外依赖 `0028-ask-question-activity-ack` 与原生 `timeout_reset_on_activity = true`；可信卡片交互及后续窗口重新获得焦点会重置原生时限，显示跟随原生确认更新；悬停与首次显示不重置。详见 [Grok 原生提问](../harnesses/grok/questions.md)。
- **Grok MCP 审批 — Always allow**依赖 grokgod 补丁 `0025-mcp-elicitation-persist`，转发原生 persist 选项，并将选中的范围作为 MCP `_meta.persist` 回传。只有请求包含 `always` 时 Desktop 才提供该选项；未打补丁的 Grok 只有 Allow once / Deny。原生 session 生命周期尚未核实，因此不提供 Allow this conversation。详见 [Grok MCP elicitation](../harnesses/grok/mcp-elicitation.md)。
- **子代理**：✅ 原生状态加只读子 Transcript · ◐ 只有原生状态。Pi 需要受支持的 `pi-subagents` 扩展协议；OMP 需要 RPC 子代理订阅支持。这些单元格描述插件投影，不表示上游 Harness 内部能否运行子代理。
- **Computer Use / 内置浏览器**使用用户安装的 Grok `cua_repl` MCP。本 fork 的 Computer Use 接入依赖补丁版 grokgod Grok build 的 `0026-cua-turn-end-release`，包括回合边界清理和 Mac Sky 原生释放桥，以及已安装的 ChatGPT Computer Use runtime；未证明 stock Grok 具备同等行为。IAB 仅保存意向：Host 保持浏览器绑定关闭，等待 Desktop 授权和会话所属的浏览器路由。详见 [Grok Computer Use 设置](../harnesses/grok/computer-use-settings.md)。
- **生成图片**描述 Grok Imagine 到 Desktop `imageGeneration` 的投影，不是一般的图片文件生成。Grok 是当前唯一发出此 Item 的 Adapter；其他单元格表示没有专门的画廊投影。投影有测试覆盖，但真实画廊展示仍未验证。详见 [Grok 生成图片](../harnesses/grok/generated-images.md)。

</details>

## 跨 Agent 协作

在聊天输入框输入 `#`，可以选择要委派任务的 Agent，也可以查找当前所选 Harness 可用的命令和技能。

你可以让当前 Agent 把独立任务交给另一个 Harness。例如：

> 让 `claude-code` 独立审查这次修改，并指出兼容性风险。
>
> 让 `pi` 调查这个测试为什么偶发失败。
>
> 让 `omp` 实现这个功能，我继续整理文档。
>
> 让 `opencode` 在独立 Thread 中验证这个修复，并运行相关测试。

CodexHost 会为目标 Harness 创建独立的 Native Session。委派会话将出现在 Codex Desktop 的会话列表中，你可以随时打开、查看进度或继续对话。

<details>
<summary><h3 id="远程连接-harness">远程连接 Harness</h3></summary>

在本机 Codex Desktop 中使用被控机器上的 Harness，任务在被控机器执行，界面仍在本地。两端需安装相同版本的 codexhost。

| 被控机器 | 连接方式 |
| --- | --- |
| macOS / Linux | [SSH 远程](#ssh-远程) |
| Windows | [Remote Control 远程](#remote-control-远程实验)（实验） |

#### SSH 远程

前提：已在 Codex Desktop「设置 → 连接 → SSH」中添加被控机器。客户端支持 macOS / Linux / Windows。

<div align="center">
  <img width="70%" src="../imgs/remote-ssh-connections.png" alt="Codex Desktop 设置 → 连接 → SSH 页面中已添加的 SSH 连接">
</div>

1. 在被控机器上安装并启动：

   ```bash
   npm install -g @karlorz/codexhost-cli
   codexhost remote install
   codexhost remote start
   codexhost remote status
   ```

2. 在本地通过 codexhost 启动 Codex Desktop，打开 SSH 工作区。
3. 在输入框的 Agent / Model 选择器中选择目标 Harness。

[SSH 配置、诊断与卸载 →](../platforms/remote/remote-ssh-host.zh-CN.md)

#### Remote Control 远程（实验）

复用 Codex Desktop 官方 Remote Control 的配对与认证，在另一台电脑上使用 Windows 上的 Harness。

前提：官方 Remote Control 已能正常运行 Codex 任务。不新增公网服务或端口，Harness 凭据只保留在 Windows 上。

[Remote Control 配置、传输边界与诊断 →](../platforms/remote/remote-control-host.zh-CN.md)

</details>

<details>
<summary><h3>怎么做的</h3></summary>

多数「多 Agent 客户端」会自己重做一套聊天界面，再用统一协议接入不同 Harness。

CodexHost 的做法不同：

- **Desktop 侧**：通过 CDP / Electron Inspector 增强官方 Codex Desktop，不重做聊天界面，也不修改官方安装包
- **协议侧**：通过 CLI Shim 接入官方 app-server，原生 Codex 请求原样转发，不受影响
- **Harness 侧**：优先使用各自的原生接口（Pi 走 RPC，Claude Code 走 Agent SDK），没有原生接口的通过 [ACP](https://agentclientprotocol.com/) 接入；流式输出、工具状态、Diff 和审批投影到 Codex Desktop 原生界面；提问根据字段使用原生 Desktop 卡片或共享 codexhost 卡片，详见功能状态
- **编排侧**：委派任务在目标 Harness 中作为独立的原生会话运行，发起方可以选择等待结果或让它在后台运行

</details>

<a id="加入交流群"></a>

## 微信交流群

<table align="center">
  <tr>
    <td>
      <strong>微信交流群</strong><br />
      <sub>对 CodexHost 用法、功能感兴趣的开发者可以扫码添加我的微信（备注“CodexHost”），我拉你进微信群交流。</sub>
      <ul>
        <li><sub>安装问题可以加群询问</sub></li>
        <li><sub>功能建议与反馈</sub></li>
        <li><sub>开发问题讨论</sub></li>
        <li><sub>Bug 问题建议提交 <strong>issue</strong></sub></li>
      </ul>
      <sub><strong>欢迎一起贡献~ </strong></sub>
    </td>
    <td align="center">
      <img width="230" alt="微信二维码" src="../imgs/wechat-contact-qrcode.jpg" />
    </td>
  </tr>
</table>

## 开发

提交 Issue 或 PR 前可阅读[贡献说明](../../CONTRIBUTING.md)；PR 标题标签、简短 CI 结果和发布前校验见[仓库维护自动化](../operations/repository-maintenance.md)。

环境要求：官方 Codex Desktop、Node.js 22.19+ 或 24、Rust。

```bash
git clone https://github.com/karlorz/codex-host
cd codex-host
npm ci
npm start
```

可用 `npm start 0.12.0` 指定当前源码的运行版本，也支持 `0.13.0-rc.1` 等预发布版本。Host 状态、控制台版本和更新检查中的当前版本统一使用这个值。不传参数时仍为 `<仓库版本>-dev`；构建一次后，可用 `npm start 0.12.0 -- --no-build` 复用构建产物。参数只对本次启动生效，不修改版本文件、不发布 npm 包。源码安装仍不具备发行包的自更新资源；远程 npm 安装下载的是该版本已发布的包，不是本地源码。


### 运行架构

以 Pi 为例。从左到右是一次请求的调用链：Desktop → 公共层 → Pi 插件 → 原生进程。

<div align="center">
  <img width="100%" src="../imgs/pi-runtime-architecture.png" alt="以 Pi 为例的运行架构：Desktop 到公共层，再到 Pi 插件和原生进程">
</div>

### 新增 Harness

主要实现插件的 Manifest、工厂、Adapter、Session 及原生通信与转换逻辑。当前 Renderer 仍有静态接线，完整 Desktop 接入还需单独处理。
新增 Harness 时，可以让编码 Agent 使用仓库内的 [codexhost-add-harness Skill](../../.agents/skills/codexhost-add-harness/SKILL.md)。它说明了插件结构、公共 Adapter 接口、能力实现与测试要求。

Desktop Grok Thread 通过 Grok 官方 ACP `session/new` 的 `_meta.rules` 接收 CodexHost 会话规则。Host Runtime 会回收仍匹配历史摘要的 `~/.grok/rules/codexhost-desktop.md`，并保留用户改过的副本。新 Harness 插件不要再写 home rule。说明见 [operations/cpa-live-voice-desktop-hook.md](../operations/cpa-live-voice-desktop-hook.md)。

## 鸣谢

- 感谢 [LINUX DO](https://linux.do/) 社区一直以来的支持。
- 感谢 [Paseo](https://github.com/getpaseo/paseo) 项目在多 Harness 接入思路与架构设计方面带来的启发与参考。

## 贡献者

感谢所有为 CodexHost 做出贡献的开发者。

<a href="https://github.com/karlorz/codex-host/graphs/contributors">
  <img alt="CodexHost 贡献者" src="https://contrib.rocks/image?repo=karlorz/codex-host" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=bytepioneer-ai%2Fcodex-host&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
  </picture>
</a>
