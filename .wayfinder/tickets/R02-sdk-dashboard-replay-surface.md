---
id: R02
type: research
status: closed
assignee: agent
blocked-by: []
resolved: 2026-07-20
created: 2026-07-20
title: SDK 可暴露面 — dashboard 指标 & 在途流回放可行性
---

## Question

两个事实问题,决定 dashboard 票(G02)与持久化票(G03 持久化分支)能否票化:

1. **dashboard 指标来源**:AgentSession / ModelRuntime / AgentSessionEvent 流里,
   暴露了哪些可观测指标?token 用量(input/output/cached)、成本、上下文窗口占用、
   队列深度、tool 调用计数、thinking 长度 —— 各自从哪个字段拿?
2. **在途流回放可行性**:README 现有限制 = 「turn 进行中刷新丢在途流(SDK turn 结束
   才落盘,SSE 不重放)」。SDK 是否暴露 in-progress turn 的当前状态(已生成 blocks、
   tool calls)?重连后能否从 AgentSession 重建而非从 SSE 历史重放?

## Research plan

- 读 `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts`、
  `model-runtime.d.ts`、事件类型定义,找 stats/context/queue 相关 API 与事件 payload。
- 读 `src/server.ts` 现有 `/api/stats` 路由看已暴露什么,找 gap。
- 对回放问题:看 `AgentSession` 是否有 `getMessages` / in-progress state 查询,以及
  `/api/messages` 现有实现。
- 产出存 `.wayfinder/research/sdk-surface.md` 并在此票附 pointer。

## Acceptance

两段结论:(a) dashboard 可用指标清单 + 每项来源;(b) 在途回放 yes/no + 路径。
G02 / 持久化票据此毕业出具体范围。

## Resolution

详见 `.wayfinder/research/sdk-surface.md`。结论:

**(a) dashboard 指标**:SDK 基本全有。`AgentSession.getSessionStats()` 一调用拿齐
token(input/output/cacheRead/cacheWrite/total)、cost、累计 toolCalls、消息计数、
contextUsage(底层来自每条 assistant 消息的 `usage: Usage`)。队列深度
(`pendingMessageCount`/`getSteeringMessages`/`getFollowUpMessages`)、在途 tool
(`state.pendingToolCalls`)、thinking 长度(`streamingMessage.content` thinking block
+ `usage.reasoning`)SDK 都暴露。**唯一 gap**:`server.ts` 只暴露了 `/api/stats`
和 `/api/messages`,队列/在途状态无路由,需新增。

**(b) 在途回放**:**Yes,可重建,不靠 SSE 重放**。`AgentState.streamingMessage`
在 turn 进行中持有当前 assistant 消息的完整 content blocks(text/thinking/toolCall
可见,非黑盒),`pendingToolCalls` 标在跑的 tool,`messages` 给已落定历史,
`getSteering/FollowUpMessages` 给队列。AgentSession 进程长驻,重连 = 「snapshot API
+ 继续订阅新 SSE」。README 现限制是 server.ts 没暴露 snapshot,不是 SDK 不行。
**唯一盲区**:`tool_execution_update.partialResult`(tool 增量 stdout)是 SSE 专有、
不进 state,刷新窗口内会丢——但 toolCall 参数与最终结果都会落定,结构信息 0 丢失。

**毕业**:G02(dashboard)unblock,且指标几乎全有 → G02 聚焦「选哪些呈现给谁」;
持久化范围 fog 毕业为新票 G05(回放范围,含 partial-stdout 盲区这一开放决策)。
