---
id: G01
type: grilling
status: closed
assignee: agent
blocked-by: []
created: 2026-07-20
resolved: 2026-07-20
title: 多会话架构
---

## Question

web-pi 要「脱离 TUI」,TUI 一次一个会话,web 的增量是 multi-session。具体:

- 同时挂几个 AgentSession?上限是「每 cwd 一个」还是「任意 N 个 tab」?
- UI 形态:多 tab?侧边会话列表?每会话独立 cwd?
- 会话间隔离:每会话独立 cwd / 独立 model / 独立 thinking level?
- 后端 `holder.runtime` 目前是单例(`src/server.ts:72`),改多会话涉及哪些路由?

## Notes

- 这是 HITL grilling 票,一次一问,带推荐答案,与用户收敛后闭票。
- 上限子问题依赖形态先定(map Not yet specified 已记)。

## Resolution

2026-07-20 grilling 与用户确认,五个子决策:

1. **UI 形态 = B**:左侧边会话列表(每条会话有 cwd,顶部「+新会话」)。承接现有
   CwdPicker,扩展性好;不用多 tab(与浏览器 tab 撞车)。
2. **并发模型 = B1**:多会话同时流(真后台能力),软上限兜资源。后端 `holder.runtime`
   单例 → `Map<sessionId, runtime>`,SSE 按 sessionId 分流。
3. **会话身份 = B**:独立 session id,会话*有* cwd 但不限一个;多会话可共享同一 cwd
   (支撑「同 repo 一会话 debug / 一会话做 feature」)。现状 `SessionManager.create(cwd)`
   与 `/api/sessions` 是 cwd-keyed,需改 session-id-keyed。
4. **并发上限 = B**:默认 4,设置页 + `WEB_PI_MAX_SESSIONS` env 可调。
5. **命名 = B**:首条 user message 自动摘标题 + cwd 角标,可重命名。现有 CwdPicker
   已有 resume/delete,补「新建 + 重命名」闭环。

**毕业**:map「多会话 UI 形态 / 上限」fog 已全收敛进本票,从 Not yet specified 清除。
**衍生执行**(不在图内):session-id-keyed 后端重构 + 侧边列表 UI。
