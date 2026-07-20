---
id: G02
type: grilling
status: closed
assignee: agent
blocked-by: []
created: 2026-07-20
resolved: 2026-07-20
title: dashboard 目的与监控指标
---

## Question

web-pi 现有 Context / Queue / Sessions 仪表盘。脱离 TUI 后 dashboard 到底**给谁看、
看什么**?开源他人用 vs 个人自用,诉求不同(成本预算?上下文窗口耗用?队列?会话
健康度?)。收敛监控指标集与每项的呈现方式。

## Notes

- ~~blocked by R02~~:R02 已闭,unblock。R02 证实指标 SDK 几乎全有 → 本票聚焦
  「选哪些、给谁看、怎么呈现」,而非「能不能拿到」。
- 可用指标(来自 R02):token(input/output/cacheRead/cacheWrite/total)、cost、
  toolCalls、消息计数、contextUsage、队列深度、在途 tool、thinking 长度。
- HITL grilling 票。

## Resolution

2026-07-20 grilling 与用户确认,四个子决策:

1. **职责 = B**:会话级实时健康为主 + 轻量成本累计为辅。日常用看健康,开源用户看花了多少。
2. **指标 = B(primary + secondary)**:primary = contextUsage% + 本 turn token
   (in/out)+ 累计 cost + 队列/在途 tool;secondary(cache token、toolCalls 计数、消息数)
   收进「详情」展开,不占主面。
3. **布局 = B**:右侧 `<aside className="dash">` = Context(已有,contextUsage+进度条)
   + Queue(补 `pendingToolCalls`,现只显 steer/follow)+ 新 Cost/Tokens 面板;**撤掉右侧
   Sessions 面板**(归 G01 左侧边栏)。当前活跃会话指标板。与 G03 右侧设置抽屉同居右侧、
   互斥/并排(TBD 执行时定)。
4. **成本 scope = B**:per-session cost 直接读 `getSessionStats()`(零额外持久化)+ 持久化
   跨会话总 odometer(`~/.pi/web-pi/usage.json`,turn 结束累加一个数,左侧栏顶显示)。
   不做按 provider/按日分摊(那是重分析,已排除)。

**事实依据**:现状右侧 dash 三块(Context/Queue/Sessions),Context 已满足 primary;
Sessions 面板与 G01 冲突须撤;缺 cost、pendingToolCalls、本 turn token。

**结论**:dashboard 决策已齐。衍生执行(不在图内):补 Cost/Tokens 面板 + Queue 加
pendingToolCalls + 撤 Sessions 面板 + usage.json odometer + `/api/usage`。
