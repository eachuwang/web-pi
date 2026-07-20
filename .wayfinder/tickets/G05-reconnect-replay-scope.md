---
id: G05
type: grilling
status: closed
assignee: agent
blocked-by: []
created: 2026-07-20
resolved: 2026-07-20
title: 会话重连回放范围
---

## Question

R02 证实:重连可从 `AgentState` snapshot(`streamingMessage` / `pendingToolCalls`
/ `messages` / `getSteering-FollowUpMessages`)+ 续订 SSE 重建,不靠 SSE 重放。
本票定**回放范围**:

- 已落定消息历史:回放(Yes,基本无争议)。
- 在途 streamingMessage(text/thinking/toolCall blocks):回放到当前已生成?
- pendingToolCalls:回放并在途 tool 标记为 running?
- 队列(steer/followUp):回放?
- **盲区决策**:`tool_execution_update.partialResult`(tool 增量 stdout)是 SSE
  专有、刷新丢。接受丢失(结构信息 0 丢,只丢增量 stdout),还是 server 端短期 ring-buffer
  最近的 partialResult 给重连补?权衡成本 vs 体验。

## Notes

- 毕业自 map「会话持久化范围」fog(R02 使之 specifiable)。
- 本票定范围;实现(server 新增 snapshot 路由 + 前端 reconnect 逻辑)走执行,不在图内。
- HITL grilling 票,优先 grill 盲区决策(partialResult buffer 与否)。

## Resolution

2026-07-20 grilling 与用户确认,两个子决策(R02 已证回放可行,故范围非争议):

1. **partialResult 盲区 = B(server ring-buffer)**:每个在途 tool 保留最近 ~50 行
   `tool_execution_update.partialResult`,重连时补发;有内存上限、tool 结束即清。闭环
   SDK 唯一不进 state 的盲区(tool 实时 stdout 刷新丢)。
2. **回放范围 = A(全回放)**:已落定消息历史 + 在途 streamingMessage(回放到当前已生成
   text/thinking/toolCall blocks,新 SSE 续接)+ pendingToolCalls(标记 running)+
   queue(steer/followUp)+ Q1 的 partialResult ring-buffer。重连 = 无缝续看。

**事实依据**(R02):`AgentState.streamingMessage`/`pendingToolCalls`/`messages`/
`getSteering-FollowUpMessages` snapshot 可重建,AgentSession 进程长驻,重连 = snapshot +
续订 SSE,不靠 SSE 重放。

**结论**:回放决策已齐,闭环用户最初「上下文丢」痛点。衍生执行(不在图内):server 新增
snapshot 路由(`/api/snapshot`)+ partialResult ring-buffer + 前端 reconnect 先拉 snapshot
再续 SSE。
