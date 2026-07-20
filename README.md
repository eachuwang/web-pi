# web-pi

> A minimalist web UI + dashboard for [pi](https://pi.dev), built on the
> `@earendil-works/pi-coding-agent` SDK. One Node process hosts the agent
> session in-process and serves a React frontend over HTTP + SSE.

[English](#english) · [中文](#中文)

---

## English

### What

web-pi is a self-hosted, **single-user, local-only** web front-end for the pi
coding agent. One Node process runs a Hono HTTP + SSE server that hosts an
`AgentSession` **in-process** (SDK-host), and a React + Vite frontend talks to
it. It binds to `127.0.0.1` and reuses your own pi install / model credentials —
it is not a remote or hosted product.

### Architecture

```
browser (React+Vite) ──HTTP/SSE──► Hono (Node) ──► AgentSession (in-process)
                                         │
                                         └──► pi SDK ──► your model provider
```

- **Backend** (`src/server.ts`): Hono. Owns the `AgentSession` via
  `createAgentSessionRuntime`. REST routes for prompt/steer/abort, model,
  thinking level, compact, stats, messages, sessions (list + delete), dirs,
  commands, git branch. An SSE endpoint (`/api/events`) bridges
  `AgentSessionEvent`s to the browser.
- **Frontend** (`web/`): React 18 + Vite + TypeScript + Tailwind v3. Consumes
  the SSE stream and renders the chat + dashboard.

### Features

- **Chat stream** with collapsible `THINKING` / `TOOL` / `SKILL` segments and
  rendered markdown replies.
- **Thinking**: a fixed ~8-line live window pinned to the latest output while
  streaming (pure CSS, no inner scrollbar); collapses on completion; expands to
  a scrollable box on click.
- **Markdown preview** for assistant text (`react-markdown` + `remark-gfm`,
  GFM tables/code/etc.), with a source/preview toggle and a copy button.
- **Auto-scroll** chatlog that sticks to the bottom and pauses when you scroll
  up to read history.
- **Searchable skill picker**: fuzzy-match skills by name (type letters →
  filter); skill invocations render as `SKILL` callouts for both user-typed
  (`/skill:xxx`) and agent-auto (a `read` on `SKILL.md`).
- **Slash menu**: type `/` for meta commands (`/compact`, `/clear`, `/cwd`,
  `/new`, `/sessions`) and skills/prompts.
- **Git branch switcher** + new-branch creator in the controls row
  (switch / create-and-switch from a base).
- **cwd picker** + session resume / delete (custom confirm dialog, no native
  browser popups).
- **Model & thinking-level selectors** and a live **Context / Queue / Sessions**
  dashboard.
- **Unified amber theme** and a consistent chevron across all controls.
- Web fonts: Montserrat (Latin/numbers) + Alibaba PuHuiTi (CJK) via CDN.

### Tech stack

Node · Hono · React 18 · Vite · TypeScript · Tailwind v3 · SSE ·
react-markdown + remark-gfm

### Prerequisites

- Node.js 18+
- A working pi agent install (provides `~/.pi/agent/auth.json` via `pi /login`
  and the `@earendil-works/pi-coding-agent` SDK)
- A model provider API key configured with pi (e.g. DashScope GLM)

### Quick start

```bash
npm install
npm run dev
# web:  http://127.0.0.1:5177
# api:  http://127.0.0.1:3000
```

Open the web URL in your browser. The dev servers hot-reload on change.

### Configuration

- Reuses your `~/.pi/agent/auth.json` credentials — no separate login.
- `WEB_PI_CWD` env var sets the default agent working directory.
- Switch cwd at runtime via the **current Dir** button; pick/switch the git
  branch via the **git** button.

### Project structure

```
web-pi/
  src/server.ts                # Hono backend: routes, SSE, AgentSession host
  web/
    index.html
    src/
      App.tsx                  # main UI: chat, sidebar, composer, controls
      index.css                # styles (amber theme)
      components/
        CwdPicker.tsx          # directory browser + session resume
        GitBranchPicker.tsx    # branch switch / create
        SkillPicker.tsx        # searchable skill combobox
      hooks/useEventStream.ts  # SSE consumer with reconnect
      lib/api.ts               # REST client
  vite.config.ts
  tailwind.config.ts
  package.json
```

### Limitations / status

- Single session, single user, `127.0.0.1` only — no auth/RBAC.
- A mid-turn browser refresh loses the in-progress streamed output (the SDK
  persists on turn end; SSE does not replay past events). The frontend detects
  the backend's streaming state after reconnect, so you can abort or steer.
- Production static serving (`vite build` → Hono serves `dist/`) is not wired
  yet; this is a dev-server-only setup for now.

---

## 中文

### 是什么

web-pi 是 pi 编码代理的**自托管、单用户、仅本地**网页前端。一个 Node 进程跑 Hono
HTTP + SSE 服务,在进程内托管 `AgentSession`(SDK-host 架构),React + Vite 前端通过
HTTP/SSE 与之通信。绑定 `127.0.0.1`,复用你本地的 pi 安装与模型凭证——不是远程或托管产品。

### 架构

```
浏览器 (React+Vite) ──HTTP/SSE──► Hono (Node) ──► AgentSession (进程内)
                                         │
                                         └──► pi SDK ──► 你的模型供应商
```

- **后端**(`src/server.ts`):Hono。通过 `createAgentSessionRuntime` 持有
  `AgentSession`。提供 prompt/steer/abort、model、thinking level、compact、stats、
  messages、sessions(列表/删除)、dirs、commands、git branch 等 REST 路由;SSE 端点
  `/api/events` 把 `AgentSessionEvent` 桥接给浏览器。
- **前端**(`web/`):React 18 + Vite + TypeScript + Tailwind v3。消费 SSE 流,渲染
  聊天 + 仪表盘。

### 功能

- **聊天流**:可折叠的 `THINKING` / `TOOL` / `SKILL` 段 + 渲染好的 markdown 回复。
- **thinking**:流式时固定 ~8 行可视区,始终显示最新输出(纯 CSS,无内嵌滚动条);
  结束后折叠;点击展开成可滚动框。
- **markdown 预览**:助手文本用 `react-markdown` + `remark-gfm`(GFM 表格/代码等),
  提供源码/预览切换 + 复制按钮。
- **自动滚动**:chatlog 始终贴底显示最新;你往上滚读历史时暂停跟随。
- **可搜索 skill 选择器**:按 skill 名模糊匹配(输入字母即过滤);skill 调用渲染成
  `SKILL` 标记段,覆盖用户手打(`/skill:xxx`)与 agent 自动调用(read SKILL.md)两种。
- **斜杠菜单**:输入 `/` 触发,含 meta 命令(`/compact` `/clear` `/cwd` `/new`
  `/sessions`)与 skills/prompts。
- **git 分支切换/新建**:控件行的 git 按钮,可切换分支或从某分支新建并切换。
- **cwd 选择器 + 会话恢复/删除**:自定义确认弹窗(不用浏览器原生弹窗)。
- **模型 & 思考级别选择器** + 实时 **Context / Queue / Sessions** 仪表盘。
- **统一琥珀主题**,所有控件箭头风格一致。
- 字体:Montserrat(拉丁/数字)+ 阿里巴巴普惠体(CJK),经 CDN 加载。

### 技术栈

Node · Hono · React 18 · Vite · TypeScript · Tailwind v3 · SSE ·
react-markdown + remark-gfm

### 前置条件

- Node.js 18+
- 可用的 pi 代理安装(提供 `~/.pi/agent/auth.json`,经 `pi /login`;以及
  `@earendil-works/pi-coding-agent` SDK)
- 在 pi 配置好的模型供应商 API key(如 DashScope GLM)

### 快速开始

```bash
npm install
npm run dev
# web:  http://127.0.0.1:5177
# api:  http://127.0.0.1:3000
```

浏览器打开 web 地址。开发服务器支持热更新。

### 配置

- 复用 `~/.pi/agent/auth.json` 凭证,无需单独登录。
- 环境变量 `WEB_PI_CWD` 设置默认代理工作目录。
- 运行时用 **current Dir** 按钮切换 cwd;用 **git** 按钮选择/切换 git 分支。

### 项目结构

```
web-pi/
  src/server.ts                # Hono 后端:路由、SSE、AgentSession 宿主
  web/
    index.html
    src/
      App.tsx                  # 主 UI:聊天、侧边栏、输入框、控件行
      index.css                # 样式(琥珀主题)
      components/
        CwdPicker.tsx          # 目录浏览 + 会话恢复
        GitBranchPicker.tsx    # 分支切换/新建
        SkillPicker.tsx        # 可搜索 skill 组合框
      hooks/useEventStream.ts  # SSE 消费(带重连)
      lib/api.ts               # REST 客户端
  vite.config.ts
  tailwind.config.ts
  package.json
```

### 局限 / 状态

- 单会话、单用户、仅 `127.0.0.1`,无鉴权/RBAC。
- 流式输出中途刷新浏览器会丢失在途输出(SDK 在 turn 结束才落盘,SSE 不重放历史
  事件)。前端在重连后能感知后端的 streaming 状态,故可 abort 或 steer。
- 生产静态服务(`vite build` → Hono 托管 `dist/`)尚未接线,目前仅开发服务器。
