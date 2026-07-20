# SDK 可观测面 & 在途流回放可行性

调研对象:`@earendil-works/pi-coding-agent@0.80.10`(及其传递依赖 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`)。
所有路径均相对 `node_modules/@earendil-works/pi-coding-agent/`。

## (a) Dashboard 可用指标清单 + SDK 来源

### 一次性聚合 API(已由 `/api/stats` 暴露,无需自己累加)

`AgentSession.getSessionStats(): SessionStats` —— `dist/core/agent-session.d.ts:149-167`、实现 `dist/core/agent-session.js:2460-2514`。聚合范围:**全部分支历史(含已被 compaction 折叠掉的 entry)**,因此 token/cost 反映整 session 实际计费。返回字段:

| 指标 | SessionStats 字段 | 底层来源(每条 assistant 消息的 `usage`,见下) |
|---|---|---|
| token input | `tokens.input` | `assistantMsg.usage.input` |
| token output | `tokens.output` | `assistantMsg.usage.output` |
| cached token read | `tokens.cacheRead` | `assistantMsg.usage.cacheRead` |
| cached token write | `tokens.cacheWrite` | `assistantMsg.usage.cacheWrite` |
| token total | `tokens.total` | `input+output+cacheRead+cacheWrite` |
| cost($) | `cost` | 累加 `assistantMsg.usage.cost.total` |
| 上下文窗口占用 | `contextUsage?: ContextUsage` | `getContextUsage()` 结果(见下) |
| tool 调用计数 | `toolCalls` | `assistant.content.filter(c=>c.type==="toolCall").length` 求和 |
| user/assistant/toolResult 消息计数 | `userMessages` / `assistantMessages` / `toolResults` / `totalMessages` | 遍历 `sessionManager.getEntries()` |

**注意:`getSessionStats()` 只累加「已落盘」的 assistant 消息(turn 结束 `message_end` 触发 `sessionManager.appendMessage` 后才计入)。在途 turn 的 streaming 消息不计入。**

### 上下文窗口(实时,非聚合)

`AgentSession.getContextUsage(): ContextUsage | undefined` —— `agent-session.d.ts:593`、实现 `agent-session.js:2515-2555`。返回 `{ tokens: number|null, contextWindow: number, percent: number|null }`。
- `contextWindow` = `model.contextWindow`(Model 定义自带,见 `pi-ai` Model 类型)。
- `tokens` = `estimateContextTokens(this.messages).tokens`(compaction/compaction.js:108):优先取最后一条非 aborted/error assistant 消息的 `usage.totalTokens || input+output+cacheRead+cacheWrite`,再对其后追加的消息用 chars/4 启发式估算。
- 刚 compaction 完、下一条 LLM 响应未到时返回 `tokens: null`。
- **SDK 有,完全可暴露。** 已在 `/api/stats` 的 `contextUsage` 字段里。

### 队列深度(steering / follow-up 待处理消息)

- `session.pendingMessageCount: number` —— `agent-session.d.ts:409`。
- `session.getSteeringMessages(): readonly string[]` —— 插入时即正在进行的 turn;turn 结束后会被消化。
- `session.getFollowUpMessages(): readonly string[]` —— turn 完全空闲后才会消化。
- 事件 `queue_update { steering, followUp }` —— `agent-session.d.ts:49-52`,队列变化时推送。
- **SDK 有,但 server.ts 当前未暴露**(grep 无 `/api/queue` 路由)。Dashboard「待处理消息数」需新增路由。

### 在途 tool 调用(pending tool calls)

- `session.state.pendingToolCalls: ReadonlySet<string>` —— `pi-agent-core/dist/types.d.ts:301`,内容是 toolCallId 集合。`tool_execution_start` 加入,`tool_execution_end` 移除(`agent.js:381-391`)。
- `session.state.streamingMessage?: AgentMessage` —— 当前正在生成的 assistant 消息(见 (b))。
- `session.isStreaming` / `session.isIdle` / `session.isCompacting` / `session.isRetrying` / `session.isBashRunning` / `session.hasPendingBashMessages` —— 一组状态 flag,`agent-session.d.ts:278-280, 303, 545-547, 514`。
- **SDK 有。** 但 server.ts 的 `/api/events` 只在 `session_init` 帧里带了 `streaming: s.isStreaming`,没带 `pendingToolCalls` 或 `streamingMessage`。

### thinking 长度

- thinking 内容本身是 assistant 消息 `content` 数组里 `type: "thinking"` 的 block(`pi-ai/dist/types.d.ts:281` `AssistantMessage.content = (TextContent | ThinkingContent | ToolCall)[]`)。
- token 级别的「reasoning tokens」由部分 provider 上报:`usage.reasoning?: number`(`pi-ai/dist/types.d.ts:262`,注释明确说明「是 `output` 的子集」)。
- **SDK 有,但非显式 API**:dashboard 想「本 turn thinking 字符数」需要自己扫 `streamingMessage.content` 里 thinking block 的长度;「reasoning token 数」取 `usage.reasoning`(只在 turn 结束后落定)。

### AssistantMessage.usage / Cost 字段定义(供参考)

`pi-ai/dist/types.d.ts:251-272`:

```
interface Usage {
  input, output, cacheRead, cacheWrite: number;
  cacheWrite1h?: number;          // Anthropic 专有,cacheWrite 子集
  reasoning?: number;             // thinking token,output 的子集
  totalTokens: number;
  cost: { input, output, cacheRead, cacheWrite, total: number };  // 美元
}
```

每条 assistant 消息自带 `usage: Usage`(`types.d.ts:288`)。**SDK 有,来源清晰。**

### 小结:dashboard 指标覆盖

| 指标 | SDK 有/无 | 推荐 API |
|---|---|---|
| token input/output/cached | ✅ 有 | `getSessionStats().tokens` |
| cost | ✅ 有 | `getSessionStats().cost` |
| 上下文窗口 used/total | ✅ 有 | `getSessionStats().contextUsage` 或 `getContextUsage()` |
| 队列深度 | ✅ 有 | `pendingMessageCount` / `getSteeringMessages()` / `getFollowUpMessages()`(**server.ts 未暴露,需加路由**) |
| tool 调用计数 | ✅ 有 | `getSessionStats().toolCalls`(累计)/ `state.pendingToolCalls`(在途) |
| thinking 长度 | ⚠️ 半有 | 扫 `streamingMessage.content` 的 thinking block;token 级取 `usage.reasoning` |

## (b) 在途流回放可行性

**结论:Yes,在途 turn 状态可从 AgentSession 重建,不必依赖 SSE 重放。** 但有一处盲区(见末段)。

### SDK 暴露的在途状态

`AgentState`(`pi-agent-core/dist/types.d.ts:279-304`)的几个关键字段在 turn 进行中是「活的」:

- `streamingMessage?: AgentMessage` —— 当前正在生成的 assistant 消息。
  - 生命周期:`message_start` → 设为该 message;`message_update` → 更新为最新版本(随 token 累积);`message_end` → **清空并 push 进 `state.messages`**(`agent.js:371-379`)。
  - 内容即标准 `AssistantMessage`:`content: (TextContent | ThinkingContent | ToolCall)[]` —— 已生成的文本块、thinking 块、toolCall 块都在里面,**block 级可见**,不是黑盒。
- `pendingToolCalls: ReadonlySet<string>` —— 正在执行的 toolCallId 集合。
- `isStreaming: boolean` —— 整个 run 是否还活着(直到 `agent_end` 的 awaited listeners 跑完)。
- `messages: AgentMessage[]` —— **已落定**的对话历史(不含 streamingMessage)。turn 进行中,本 turn之前的全部消息都在这里;本 turn 的 streaming 消息在 `streamingMessage` 里。
- `errorMessage?: string` —— 最近一次 aborted/error turn 的错误。

### 队列状态(steering / follow-up)

`session.getSteeringMessages()` / `getFollowUpMessages()` / `pendingMessageCount` 直接可读,`queue_update` 事件也会推送快照。turn 进行中用户后续输入会进这两个队列,重连后可完整还原。

### 重建路径(浏览器重连后)

1. `GET /api/messages` 重建「已落定历史」(server.ts:150 已有,但只取 user/assistant;可扩展到 toolResult)。
2. 新增 `GET /api/in-progress`(或扩展 `/api/messages`):
   - `streaming: session.isStreaming`
   - `streamingMessage: session.state.streamingMessage`(序列化其 content blocks)
   - `pendingToolCalls: [...session.state.pendingToolCalls]`
   - `queue: { steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() }`
   - `isCompacting / isRetrying / isBashRunning` 等子状态 flag
3. 前端拿到后,把 `streamingMessage` 当作「进行中的 assistant 气泡」渲染,接上后续 SSE 事件流即可继续增量更新。

### 盲区(需要的话再考虑)

`tool_execution_update` 事件的 `partialResult` 是 tool 执行过程中的中间输出(如 bash 命令的增量 stdout)。**该字段只走 SSE,不进入 `state`**(agent.js 里 `tool_execution_update` 不改任何 state)。浏览器在 tool 执行中途刷新,会丢这部分中间输出 —— 但 toolCall 本身仍在 `streamingMessage.content` 里(参数完整),`pendingToolCalls` 仍标记它在跑,tool 执行结束后的最终结果会通过 `tool_execution_end` → `message_end` 落定进 `messages`。换言之:**结构信息 0 丢失,只有 tool 的 streaming stdout 在刷新窗口内丢失**。要补齐需 server.ts 自己在内存里缓存每个 toolCallId 的 `partialResult` 序列(可选增强,SDK 不提供)。

### 不依赖 SSE 重放的原因

SSE `subscribe()` 只前向转发新事件(`server.ts:388`),不重放。但 AgentSession 进程长驻,`session.state` 始终可读 —— 重连后用「snapshot API + 继续订阅新事件」即可,不需要历史事件回放。README 现有限制(turn 中刷新丢在途流)本质是 server.ts 没暴露 snapshot,不是 SDK 不支持。
