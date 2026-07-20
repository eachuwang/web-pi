---
id: G06
type: grilling
status: open
assignee:
blocked-by: []
created: 2026-07-20
title: OAuth 登录路径(openai-codex / 双模供应商)
---

## Question

G03 本期只做 key 路径,OAuth 留后。本票定 OAuth 登录路径:

- 哪些供应商上 OAuth:`openai-codex`(OAuth-only,必做才有它)、`anthropic`/`xai`/
  `github-copilot`(双模,已有 key 路径,OAuth 是可选增强)。
- OAuth 流程 UX:设置页里「登录」按钮 → SDK `login(providerId, type, interaction)`
  → 凭证存哪(keychain?pi 的 credential store?)→ 登录态在设置页怎么显示。
- OAuth 回调:pi SDK 的 `AuthInteraction` 是否要本地 callback server(端口冲突?)还是
  设备码/device flow。需先研究 SDK `login` 的 interaction 形态(可能另起 research 票)。
- 凭证跨设备迁移:OAuth token 能否/如何迁移(G01/D01 已定 keychain+env,OAuth token
  性质类似)。

## Notes

- 毕业自 G03 resolution(OAuth 留后)。
- 不阻塞 destination 当前阶段(key 路径覆盖绝大多数用户);是「补 openai-codex 这类
  OAuth-only 供应商」的后续增强。
- HITL grilling 票;可能衍生 research 票(SDK `login`/`AuthInteraction` 形态)。
