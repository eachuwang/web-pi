# web-pi

> A self-hosted, **self-contained** web UI + dashboard for the
> [pi](https://pi.dev) coding agent, built on the
> `@earendil-works/pi-coding-agent` SDK. One Node process hosts an agent
> session in-process and serves a React frontend over HTTP + SSE. It does
> **not** require a pi install — you configure your model provider in the UI.

[English](#english) · [中文](#中文)

---

## English

### What

web-pi is a self-hosted, **single-user, local-only** web front-end for the pi
coding agent. One Node process runs a Hono HTTP + SSE server that hosts an
`AgentSession` **in-process** (SDK-host), and a React + Vite frontend talks to
it. It binds to `127.0.0.1` and manages its **own** provider/key configuration
at `~/.web-pi/` — it does not read or require pi's `~/.pi/agent` credentials.

### Architecture

```
browser (React+Vite) ──HTTP/SSE──► Hono (Node) ──► AgentSession (in-process)
                                         │
                                         └──► pi SDK ──► your model provider
```

- **Backend** (`src/server.ts`): Hono. Owns the `AgentSession` via
  `createAgentSessionRuntime`. REST routes for prompt/steer/abort, model,
  thinking, compact, stats, messages, sessions, dirs, commands, git branch,
  and **settings** (model provider config). An SSE endpoint (`/api/events`)
  bridges `AgentSessionEvent`s to the browser. In production it also serves
  the built frontend from `dist/` on the same port.
- **Frontend** (`web/`): React 18 + Vite + TypeScript + Tailwind v3. Consumes
  the SSE stream and renders the chat + dashboard. A **settings drawer**
  (top-right ⚙) configures model providers.

### Features

- **Chat stream** with collapsible `THINKING` / `TOOL` / `SKILL` segments and
  rendered markdown replies.
- **Settings drawer** (⚙, top-right, non-modal — coexists with chat):
  configure model providers with 22 built-in **presets** (Anthropic, OpenAI,
  GLM/Z.AI, DeepSeek, …) or **custom** OpenAI-compatible endpoints (provider
  id + base URL + api wire-format + API key + multiple model ids). Keys are
  stored locally at `~/.web-pi/credentials.json` (0600); non-secret config at
  `~/.web-pi/config.json`. "Fetch models" enumerates a provider's models via
  `GET {baseUrl}/models`.
- **Thinking** stream, **markdown preview**, **auto-scroll**, **searchable
  skill picker**, **slash menu**, **git branch switcher**, **cwd picker +
  session resume/delete**, **model & thinking-level selectors**, and a live
  **Context / Queue / Sessions** dashboard.

### Tech stack

Node · Hono · React 18 · Vite · TypeScript · Tailwind v3 · SSE ·
react-markdown + remark-gfm

### Prerequisites

- Node.js 18+
- An API key for a model provider (entered in the settings drawer)

### Quick start

```bash
npm install
npm start            # production: builds, then serves web + API on http://127.0.0.1:3000
# — or for development with hot reload —
npm run dev          # web: http://127.0.0.1:5173 · api: http://127.0.0.1:3000
```

Open the web URL, click ⚙ (top-right), add a provider (preset or custom), paste
your API key, optionally fetch models, and save. Then chat.

### Configuration

- web-pi manages its own config at `~/.web-pi/`:
  - `config.json` — providers (id / base URL / api / models) + max sessions
  - `credentials.json` — API keys (0600, plaintext, pi convention)
  - `usage.json` — cumulative cost odometer (dashboard)
- `WEB_PI_CWD` env var sets the default agent working directory.
- `WEB_PI_HOME` overrides the config directory (default `~/.web-pi`).
- Switch cwd at runtime via the **current Dir** button; pick/switch the git
  branch via the **git** button.

### Project structure

```
web-pi/
  src/
    server.ts                # Hono backend: routes, SSE, AgentSession host, static serve
    config.ts                # ~/.web-pi/ config + provider injection (registerProvider)
  web/
    index.html
    src/
      App.tsx                  # main UI: chat, dashboard, composer, controls
      index.css               # styles (amber theme)
      components/
        CwdPicker.tsx          # directory browser + session resume
        GitBranchPicker.tsx    # branch switch / create
        SkillPicker.tsx        # searchable skill combobox
        SettingsDrawer.tsx     # model provider config drawer
      lib/
        api.ts                 # REST client
        presets.ts             # 22 built-in provider presets
  .wayfinder/                  # decision map (see .wayfinder/map.md)
  vite.config.ts · tailwind.config.ts · package.json · LICENSE
```

### Status / limitations

- Single session, single user, `127.0.0.1` only — no auth/RBAC. (Multi-session
  is designed but not yet built — see `.wayfinder/tickets/G01-*`.)
- A mid-turn browser refresh loses the in-progress streamed output until the
  SDK persists on turn end; reconnect replays from snapshot (see
  `.wayfinder/tickets/G05-*`).
- Licensed under MIT.

---

## 中文

### 是什么

web-pi 是 pi 编码代理的**自托管、自包含、单用户、仅本地**网页前端。一个 Node 进程跑
Hono HTTP + SSE 服务,在进程内托管 `AgentSession`(SDK-host 架构),React + Vite 前端
通过 HTTP/SSE 与之通信。绑定 `127.0.0.1`,**自己**管理 provider/key 配置(存 `~/.web-pi/`),
不读、不依赖 pi 的 `~/.pi/agent` 凭证。

### 架构

```
浏览器 (React+Vite) ──HTTP/SSE──► Hono (Node) ──► AgentSession (进程内)
                                         │
                                         └──► pi SDK ──► 你的模型供应商
```

### 功能

- **聊天流**:可折叠的 `THINKING` / `TOOL` / `SKILL` 段 + 渲染好的 markdown 回复。
- **设置抽屉**(⚙,右上角,非模态——与聊天并存):配置模型供应商。22 个内置**预设**
  (Anthropic、OpenAI、GLM/Z.AI、DeepSeek…)或**自定义** OpenAI-compatible 端点
  (provider id + base URL + api 线格式 + API key + 多个 model id)。key 存
  `~/.web-pi/credentials.json`(0600),非敏感配置存 `~/.web-pi/config.json`。「fetch
  models」通过 `GET {baseUrl}/models` 拉取供应商的 model 列表。
- thinking 流式窗口、markdown 预览、自动滚动、可搜索 skill 选择器、斜杠菜单、git 分支
  切换器、cwd 选择器 + 会话恢复/删除、模型 & 思考级别选择器、实时 Context / Queue /
  Sessions 仪表盘。

### 技术栈

Node · Hono · React 18 · Vite · TypeScript · Tailwind v3 · SSE ·
react-markdown + remark-gfm

### 前置条件

- Node.js 18+
- 一个模型供应商的 API key(在设置抽屉里填)

### 快速开始

```bash
npm install
npm start            # 生产:先 build,再在 http://127.0.0.1:3000 同时托管前端+API
# — 或开发模式(热更新)—
npm run dev          # web: http://127.0.0.1:5173 · api: http://127.0.0.1:3000
```

打开 web 地址,点右上角 ⚙,加一个供应商(预设或自定义),粘 API key,可选 fetch
models,Save,然后聊天。

### 配置

- web-pi 自己管理配置,存 `~/.web-pi/`:
  - `config.json` — 供应商(id/base URL/api/models)+ 最大会话数
  - `credentials.json` — API key(0600 明文,pi 惯例)
  - `usage.json` — 累计成本 odometer(仪表盘)
- `WEB_PI_CWD` 环境变量设默认代理工作目录。
- `WEB_PI_HOME` 覆盖配置目录(默认 `~/.web-pi`)。
- 运行时用 **current Dir** 按钮切 cwd;**git** 按钮切分支。

### 局限 / 状态

- 单会话、单用户、仅 `127.0.0.1`,无鉴权/RBAC。(多会话已设计未建,见
  `.wayfinder/tickets/G01-*`。)
- 流式输出中途刷新会丢在途流,直到 SDK turn 结束落盘;重连可从 snapshot 回放(见
  `.wayfinder/tickets/G05-*`)。
- MIT 许可证。
