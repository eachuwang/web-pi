---
id: map
type: map
status: open
title: web-pi — 脱离 pi TUI 的 web 前端 + dashboard 监控
created: 2026-07-20
---

# web-pi wayfinder map

> 本图存在的理由:开发 web-pi 的 agent 会话上下文跨 session 易失。把 vision 与
> 路线从「agent 易失上下文」搬到「repo 持久 artifact」,任何 session 都能对着图推进。

## Destination

一个**开源、可脱离 pi TUI 独立使用**的 web 前端 + 监控 dashboard:本地自跑
(127.0.0.1,单用户),换设备能迁移配置,带多会话/持久化/真实监控。图到头 = 这些
开放决策逐一收敛,路清晰到可直接施工。

## Notes

- **领域**:基于 `@earendil-works/pi-coding-agent` SDK 的 in-process AgentSession web 宿主。
- **每个 session 应参考**:pi 官方 repo https://github.com/earendil-works/pi ;本仓库已装的
  SDK 在 `node_modules/@earendil-works/pi-coding-agent`(类型定义在 `dist/**/*.d.ts`)。
- **本项目无 CLAUDE.md** —— 后续应建立(用户全局规范要求:新项目先写 CLAUDE.md)。
- **standing preferences**:开源、跨设备可迁移、无硬编码 key、安装须跨平台顺畅(已踩
  rollup 原生包 + .bin 权限坑,新功能避免引入原生依赖;确需时配 env/fallback 兜底)。
- **tracker**:local-markdown(`.wayfinder/`)。blocking 用 frontmatter `blocked-by`。
  frontier = `status: open` + `blocked-by: []` + `assignee:` 空。
- **chart 阶段已确认的现状判定**:web-pi 相对 pi TUI =「平价但缺关键块」(multi-session、
  持久化、真 dashboard 是脱离 TUI 的真正增量)。

## Decisions so far

<!-- 一行一 closed ticket,够判断相关性即可,详情 zoom 票本身 -->

- [D01 模型供应商配置策略](tickets/D01-model-provider-configuration.md) — web-pi **自包含**:不依赖 pi CLI、不读 `~/.pi/agent`;自有 `~/.web-pi/config.json`(非敏感)+ `~/.web-pi/credentials.json`(0600 明文 key,pi 惯例);启动时 `registerProvider`+`setRuntimeApiKey` 注入 SDK;env 作 override。(G04 翻盘:撤 keychain/keytar,改明文文件跟 pi 一致;路径 `~/.web-pi/`。)
- [R01 预设供应商清单](tickets/R01-preset-providers.md) — 22 个 api_key 预设写入 `research/preset-providers.md`;**SDK 无 DashScope**(GLM 走 `zai-coding-cn`,Alibaba 走 `ant-ling`);`openai-codex` OAuth-only,`anthropic`/`xai`/`github-copilot` 需 key+OAuth 双 UX。
- [R02 SDK dashboard/replay 面](tickets/R02-sdk-dashboard-replay-surface.md) — `getSessionStats()` 拿齐 token/cost/toolCalls/contextUsage;队列/在途/thinking SDK 都有(server.ts 缺路由)。**在途回放可行**:snapshot API(`streamingMessage`/`pendingToolCalls`/`messages`)+ 续订 SSE,不靠重放;唯一盲区 = tool 增量 stdout(partialResult)刷新丢,结构信息 0 丢失。
- [G01 多会话架构](tickets/G01-multi-session-architecture.md) — 左侧边会话列表;并发多会话同时流(软上限默认 4,设置页/env 可调);独立 session id(多会话可共享 cwd);首条消息自动标题 + cwd 角标可重命名。后端 `holder.runtime` 单例 → session-id-keyed map。
- [G03 设置页 scope 与 UX](tickets/G03-settings-page-scope.md) — scope=模型配置+max-sessions(thinking 用现有按钮);本期只做 key 路径(预设+自定义,自定义可加多个,DashScope 由自定义兜底);model 填 key 后「拉取/测试」(`getAvailable`)填下拉+手填兜底;改配置默认只对新会话,显式「重载供应商」推到运行中;右侧非模态抽屉(与聊天并存)。OAuth 留后→G06。
- [G02 dashboard 目的与监控指标](tickets/G02-dashboard-purpose-metrics.md) — 会话级实时健康+轻量成本;primary=contextUsage%+本turn token+累计 cost+队列/在途 tool(secondary 收进展开);右侧 dash=Context+Queue(补 pendingToolCalls)+新 Cost/Tokens,撤 Sessions 面板(归 G01 左侧栏);per-session cost 读 `getSessionStats()` + 持久化 odometer `~/.web-pi/usage.json`。
- [G04 开源发布形态与就绪清单](tickets/G04-open-source-readiness.md) — web-pi **自包含**(不依赖 pi CLI/`~/.pi`,SDK 作 npm 依赖);源码+npm 为主、Docker 次选;配置 `~/.web-pi/`;**api_key 明文 0600 文件(pi 惯例,撤 keytar)**;Hono `:3000` 托管 dist/+API(SPA fallback);MIT license + CI,稳定后再发 npm。带出 D01 翻盘(撤 keychain/pi fallback、路径改 `~/.web-pi/`)。
- [G05 会话重连回放范围](tickets/G05-reconnect-replay-scope.md) — 全回放:历史 + 在途 streamingMessage(回放到当前已生成 blocks)+ pendingToolCalls(标 running)+ queue(steer/followUp)+ partialResult ring-buffer(server 端每在途 tool 最近 ~50 行,重连补发,tool 结束清)。闭环「上下文丢」痛点。

## Not yet specified

<!-- 见「Fog of war」:在 scope 内但还无法精确成票的暗区。随 frontier 推进毕业成票。 -->

<!-- 当前无未票化 fog。剩 G05(回放范围)、G06(OAuth)两张 open 票待推进;
     开源发布形态 fog 已由 G04 毕业收敛。 -->

<!-- 已毕业的 fog(各归其票):
  - dashboard 监控什么给谁看 → G02。
  - 会话持久化范围 → G05。
  - 多会话 UI 形态 / 上限 → G01。
  - 设置页双 auth UX / DashScope 缺口 → G03。
  - 开源发布形态 → G04。
-->

## Out of scope

<!-- 图止于 destination;此处记被有意识排除的工作,闭票不进 Decisions so far。 -->

- (暂无)
