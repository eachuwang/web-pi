---
id: G04
type: grilling
status: closed
assignee: agent
blocked-by: []
created: 2026-07-20
resolved: 2026-07-20
title: 开源发布形态与就绪清单
---

## Question

web-pi 要开源给他人用。发布形态与就绪项:

- 发布形态:npm 包 / Docker / 单二进制 / 仅源码?影响安装 UX 与 production serving。
- 安装顺畅度:新机器 `npm install && npm start` 能否零摩擦(本项目已踩 rollup 原生
  包 + .bin 权限坑)——是否需要 `postinstall` 或 optional deps 策略?
- production 静态服务(README 现限制):`vite build` → Hono 托管 `dist/` 接线。这是
  开源他人 `npm start` 不开 dev 的前提。
- License / CONTRIBUTING / CI / 是否发 npm。

## Notes

- HITL grilling 票。
- production serving 是其中一子项;若决定只开源源码不发 npm,该项仍需要(他人 clone
  后 `npm start`)。

## Resolution

2026-07-20 grilling 与用户确认,五个子决策(**且带出 D01 翻盘 + 项目自包含 reframe**):

**重大 reframe**:web-pi **完全自包含**——不要求用户装 pi CLI、不读 `~/.pi/agent`;
SDK 仅作 npm 依赖打包,用户在设置页填自己的 provider/key 即可。README 原「Prerequisites:
pi install / `~/.pi/agent/auth.json`」**过时须改**。据此已修订 D01(撤 pi fallback、
路径 `~/.pi/web-pi/`→`~/.web-pi/`、撤 keychain)。

1. **发布形态 = A**:源码 + npm 包为主(`npm install && npm start`);Docker 次选
   (想隔离者);单二进制(bun compile)留后。核心价值是复用本机凭证 + 绑 127.0.0.1,
   天命形态是原生 npm,非容器。
2. **配置路径 = A**:`~/.web-pi/`(config.json 非敏感 + credentials.json key + usage.json
   odometer),与 pi 解耦;`os.homedir()` 全平台。
3. **api_key 存储 = A(翻盘)**:明文 0600 文件 `~/.web-pi/credentials.json`(**pi 惯例**
   ——pi-ai 全代码无 keychain/keytar,pi 自己就是明文 auth.json);env var 作 override
   (pi `envApiKeyAuth`)。**撤 keytar/keychain**(原方案过度工程)。Q3 keytar 议题消解。
4. **production 静态服务 = A**:Hono 在 `:3000` 托管 `dist/` 静态 + API,SPA fallback 到
   index.html。`npm run build` → `npm start` = 单端口生产,用户开 127.0.0.1:3000 即用,
   无需 5173 dev。
5. **就绪范围 = B**:暂只 GitHub 源码分发(clone+install+start);**MIT license**;CI
   (lint+typecheck+build);稳定后再发 npm registry。

**结论**:开源就绪决策已齐。衍生执行(不在图内):Hono 托管 dist/ + SPA fallback、
README 重写(撤 pi 前置、改 5177→说明生产 :3000、加 MIT)、LICENSE 文件、CI workflow。
衍生新票:无(G05/G06 仍在图)。
