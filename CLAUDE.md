# web-pi

A self-contained, open-source web frontend + monitoring dashboard for the
`@earendil-works/pi-coding-agent` SDK. Hosts an in-process `AgentSession` via a
Hono server; runs locally on `127.0.0.1`, single-user, multi-session.

## What this is

- **Backend** (`src/`): Hono server hosting one or more in-process pi
  `AgentSession` runtimes. SSE stream of `AgentSessionEvent`. Config + credentials
  owned by web-pi (not pi's `~/.pi/agent`).
- **Frontend** (`web/`): Vite + React 18 + Tailwind. Chat surface + a right-hand
  monitoring dashboard (Context / Cost / Tokens / Queue) + multi-session sidebar
  + non-modal settings drawer.
- **Tracker**: wayfinder (`wayfinder:map` issue in `.wayfinder/`). Planning lives
  there; this doc is the code-convention counterpart.

## Commands

```bash
npm run dev        # concurrently: API (tsx watch :3000) + web (vite :5173 HMR)
npm run build      # vite build → dist/ (served by Hono in prod)
npm start          # vite build && tsx src/server.ts  (single-port prod on :3000)
npm run typecheck  # tsc --noEmit  — run after every change
```

Dev: web on `:5173` calls API on `:3000` cross-origin (CORS `*`). Prod: Hono
serves `dist/` + API on one port (`:3000`), SPA fallback to `index.html`.

**Verify after changes**: `npm run typecheck && npm run build`. Don't only modify.

## Architecture

### Backend (`src/server.ts`)

- `modelRuntime` (SDK `ModelRuntime.create()`) is a process-global, shared by all
  sessions. Providers + keys are injected at startup via `applySettings()` and
  re-applied on settings PUT/reload.
- **Multi-session** (G01): `sessions: Map<sessionId, AgentSessionRuntime>` +
  `sessionMeta: Map<sessionId, {cwd, title?, created}>`. `maxSessions` from
  settings (default 4). `pick(c)` resolves `?sessionId=` → that runtime, else the
  first live one (single-session backward compat). `makeSession` enforces the cap.
- **Reconnect replay** (G05): `partialResultBuffer` (Map<toolCallId, string[]>,
  cap 50) rings each in-flight tool's incremental stdout — SSE-only, not in
  AgentState. `/api/snapshot` returns settled history + in-progress
  streamingMessage + pendingToolCalls (marked running) + queue + buffered
  partials; the frontend rebuilds the chat list then resumes SSE.
- **Cost odometer** (G02): `recordUsage()` snapshots each session's `getSessionStats()`
  into `~/.web-pi/usage.json`, keyed by `sessionFile` (stable across resume).
  Flush on `agent_end` + a 15s interval. Cross-session total = sum of snapshots
  (overwrite, never additive → resume/restart can't double-count). `getSessionStats()`
  already recomputes per-session cost cumulatively from the session file, so the
  odometer's job is the cross-session aggregate.
- `useEventStream` dep on `activeSessionId` drives SSE reconnect on session switch.

### Frontend (`web/src/`)

- `App.tsx` holds chat state in a `listRef` (mutated + `bump()` reducer to render);
  entries = user / assistant(segs) / system. Segs = thinking (collapsible) / tool
  (collapsible, partial `live:`) / text (Markdown preview/source toggle).
- `lib/api.ts` is the thin client; `?sessionId=` appended on session-scoped routes.
  `API_BASE = ""` in prod (same-origin), `http://127.0.0.1:3000` in dev.
- `components/SettingsDrawer.tsx` (D01/G03): non-modal right drawer, 22 presets +
  custom providers; api_key write-only (hasKey returned, never the key).
- `components/Sidebar.tsx` (G01): left live-session list (title + cwd tag + rename
  + streaming pulse + cap-disabled +new). The dashboard's old Sessions panel
  moved here.

### Config (`src/config.ts`, D01/G04)

- `~/.web-pi/config.json` — providers + maxSessions (non-secret, 0600).
- `~/.web-pi/credentials.json` — providerId → apiKey (0600 plaintext, pi convention;
  no keychain/keytar).
- `~/.web-pi/usage.json` — cost odometer (G02).
- Override the dir with `WEB_PI_HOME`.
- Custom (non-builtin baseUrl) providers → `registerProvider` + `setRuntimeApiKey`;
  builtin presets → `setRuntimeApiKey` only. `api` field wires builtin streaming
  (no `streamSimple`).

## Coding conventions

- **Language**: code/commands/identifiers in English; prose comments may be
  bilingual (English + 中文) — match the surrounding file. Existing comments lean
  English with ticket refs (`// G02:`, `// D01:`).
- **Ticket refs in comments**: decisions reference their wayfinder ticket id
  (`G01`, `D01`, …). Keep that thread when touching code a ticket governs.
- **No hardcoded keys/tokens/passwords**. Secrets go to `credentials.json` via
  the settings PUT path; never returned by GET (`hasKey` instead).
- **maxTokens ≠ contextWindow**: `maxTokens` is the OUTPUT cap
  (`max_completion_tokens`), decoupled from the input `contextWindow`. A 1M input
  window must not push maxTokens past an endpoint's output cap (GLM caps at
  131072 → 400 InvalidParameter → auto_retry loop → empty response). Default 8192.
- **Avoid new native-dependency packages** (rollup native bundle + `.bin` perms
  burned us once). Prefer pure-JS deps; if unavoidable, add env/fallback shims.
- When the node_modules tree is copied cross-device (e.g. Windows → macOS),
  re-add `@rollup/rollup-darwin-arm64` and `chmod +x node_modules/.bin/*`.

## Verification checklist (before claiming done)

1. `npm run typecheck` — clean.
2. `npm run build` — succeeds.
3. Runtime smoke: start `PORT=3999 npx tsx src/server.ts`, curl
   `/api/health`, `/api/stats`, `/api/usage` — shapes match `lib/api.ts` types.
4. For UI changes: load the page in a browser, check the dashboard renders +
   console is error-free.

## Known issues / out of scope for v1

- **Session storage still touches `~/.pi/`** — `makeSession` uses the SDK's
  `SessionManager.create(cwd)` with `getAgentDir()`, so session JSONL files land
  in `~/.pi/agent/sessions/`, not `~/.web-pi/`. Config + credentials ARE
  self-contained (`~/.web-pi/`), but the "fully independent of `~/.pi`" claim in
  G04 is **partially not true for session storage**. Needs a decision + SDK
  research (does `SessionManager.create` accept a custom storage dir?) → future
  wayfinder ticket.
- **OAuth** (G06) — deferred to a later effort (v1 out-of-scope). 22 presets; only
  `openai-codex` is OAuth-only (21/22 work via key path).

## Wayfinder

Planning artifacts live in `.wayfinder/`:
- `map.md` — the map (Destination, Decisions so far, Not yet specified, Out of scope).
- `tickets/*.md` — decision tickets (frontmatter: id/type/status/assignee/blocked-by).
- `research/` — research findings.

To continue planning: read `.wayfinder/map.md` first, then take the next frontier
ticket (status: open, blocked-by: [], assignee: empty). As of 2026-07-20 the v1
map is walked-through (all tickets closed); remaining work is implementation.
