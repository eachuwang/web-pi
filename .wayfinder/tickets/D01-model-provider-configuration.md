---
id: D01
type: grilling
status: closed
assignee: agent
blocked-by: []
created: 2026-07-20
resolved: 2026-07-20
title: 模型供应商配置策略
---

## Question

web-pi 如何让用户配置模型供应商(provider / base_url / api_key / 具体 model),使其
换设备后不依赖 pi 的 `~/.pi/agent/auth.json` 也能工作?

## Resolution

> **2026-07-20 修订(G04 grill 带出)**:撤销原「pi 原配置只读 fallback」与
> `~/.pi/web-pi/` 路径。web-pi **完全自包含**:不要求用户装 pi CLI、不读
> `~/.pi/agent/auth.json`;SDK 仅作为 npm 依赖打包,配置完全自有。路径改 `~/.web-pi/`。
> README 原「Prerequisites: pi install / `~/.pi/agent/auth.json`」过时,须改。

chart 阶段 grilling 与用户确认(2026-07-20,经 G04 修订):

1. **自有配置文件(自包含)**:web-pi 存自己的 `~/.web-pi/config.json`(用户目录,0600),
   **不**写、**不**读 pi 的 `~/.pi/agent/auth.json`。web-pi 不依赖 pi CLI 安装,SDK 仅作
   npm 依赖。开源用户无需装 pi。
2. **运行时注入**:启动时读自有配置,对每个 provider 调
   `modelRuntime.registerProvider(id, ProviderConfigInput)` + 对有 key 的调
   `setRuntimeApiKey(providerId, key)`。SDK 已暴露这两个口子(见
   `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts`)。
3. **api_key 存储(2026-07-20 G04 翻盘)**:key 存 `~/.web-pi/credentials.json`
   (0600,明文,**pi 惯例**——pi-ai 全代码无 keychain/keytar,pi 自己就是明文
   `auth.json`;与 `~/.aws/credentials`、`~/.config/gcloud` 同路子)。**不上 keychain/keytar**,
   零原生依赖、install 永不被卡。env var 作 override(pi `envApiKeyAuth` 逻辑:存了用存的、
   没存查 env)。非敏感配置(provider/baseUrl/model)存 `~/.web-pi/config.json`。
   原方案 keychain+keytar 作废(过度工程,相对 pi 惯例)。
4. **换设备迁移**:keychain 不可跨设备复制 → 迁移走「env var 或重新在设置页填」;
   非敏感配置随 `~/.web-pi/config.json` 走。

**事实依据**(已查):
- `ModelRuntime.create({ authPath?, credentials?, ... })` —— 可换凭证源。
- `registerProvider` / `unregisterProvider` / `setRuntimeApiKey` / `removeRuntimeApiKey`
  / `reloadConfig` —— 运行时 provider 与 key 管理。
- `getAuth(providerId, { apiKey, env })` —— 单次 override。

**衍生开放工作**(已成独立票,非本票范围):
- [R01](R01-preset-providers.md) 枚举 pi 内置供应商作预设。
- [G03](G03-settings-page-scope.md) 设置页 scope 与 UX(本票只定策略,不定页面)。
