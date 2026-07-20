---
id: G03
type: grilling
status: closed
assignee: agent
blocked-by: []
created: 2026-07-20
resolved: 2026-07-20
title: 设置页 scope 与 UX
---

## Question

设置页(D01 策略已定)具体放什么、怎么交互?

- scope:仅模型配置(provider/baseUrl/key/model),还是也含 thinking 默认级、主题、
  cwd 书签、默认 agentDir?
- provider 配置:自定义供应商(填表)与预设供应商(选 R01 清单)如何并存?
- 新增 / 编辑 / 删除 provider 的交互;model 在 provider 下如何选(拉 `getModels`?)
  vs 手填。
- key 输入:填完写 keychain;keychain 不可用时 UI 如何提示走 env。
- 是否暴露「测试连接」按钮(调 `checkAuth` / `getAvailable` 验证)。

## Notes

- ~~blocked by R01~~:R01 已闭,unblock。R01 发现已并入下方新增子决策。
- 策略(D01)已定,本票只定 scope + UX,不定实现;实现走执行,不在图内。
- 可能衍生 prototype 票(先做粗糙页面给用户反应)。

## 新增子决策(R01 带出)

- **双 auth UX**:预设供应商分两类 —— 纯 api_key(22 个)与 OAuth-only / 双模
  (`openai-codex`、`anthropic`、`xai`、`github-copilot`)。设置页 UX 要同时容纳
  「贴 key」与「点登录」两条路径。grill:是否本期就做 OAuth,还是只做 key 类、OAuth 留后?
- **DashScope 缺口**:README 举例的「DashScope GLM」在 pi 内置里没有对应项。
  grill:改用 `zai-coding-cn`/`ant-ling`,还是本期就支持自定义 `registerProvider`
  让用户填一个 DashScope?

## Resolution

2026-07-20 grilling 与用户确认,六个子决策:

1. **scope = B'**:模型配置(provider/baseUrl/key/model)+ max-sessions。thinking 不入
   设置(已有控件行按钮实时改);主题/cwd 书签留打磨期。
2. **auth 路径 = B(本期只做 key)**:22 个 key 预设 + 自定义全走 key 路径;双模供应商
   (`anthropic`/`xai`/`github-copilot`)用 key 即可。`openai-codex`(OAuth-only)暂标
   「需 OAuth(未支持)」。OAuth 另起票 G06。
3. **自定义供应商 = B(列表,可加多个)**:预设 + 自定义并存,同一套数据结构(预设 =
   预填的自定义);自定义是一张同字段空表,可 add/edit/delete 多条。DashScope 缺口由
   自定义 provider 兜底(用户手填 DashScope 的 providerId/baseUrl/key/model)。
4. **model 选择 = B**:填完 key 后点「拉取/测试」→ `getAvailable(providerId)` 填下拉
   (拉取即测试连接,不另设测试按钮);下拉空或想自定义时允许手填。
5. **改/删运行中会话在用的 provider = B**:改配置默认只对新会话生效;显式「重载供应商」
   按钮(`registerProvider`+`reloadConfig`+`setRuntimeApiKey` 重新注入)才推到运行中。
   删 provider 不杀运行中会话(model 已设在 AgentSession),只是新会话选不到。
6. **形态 = B(右侧非模态抽屉)**:控件行齿轮触发,右侧抽屉滑入不抢焦点,聊天主区保持
   可交互——设置与聊天同时进行(用户明确要求非阻塞)。

**结论**:设置页决策已齐,可施工。key 存 keychain,不可用时按 D01 降级 env(配置文件
只存非敏感字段)。衍生执行(不在图内):设置抽屉 UI + `/api/settings` 读写 +
`~/.pi/web-pi/config.json` 持久化 + 启动注入 + 「重载供应商」逻辑。

