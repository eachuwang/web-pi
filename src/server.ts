// web-pi backend — Hono server hosting an in-process pi AgentSession (SDK-host).
//
// `holder.runtime` is mutable: cwd/resume switches re-init it. All routes and
// the SSE stream read the current runtime via rt(). On a session switch the
// frontend reconnects the EventSource, so the new stream subscribes to the new
// session.
//
// Routes:
//   GET  /api/health           session/cwd/streaming/model/thinking
//   GET  /api/stats            getSessionStats() — real aggregated totals + contextUsage
//   GET  /api/messages         current session history (user+assistant text)
//   GET  /api/models           available models (for picker)
//   POST /api/model            switch model {provider, id}
//   POST /api/thinking         set thinking level {level}
//   POST /api/prompt           prompt/steer/followup via {message, streamingBehavior?}
//   POST /api/abort            abort current run
//   POST /api/compact          compact context {customInstructions?}
//   GET  /api/sessions?cwd=    saved sessions in a cwd (for resume picker)
//   GET  /api/dirs?path=       subdirectories (for cwd browser)
//   POST /api/session          switch cwd (fresh) or resume {cwd, sessionPath?}
//   POST /api/session/rename   {sessionId, title}
//   POST /api/session/dispose  archive/delete a live session {sessionId, archive}
//   GET  /api/events           SSE stream of AgentSessionEvent

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  applySettings,
  loadCredentials,
  loadSettings,
  loadUsage,
  recordUsage,
  resolveModelLimits,
  saveCredentials,
  saveSettings,
  type ProviderEntry,
  type Settings,
  type UsageData,
} from "./config";

const PORT = Number(process.env.PORT ?? 3000);
const cwd = process.env.WEB_PI_CWD ?? process.cwd();

const modelRuntime = await ModelRuntime.create();

// Load self-contained config (~/.web-pi/*) and inject providers + keys into the
// shared ModelRuntime. (D01/G04: web-pi owns its config, no pi install dependency.)
const settingsState: Settings = await loadSettings();
const credsState: Record<string, string> = await loadCredentials();
const applyResult = await applySettings(modelRuntime, settingsState, credsState);
if (applyResult.failed.length) {
  console.warn(`[web-pi] settings: ${applyResult.failed.length} provider(s) failed to apply:`, applyResult.failed);
}
if (applyResult.applied.length) {
  console.log(`[web-pi] settings: applied providers ${applyResult.applied.join(", ")}`);
}

// Runtime factory: closes over process-global inputs (modelRuntime) and
// recreates cwd-bound services for the effective cwd. Reused on cwd switches.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd: sessionCwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({
    cwd: sessionCwd,
    agentDir,
    modelRuntime,
  });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: ["read", "bash", "edit", "write"],
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

// G01 multi-session: live AgentSessionRuntimes keyed by AgentSession.sessionId,
// concurrent up to settingsState.maxSessions. Created on demand (new or resume).
// One default session is created at startup so the app works on first load
// (backward compat: routes without ?sessionId= fall back to the first live one).
const sessions = new Map<string, AgentSessionRuntime>();
const sessionMeta = new Map<string, { cwd: string; title?: string; created: number }>();
const maxSessions = () => settingsState.maxSessions ?? 4;

async function makeSession(opts: { cwd: string; sessionPath?: string }): Promise<AgentSessionRuntime> {
  if (sessions.size >= maxSessions()) {
    throw new Error(`max sessions reached (${maxSessions()})`);
  }
  const sm = opts.sessionPath ? SessionManager.open(opts.sessionPath, undefined, opts.cwd) : SessionManager.create(opts.cwd);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    sessionManager: sm,
  });
  sessions.set(runtime.session.sessionId, runtime);
  sessionMeta.set(runtime.session.sessionId, { cwd: opts.cwd, created: Date.now() });
  return runtime;
}

// Resolve a session for a request: explicit ?sessionId= wins, else the first
// live session (keeps the single-session frontend working unchanged).
type Ctx = { req: { query: (k: string) => string | undefined } };
function pick(c: Ctx): AgentSessionRuntime | undefined {
  const id = c.req.query("sessionId");
  if (id && sessions.has(id)) return sessions.get(id);
  for (const [, rt] of sessions) return rt;
  return undefined;
}
function rt(c?: Ctx): AgentSessionRuntime {
  if (c) {
    const s = pick(c);
    if (s) return s;
  }
  for (const [, r] of sessions) return r;
  throw new Error("no live session");
}

// default session at startup
await makeSession({ cwd });

// G02 cost odometer flush: every 15s snapshot all live sessions into
// ~/.web-pi/usage.json. Idempotent (snapshot-overwrite per sessionFile), so
// multi-client agent_end + this interval can't double-count. Connection-
// independent — catches turns driven without an SSE listener. On restart the
// resumed session's getSessionStats() recomputes cumulatively from the file,
// so the first post-crash flush recovers any unflushed turn.
async function flushUsage(): Promise<void> {
  for (const r of sessions.values()) {
    try {
      const st = r.session.getSessionStats();
      await recordUsage(
        { sessionFile: st.sessionFile, cost: st.cost, tokens: st.tokens, toolCalls: st.toolCalls, totalMessages: st.totalMessages },
        r.cwd,
      );
    } catch {
      // a session mid-teardown may throw — skip it this round
    }
  }
}
setInterval(() => void flushUsage(), 15_000);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

type HistSeg =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; id: string };

// Reconstruct an assistant message's content blocks as ordered segments so the
// webui can render thinking (collapsible), text (the reply), and tool calls
// (collapsible) in-place within the chat stream.
function assistantSegments(content: unknown): HistSeg[] {
  const out: HistSeg[] = [];
  if (typeof content === "string") {
    out.push({ kind: "text", text: content });
    return out;
  }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (typeof b !== "object" || b === null) continue;
      const t = (b as { type?: string }).type;
      if (t === "thinking") {
        out.push({ kind: "thinking", text: String((b as { thinking?: string }).thinking ?? "") });
      } else if (t === "text") {
        out.push({ kind: "text", text: String((b as { text?: string }).text ?? "") });
      } else if (t === "toolCall") {
        out.push({ kind: "tool", name: String((b as { name?: string }).name ?? "tool"), id: String((b as { id?: string }).id ?? "") });
      }
    }
  }
  return out;
}

const app = new Hono();
app.use("/api/*", cors({ origin: "*" }));

// G05 reconnect replay: ring-buffer each in-flight tool's `partialResult`
// (tool incremental stdout) — SSE-only, not in AgentState. On reconnect the
// snapshot route replays the buffered tail so a mid-tool refresh doesn't lose
// the live stdout. Capped per toolCallId; cleared on tool_execution_end.
const partialResultBuffer = new Map<string, string[]>();
const PARTIAL_CAP = 50;
function stringifyPartial(p: unknown): string {
  if (typeof p === "string") return p;
  if (p == null) return "";
  try {
    const j = JSON.stringify(p);
    return j.length > 400 ? j.slice(0, 400) + "…" : j;
  } catch {
    return String(p);
  }
}
function bufferPartial(event: { type?: string; toolCallId?: unknown; partialResult?: unknown }): void {
  if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
    const txt = stringifyPartial(event.partialResult);
    if (!txt) return;
    const arr = partialResultBuffer.get(event.toolCallId) ?? [];
    arr.push(txt);
    if (arr.length > PARTIAL_CAP) arr.shift();
    partialResultBuffer.set(event.toolCallId, arr);
  } else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
    partialResultBuffer.delete(event.toolCallId);
  }
}

app.get("/api/health", (c) => {
  const s = rt(c).session;
  const m = s.model;
  return c.json({
    ok: true,
    sessionId: s.sessionId,
    cwd: rt(c).cwd,
    streaming: s.isStreaming,
    hasModel: Boolean(m),
    model: m ? { id: m.id, provider: m.provider } : null,
    thinking: s.thinkingLevel,
    availableThinkingLevels: s.getAvailableThinkingLevels(),
    supportsThinking: s.supportsThinking(),
  });
});

app.get("/api/stats", (c) => {
  const s = rt(c).session;
  // G02: surface in-flight tools alongside the per-session cost/tokens so the
  // dashboard's Queue panel can mark pendingToolCalls as running without a
  // separate snapshot fetch. Also surface the actual thinkingLevel + the levels
  // the current model supports — fetched on model switch / session switch so the
  // thinking dropdown stays in sync with what the SDK clamped to.
  return c.json({
    ...s.getSessionStats(),
    pendingToolCalls: [...s.state.pendingToolCalls],
    thinkingLevel: s.thinkingLevel,
    availableThinkingLevels: s.getAvailableThinkingLevels(),
    supportsThinking: s.supportsThinking(),
  });
});

// G02: cross-session cost odometer — total spend across every session ever,
// persisted at ~/.web-pi/usage.json. Per-session live cost still comes from
// /api/stats (getSessionStats); this is the all-time aggregate for the dashboard.
app.get("/api/usage", async (c) => {
  const u: UsageData = await loadUsage();
  return c.json(u);
});

app.get("/api/messages", (c) => {
  const msgs = rt(c).session.messages;
  const out = msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i) => ({
      id: String(i),
      role: m.role as "user" | "assistant",
      segments:
        m.role === "assistant"
          ? assistantSegments(m.content)
          : [{ kind: "text" as const, text: extractText(m.content) }],
    }));
  return c.json(out);
});

app.get("/api/commands", (c) => {
  const loader = rt(c).services.resourceLoader;
  const prompts = loader
    .getPrompts()
    .prompts.map((p) => ({ cmd: `/${p.name}`, desc: p.description ?? "", kind: "prompt" as const }));
  const skills = loader
    .getSkills()
    .skills.map((s) => ({ cmd: `/skill:${s.name}`, desc: s.description ?? "", kind: "skill" as const }));
  return c.json([...prompts, ...skills]);
});

app.get("/api/models", async (c) => {
  const models = await modelRuntime.getAvailable();
  return c.json(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
    })),
  );
});

app.post("/api/model", async (c) => {
  const { provider, id } = await c.req.json<{ provider?: string; id?: string }>();
  if (!provider || !id) return c.json({ ok: false, error: "provider + id required" }, 400);
  const m = modelRuntime.getModel(provider, id);
  if (!m) return c.json({ ok: false, error: "model not found" }, 404);
  await rt(c).session.setModel(m);
  return c.json({ ok: true, model: { id: m.id, provider: m.provider } });
});

app.post("/api/thinking", async (c) => {
  const { level } = await c.req.json<{ level?: string }>();
  if (!level || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
    return c.json({ ok: false, error: "invalid level" }, 400);
  }
  const s = rt(c).session;
  s.setThinkingLevel(level as ThinkingLevel);
  // The SDK clamps the level to what the current model supports — a
  // reasoning:false model (e.g. a custom-provider model) clamps any level to
  // "off". Return the ACTUAL level (re-read after set), not the requested one,
  // so the frontend dropdown syncs to reality. Previously we returned the
  // requested level, the frontend showed it optimistically, while session_init
  // reported the clamped value → "shows med, backend says off" desync.
  return c.json({
    ok: true,
    level: s.thinkingLevel,
    available: s.getAvailableThinkingLevels(),
  });
});

app.post("/api/prompt", async (c) => {
  const body = await c.req.json<{
    message?: string;
    streamingBehavior?: "steer" | "followUp";
  }>();
  const message = body.message?.trim();
  if (!message) return c.json({ accepted: false, error: "message required" }, 400);
  // G01: auto-title this session from the first user prompt (if unnamed).
  const runtime = rt(c);
  const meta = sessionMeta.get(runtime.session.sessionId);
  if (meta && !meta.title) meta.title = message.slice(0, 60);
  const result = await new Promise<{ accepted: boolean; error?: string }>((resolve) => {
    runtime.session
      .prompt(message, {
        streamingBehavior: body.streamingBehavior,
        preflightResult: (ok) => resolve({ accepted: ok, error: ok ? undefined : "session is busy (still streaming)" }),
      })
      .catch((e: unknown) => resolve({ accepted: false, error: String(e) }));
  });
  return c.json(result, result.accepted ? 200 : 409);
});

app.post("/api/abort", async (c) => {
  await rt(c).session.abort();
  return c.json({ aborted: true });
});

app.post("/api/compact", async (c) => {
  const { customInstructions } = await c.req.json<{ customInstructions?: string }>();
  try {
    await rt(c).session.compact(customInstructions);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

app.get("/api/sessions", async (c) => {
  const listCwd = c.req.query("cwd") ?? rt().cwd;
  const sessions = await SessionManager.list(listCwd);
  return c.json(
    sessions.map((s) => ({
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
    })),
  );
});

app.delete("/api/sessions", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ ok: false, error: "path required" }, 400);
  if ([...sessions.values()].some((rt) => rt.session.sessionFile === path)) {
    return c.json({ ok: false, error: "cannot delete an active session" }, 409);
  }
  try {
    await unlink(path);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

const execFileP = promisify(execFile);
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const out = await execFileP("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return { ok: true, stdout: String(out.stdout) };
  } catch (e) {
    const ex = e as { stderr?: unknown; message?: string };
    const raw = ex.stderr;
    const stderr =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : "";
    return { ok: false, error: (stderr || ex.message || String(e)).trim() };
  }
}

app.get("/api/git/branch", async (c) => {
  const cwd = c.req.query("cwd") ?? rt().cwd;
  const cur = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!cur.ok) return c.json({ repo: false, current: "", branches: [] });
  const lst = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const branches = lst.ok ? lst.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  return c.json({ repo: true, current: cur.stdout.trim(), branches });
});

app.post("/api/git/checkout", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { branch?: string };
  const branch = (body.branch ?? "").trim();
  if (!BRANCH_RE.test(branch)) return c.json({ ok: false, error: "invalid branch name" }, 400);
  const r = await runGit(rt().cwd, ["checkout", branch]);
  if (!r.ok) return c.json({ ok: false, error: r.error }, 500);
  return c.json({ ok: true, current: branch });
});

app.post("/api/git/branch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; from?: string };
  const name = (body.name ?? "").trim();
  const from = (body.from ?? "").trim();
  if (!BRANCH_RE.test(name)) return c.json({ ok: false, error: "invalid branch name" }, 400);
  if (from && !BRANCH_RE.test(from)) return c.json({ ok: false, error: "invalid base branch" }, 400);
  const args = from ? ["checkout", "-b", name, from] : ["checkout", "-b", name];
  const r = await runGit(rt().cwd, args);
  if (!r.ok) return c.json({ ok: false, error: r.error }, 500);
  return c.json({ ok: true, current: name });
});

app.get("/api/dirs", (c) => {
  const root = c.req.query("path") ?? rt().cwd;
  let entries: { name: string; path: string }[] = [];
  let readError = false;
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: join(root, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    readError = true;
  }
  return c.json({ path: root, parent: dirname(root), entries, error: readError ? "cannot read path" : undefined });
});

// G01: create a new (or resume) live session. Returns its sessionId; the
// frontend then targets that id in subsequent ?sessionId= calls.
app.post("/api/session", async (c) => {
  const { cwd: newCwd, sessionPath } = await c.req.json<{ cwd?: string; sessionPath?: string }>();
  if (!newCwd) return c.json({ ok: false, error: "cwd required" }, 400);
  try {
    const runtime = await makeSession({ cwd: newCwd, sessionPath });
    const s = runtime.session;
    const m = s.model;
    return c.json({
      ok: true,
      sessionId: s.sessionId,
      cwd: runtime.cwd,
      hasModel: Boolean(m),
      model: m ? { id: m.id, provider: m.provider } : null,
      thinking: s.thinkingLevel,
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// G01: list in-memory live sessions (sidebar source).
app.get("/api/sessions/live", (c) => {
  const out = [...sessions.values()].map((rt) => {
    const s = rt.session;
    const meta = sessionMeta.get(s.sessionId);
    const firstUser = s.messages.find((m) => m.role === "user");
    const title = meta?.title ?? (firstUser ? extractText(firstUser.content).slice(0, 60) : null);
    return {
      sessionId: s.sessionId,
      cwd: rt.cwd,
      title,
      streaming: s.isStreaming,
      hasModel: Boolean(s.model),
      model: s.model ? { id: s.model.id, provider: s.model.provider } : null,
      created: meta?.created ?? 0,
    };
  });
  return c.json({ sessions: out, max: maxSessions() });
});

// G01: rename a live session (title auto from first user message otherwise).
app.post("/api/session/rename", async (c) => {
  const { sessionId, title } = await c.req.json<{ sessionId?: string; title?: string }>();
  if (!sessionId || !title?.trim()) return c.json({ ok: false, error: "sessionId + title required" }, 400);
  const meta = sessionMeta.get(sessionId);
  if (!meta) return c.json({ ok: false, error: "session not found" }, 404);
  meta.title = title.trim();
  return c.json({ ok: true, title: meta.title });
});

// #3: dispose a live session — archive (keep the session file, free the slot,
// resumable later via the cwd picker) or delete (also unlink the file). Aborts
// any in-flight run first. If this was the last live session, creates a fresh
// default so the app stays usable. Returns the id the frontend should switch to.
app.post("/api/session/dispose", async (c) => {
  const { sessionId, archive } = await c.req.json<{ sessionId?: string; archive?: boolean }>();
  if (!sessionId) return c.json({ ok: false, error: "sessionId required" }, 400);
  const runtime = sessions.get(sessionId);
  if (!runtime) return c.json({ ok: false, error: "session not live" }, 404);
  const { cwd: goneCwd, session } = runtime;
  try {
    await session.abort();
  } catch {
    // not streaming — fine
  }
  const file = session.sessionFile;
  sessions.delete(sessionId);
  sessionMeta.delete(sessionId);
  if (!archive && file) {
    try {
      await unlink(file);
    } catch {
      // file may already be gone — fine
    }
  }
  let newActiveId: string | undefined;
  if (sessions.size === 0) {
    // keep the app usable: spin up a fresh default in the disposed session's cwd
    const fresh = await makeSession({ cwd: goneCwd });
    newActiveId = fresh.session.sessionId;
  } else {
    newActiveId = [...sessions.values()][0]?.session.sessionId;
  }
  return c.json({ ok: true, newActiveId, archived: Boolean(archive) });
});

app.get("/api/settings", (c) => {
  // Never leak api keys; surface hasKey instead.
  const providers = settingsState.providers.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api,
    models: p.models ?? [],
    contextWindow: p.contextWindow,
    maxTokens: p.maxTokens,
    modelConfig: p.modelConfig ?? {},
    custom: p.custom,
    enabled: p.enabled !== false,
    hasKey: Boolean(credsState[p.id]),
  }));
  return c.json({ providers, maxSessions: settingsState.maxSessions });
});

// Body: { providers: ProviderEntry[] (each may carry transient `apiKey`), maxSessions }
// Strips apiKey into credentials.json (0600), saves the rest to config.json,
// then re-injects into the shared ModelRuntime so new requests pick it up.
app.put("/api/settings", async (c) => {
  const body = await c.req.json<{
    providers?: Array<ProviderEntry & { apiKey?: string }>;
    maxSessions?: number;
  }>();
  const providers: ProviderEntry[] = (body.providers ?? []).map((p) => {
    // Per-model ctx/maxTokens overrides: drop blanks/zeroes so unset fields fall
    // back to the provider default at registration time.
    const mc: Record<string, { contextWindow?: number; maxTokens?: number }> = {};
    if (p.modelConfig && typeof p.modelConfig === "object") {
      for (const [mid, ml] of Object.entries(p.modelConfig)) {
        if (!mid) continue;
        const cfg = ml as { contextWindow?: number; maxTokens?: number };
        const ctx = typeof cfg.contextWindow === "number" && cfg.contextWindow > 0 ? cfg.contextWindow : undefined;
        const max = typeof cfg.maxTokens === "number" && cfg.maxTokens > 0 ? cfg.maxTokens : undefined;
        if (ctx || max) mc[mid] = { ...(ctx ? { contextWindow: ctx } : {}), ...(max ? { maxTokens: max } : {}) };
      }
    }
    return {
      id: String(p.id),
      name: p.name ? String(p.name) : undefined,
      baseUrl: p.baseUrl ? String(p.baseUrl) : undefined,
      api: p.api ? String(p.api) : undefined,
      models: Array.isArray(p.models) ? p.models.map(String).filter(Boolean) : [],
      contextWindow: typeof p.contextWindow === "number" ? p.contextWindow : undefined,
      maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : undefined,
      modelConfig: Object.keys(mc).length ? mc : undefined,
      custom: Boolean(p.custom),
      enabled: p.enabled !== false,
    };
  });
  const maxSessions =
    typeof body.maxSessions === "number" && body.maxSessions >= 1 && body.maxSessions <= 16
      ? Math.floor(body.maxSessions)
      : settingsState.maxSessions;

  // Split secrets from non-secret config.
  const newCreds: Record<string, string> = {};
  for (const p of body.providers ?? []) {
    if (typeof p.apiKey === "string" && p.apiKey.trim()) {
      newCreds[String(p.id)] = p.apiKey.trim();
    } else if (credsState[String(p.id)]) {
      // keep existing key if not re-provided
      newCreds[String(p.id)] = credsState[String(p.id)];
    }
  }

  settingsState.providers = providers;
  settingsState.maxSessions = maxSessions;
  Object.keys(credsState).forEach((k) => delete credsState[k]);
  Object.assign(credsState, newCreds);

  await saveSettings(settingsState);
  await saveCredentials(credsState);
  const res = await applySettings(modelRuntime, settingsState, credsState);
  return c.json({ ok: true, applied: res.applied, failed: res.failed });
});

// Test a provider: set the key (runtime, non-persistent) and fetch available
// models. For custom OpenAI-compatible providers, enumerate via GET
// {baseUrl}/models (the standard OpenAI /models endpoint) so the UI shows real
// model ids, not just the registered fallback. Falls back to the registered
// model if the endpoint doesn't expose /models. Does NOT persist the key.
app.post("/api/settings/test", async (c) => {
  const body = await c.req.json<{
    providerId?: string;
    apiKey?: string;
    baseUrl?: string;
    api?: string;
    models?: string[];
    contextWindow?: number;
    maxTokens?: number;
    modelConfig?: Record<string, { contextWindow?: number; maxTokens?: number }>;
    custom?: boolean;
  }>();
  const providerId = body.providerId?.trim();
  if (!providerId) return c.json({ ok: false, error: "providerId required" }, 400);
  try {
    if (body.custom && body.baseUrl) {
      const api = body.api || "openai-completions";
      const modelIds = body.models && body.models.length ? body.models : [providerId];
      // Per-model limits (same resolution as applySettings): each model gets
      // its own ctx/maxTokens so a multi-model custom provider doesn't share
      // one cap across models with different windows.
      const providerLike = {
        contextWindow: body.contextWindow,
        maxTokens: body.maxTokens,
        modelConfig: body.modelConfig,
      };
      const limits = modelIds.map((id) => ({
        id,
        ...resolveModelLimits(providerLike, id),
      }));
      modelRuntime.registerProvider(providerId, {
        name: providerId,
        baseUrl: body.baseUrl,
        authHeader: true,
        api,
        models: limits.map(({ id, contextWindow, maxTokens }) => ({
          id,
          name: id,
          api,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
        })),
      });
    }
    if (body.apiKey) await modelRuntime.setRuntimeApiKey(providerId, body.apiKey);
    // effective key for the /models enumeration: prefer the just-provided key,
    // fall back to the persisted credential (so fetch works without re-entering
    // the key when hasKey is already true).
    const effKey = body.apiKey || credsState[providerId];

    // For custom OpenAI-compatible providers, try to enumerate real models via
    // GET {baseUrl}/models so the picker shows actual ids, not the fallback.
    let liveModels: { id: string; name: string; provider: string; reasoning: boolean; contextWindow: number }[] | null = null;
    let liveErr: string | undefined;
    if (body.custom && body.baseUrl && (body.api === "openai-completions" || body.api === "openai-responses" || (!body.api))) {
      try {
        const url = body.baseUrl.replace(/\/+$/, "") + "/models";
        const r = await fetch(url, {
          headers: effKey ? { Authorization: `Bearer ${effKey}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = (await r.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
          const ids = (j.data ?? j.models ?? [])
            .map((m) => m.id)
            .filter((id): id is string => Boolean(id));
          if (ids.length) {
            liveModels = ids.map((id) => ({
              id,
              name: id,
              provider: providerId,
              reasoning: false,
              contextWindow: body.contextWindow ?? 128000,
            }));
          }
        } else {
          liveErr = `endpoint returned ${r.status}`;
        }
      } catch (e) {
        liveErr = String(e);
      }
    }

    if (liveModels && liveModels.length) {
      return c.json({ ok: true, models: liveModels, source: "live" });
    }
    // Fallback: return whatever the SDK has registered for this provider.
    const models = await modelRuntime.getAvailable(providerId);
    return c.json({
      ok: true,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      })),
      source: "registered",
      warning: liveErr ? `could not fetch /models (${liveErr}); showing registered model` : undefined,
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// Force re-inject saved config into the running ModelRuntime (G03-Q5 "reload
// providers" — for v1 single-session, PUT already applies; this is the explicit
// hammer for custom-provider re-registration or key refresh).
app.post("/api/settings/reload", async (c) => {
  const res = await applySettings(modelRuntime, settingsState, credsState);
  return c.json({ ok: true, applied: res.applied, failed: res.failed });
});

// G05 reconnect replay: full snapshot — settled history + in-progress
// streamingMessage (current content blocks) + pending tool calls (marked
// running) + queue (steer/followUp) + buffered partialResults. The frontend
// fetches this on reconnect, then resumes the SSE stream for new events.
app.get("/api/snapshot", (c) => {
  const s = rt(c).session;
  const st = s.state;
  const streamingMessage = st.streamingMessage;
  const messages = s.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i) => ({
      id: String(i),
      role: m.role as "user" | "assistant",
      segments:
        m.role === "assistant"
          ? assistantSegments(m.content)
          : [{ kind: "text" as const, text: extractText(m.content) }],
    }));
  const inProgress = streamingMessage
    ? { segments: assistantSegments((streamingMessage as { content?: unknown }).content) }
    : null;
  const partials: Record<string, string[]> = {};
  for (const [k, v] of partialResultBuffer) partials[k] = v;
  return c.json({
    sessionId: s.sessionId,
    cwd: rt().cwd,
    model: s.model ? { id: s.model.id, provider: s.model.provider } : null,
    thinking: s.thinkingLevel,
    availableThinkingLevels: s.getAvailableThinkingLevels(),
    streaming: s.isStreaming,
    messages,
    inProgress,
    pendingToolCalls: [...st.pendingToolCalls],
    queue: { steering: [...s.getSteeringMessages()], followUp: [...s.getFollowUpMessages()] },
    partialResults: partials,
  });
});

app.get("/api/events", (c) => {
  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
        }
      };
      const s = rt(c).session;
      const m = s.model;
      send({
        type: "session_init",
        sessionId: s.sessionId,
        cwd: rt().cwd,
        model: m ? { id: m.id, provider: m.provider } : null,
        thinking: s.thinkingLevel,
        availableThinkingLevels: s.getAvailableThinkingLevels(),
        streaming: s.isStreaming,
      });
      unsub = s.subscribe((event) => {
        bufferPartial(event as { type?: string; toolCallId?: unknown; partialResult?: unknown });
        send(event);
        // G02: a turn just finalized its cost — flush this session's snapshot
        // immediately so the dashboard's all-time total updates without the
        // 15s interval lag. Idempotent (snapshot-overwrite).
        if ((event as { type?: string }).type === "agent_end") {
          void flushUsage();
        }
      });
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // closed
        }
      }, 20000);
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      unsub?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Production static serving (G04): if dist/ exists (after `vite build`),
// Hono serves the built frontend on the same :3000 port as the API, with an
// SPA fallback to index.html. In dev (tsx watch), dist may exist from a prior
// build but the user opens :5173 for HMR, so serving it on :3000 is harmless.
const DIST_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
if (existsSync(DIST_DIR)) {
  app.use("/*", serveStatic({ root: DIST_DIR }));
  // SPA fallback: any non-API, non-asset path returns the app shell.
  app.get("/*", (c) => c.html(readFileSync(join(DIST_DIR, "index.html"), "utf8")));
}

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  const mode = existsSync(DIST_DIR) ? "prod (single-port, serving dist/)" : "dev (API only; web on :5173)";
  console.log(`web-pi on http://127.0.0.1:${info.port} — ${mode} (cwd: ${rt().cwd})`);
});
