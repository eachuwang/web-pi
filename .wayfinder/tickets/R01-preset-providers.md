---
id: R01
type: research
status: closed
assignee: agent
blocked-by: []
resolved: 2026-07-20
created: 2026-07-20
title: 枚举 pi 内置模型供应商作设置页预设
---

## Question

设置页要给「预设供应商」下拉。pi 官方内置了哪些模型供应商(provider id、显示名、
default base_url、auth 类型、代表 model)?用于生成 web-pi 设置页的预设列表。

## Research plan

- 读本仓库已装 SDK:`node_modules/@earendil-works/pi-coding-agent/dist/**` 找内置
  provider 注册表 / `ProviderConfigInput` 默认值。
- 查 pi 官方 repo https://github.com/earendil-works/pi 的 provider 定义(ai 子包)。
- 产出:每个预设供应商的 { id, name, baseUrl, authType, 示例 model id } 表格,存
  `.wayfinder/research/preset-providers.md` 并在此票附 context pointer。

## Acceptance

一张可直接喂给设置页的预设供应商清单(含至少 pi 内置的全部主流供应商),字段齐全。

## Resolution

清单已写入 `.wayfinder/research/preset-providers.md`(22 个 api_key 预设 + OAuth/云凭证
类单独列)。关键发现,影响 G03 设置页设计:

1. **SDK 无 DashScope 内置 provider**。最接近的 GLM 预设是 `zai-coding-cn`(智谱
   /bigmodel.cn);Alibaba 系模型走 `ant-ling`。README 举例用的「DashScope GLM」要么
   改用 `zai-coding-cn`/`ant-ling`,要么走自定义 `registerProvider` 扩展。
2. **部分供应商 auth 类型非纯 key**:`openai-codex` OAuth-only(不能贴 key);
   `anthropic`/`xai`/`github-copilot` 同时支持 key 与 OAuth → 设置页需**双 UX**
   (key 粘贴框 + 登录按钮)。
3. GitHub repo 沙箱不可 WebFetch;已装 SDK dist 为权威来源,字段已从中抽取。

G03(settings-page-scope)据此 unblock,并新增「双 auth UX」「DashScope 缺口」子决策。
