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
import fs from "node:fs";
import { readdirSync, readFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { unlink, mkdir, writeFile, rm } from "node:fs/promises";
import { promisify } from "util";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  parseFrontmatter,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  IGNORED_NAMES,
  IGNORED_SUFFIXES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  allowedRoots as allowedRootsFn,
  getAudioMime,
  getImageMime,
  getLanguage,
  isPathAllowed,
  isPdfPath,
  resolveDirentIsDirectory,
} from "./file-serving";
import {
  applySettings,
  loadCredentials,
  loadSettings,
  loadUsage,
  recordUsage,
  resolveModelLimits,
  saveCredentials,
  saveSettings,
  CONFIG_DIR,
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
// F06: additionalSkillPaths injects ~/.web-pi/skills so skills installed by
// the F06 panel (pure-HTTP from skills.sh/GitHub, no `npx skills`) are
// discovered by the agent's loader — self-contained (G04), no ~/.pi dependency
// for installed skills.
const WEB_PI_SKILLS_DIR = join(CONFIG_DIR, "skills");
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
    resourceLoaderOptions: { additionalSkillPaths: [WEB_PI_SKILLS_DIR] },
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
// Stall detection (Task2): last epoch-ms an event was emitted for each session.
// Updated in the SSE subscribe handler. If session.isStreaming but now -
// lastEventAt exceeds a threshold, the upstream likely hung and the frontend
// should show "possibly disconnected" instead of spinning forever.
const sessionLastEvent = new Map<string, number>();
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
// Stall threshold (ms): a streaming turn silent this long is presumed hung —
// the SSE keepalive tick pushes a `session_stall` frame past this so the
// frontend can surface "possibly disconnected" instead of spinning forever.
const STALL_MS = 60_000;
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
  const runtime = rt(c);
  const s = runtime.session;
  const m = s.model;
  const lastEventAt = sessionLastEvent.get(s.sessionId) ?? 0;
  const streaming = s.isStreaming;
  // ms since the last SSE event while streaming — the frontend polls this to
  // cross-check its own stall watchdog (a hung upstream keeps isStreaming=true
  // but stops emitting events). 0 when not streaming.
  const stalledMs = streaming && lastEventAt ? Date.now() - lastEventAt : 0;
  return c.json({
    ok: true,
    sessionId: s.sessionId,
    cwd: runtime.cwd,
    streaming,
    lastEventAt,
    stalledMs,
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
      maxTokens: m.maxTokens,
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
    // F01: image attachments. ImageContent = { type: "image", data: <base64
    // no prefix>, mimeType }. Frontend reads dropped/pasted files into base64
    // and passes them through; SDK prompt()/steer()/followUp() all accept images.
    images?: { type: "image"; data: string; mimeType: string }[];
  }>();
  const message = body.message?.trim();
  if (!message) return c.json({ accepted: false, error: "message required" }, 400);
  // F01: cap image payload size defensively (per-image 5MB base64 ≈ 6.7MB) so a
  // runaway paste doesn't OOM the in-process session. Reject the whole request.
  const MAX_IMAGES = 4;
  const MAX_IMG_BYTES = 5 * 1024 * 1024;
  const images = body.images?.slice(0, MAX_IMAGES).filter((im) => {
    return im && im.type === "image" && typeof im.data === "string" && typeof im.mimeType === "string" && im.data.length <= MAX_IMG_BYTES * 1.4;
  });
  // G01: auto-title this session from the first user prompt (if unnamed).
  const runtime = rt(c);
  const meta = sessionMeta.get(runtime.session.sessionId);
  if (meta && !meta.title) meta.title = message.slice(0, 60);
  const result = await new Promise<{ accepted: boolean; error?: string }>((resolve) => {
    runtime.session
      .prompt(message, {
        streamingBehavior: body.streamingBehavior,
        images,
        preflightResult: (ok) => resolve({ accepted: ok, error: ok ? undefined : "session is busy (still streaming)" }),
      })
      .catch((e: unknown) => resolve({ accepted: false, error: String(e) }));
  });
  return c.json(result, result.accepted ? 200 : 409);
});

// F03: session fork — list forkable user messages + fork from one.
// SDK: session.getUserMessagesForForking() → [{entryId, text}]; runtime.fork(entryId,
// {position:"at"}) creates a branched session file and swaps the runtime's
// internal session to it (same runtime object, new sessionId). We re-key the
// sessions/sessionMeta maps so ?sessionId=newId resolves to the same runtime.
app.get("/api/fork-points", (c) => {
  const s = rt(c).session;
  const points = s.getUserMessagesForForking().map((p) => ({ entryId: p.entryId, text: p.text }));
  return c.json({ points });
});

app.post("/api/fork", async (c) => {
  const { entryId } = await c.req.json<{ entryId?: string }>();
  if (!entryId) return c.json({ ok: false, error: "entryId required" }, 400);
  const runtime = rt(c);
  // Refuse while streaming — forking mid-turn would branch an incomplete state.
  if (runtime.session.isStreaming) return c.json({ ok: false, error: "session is busy (still streaming)" }, 409);
  const oldId = runtime.session.sessionId;
  const oldFile = runtime.session.sessionFile;
  const oldMeta = sessionMeta.get(oldId);
  const oldCwd = oldMeta?.cwd ?? rt().cwd;
  try {
    const result = await runtime.fork(entryId, { position: "at" });
    if (result.cancelled) return c.json({ ok: false, error: "fork cancelled" }, 400);
    const newId = runtime.session.sessionId;
    // runtime.fork swaps THIS runtime to the new branch (same object, new id).
    // Re-key the map so ?sessionId=newId resolves to it.
    if (newId !== oldId) {
      sessions.delete(oldId);
      sessions.set(newId, runtime);
      sessionMeta.delete(oldId);
      sessionMeta.set(newId, {
        cwd: oldCwd,
        created: Date.now(),
        ...(oldMeta?.title ? { title: `${oldMeta.title} (fork)` } : {}),
      });
    }
    // F03: preserve the ORIGINAL as a separate live runtime (G01 multi-session
    // — fork shouldn't evict the session you forked from). Re-open the original
    // session file; makeSession registers it in the map + meta. Best-effort:
    // if we're at the session cap or re-open fails, the original is still
    // saved on disk (resumable via the cwd picker) — the fork itself succeeded.
    if (oldFile) {
      try {
        const orig = await makeSession({ cwd: oldCwd, sessionPath: oldFile });
        if (oldMeta?.title) {
          const m = sessionMeta.get(orig.session.sessionId);
          if (m) m.title = oldMeta.title;
        }
      } catch {
        // best-effort — original remains on disk
      }
    }
    return c.json({ ok: true, sessionId: newId });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
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
  // Session-scoped: ?sessionId= picks the runtime (and thus its cwd) so the
  // branch reflects the ACTIVE session's cwd, not the first live session.
  const cwd = c.req.query("cwd") ?? rt(c).cwd;
  const cur = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!cur.ok) return c.json({ repo: false, current: "", branches: [] });
  const lst = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const branches = lst.ok ? lst.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  return c.json({ repo: true, current: cur.stdout.trim(), branches });
});

// F04: list git worktrees so the user can switch the session cwd to a different
// worktree (each is an independent working tree on a branch). `git worktree list
// --porcelain` emits blocks separated by blank lines: first line "worktree
// <path>", then "HEAD <sha>", then "branch <ref>" or "detached". The first
// block is the main worktree. Switching = switchSession(worktreePath) on the
// client (creates a new live session in that cwd); no new switch route needed.
app.get("/api/git/worktrees", async (c) => {
  const cwd = c.req.query("cwd") ?? rt(c).cwd;
  const repo = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!repo.ok) return c.json({ repo: false, worktrees: [] });
  const lst = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (!lst.ok) return c.json({ repo: true, worktrees: [] });
  const blocks = lst.stdout.split(/\n\s*\n/).filter(Boolean);
  const worktrees = blocks.map((blk, i) => {
    const lines = blk.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const headLine = lines.find((l) => l.startsWith("HEAD "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const detached = lines.includes("detached");
    const path = pathLine ? pathLine.slice("worktree ".length).trim() : "";
    return {
      path,
      head: headLine ? headLine.slice("HEAD ".length).trim().slice(0, 12) : "",
      branch: detached
        ? "(detached)"
        : branchLine
          ? branchLine.slice("branch refs/heads/".length).trim()
          : "",
      isMain: i === 0,
    };
  });
  return c.json({ repo: true, worktrees });
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

// F05: file browser — single route dispatched by ?type=, borrowed from pi-web.
// list: enumerate a directory (dirs first, IGNORED_NAMES filtered). read: text
// content + language, or stream media (image/audio/PDF) with HTTP range support.
// download: inline attachment. meta: size/language/mime without the body. watch:
// SSE fs.watch for live preview refresh. All constrained to allowedRoots (the
// live session cwds) so `../` can't read project-external files.
// F06: skill management (pure-HTTP, self-contained to ~/.web-pi/skills — no
// `npx skills` runtime dependency, per the user's (c) decision). List uses the
// agent's own resourceLoader (zero drift with what the agent sees). Enable/
// disable toggles SKILL.md frontmatter `disable-model-invocation` (surgical
// line edit, preserves other YAML). Search hits skills.sh /api/search. Install
// fetches SKILL.md from the GitHub source repo (located via the trees API) and
// writes to ~/.web-pi/skills/<name>/ — discovered by the agent via the
// additionalSkillPaths injected in createRuntime above.
const SKILLS_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "web-pi" };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

app.get("/api/skills", async (c) => {
  const loader = rt(c).services.resourceLoader;
  try { await loader.reload?.(); } catch { /* reload optional */ }
  const { skills } = loader.getSkills();
  return c.json({
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      baseDir: s.baseDir,
      disableModelInvocation: s.disableModelInvocation,
    })),
    skillsDir: WEB_PI_SKILLS_DIR,
  });
});

app.patch("/api/skills", async (c) => {
  const { filePath, disableModelInvocation } = await c.req.json<{ filePath?: string; disableModelInvocation?: boolean }>();
  if (!filePath) return c.json({ error: "filePath required" }, 400);
  if (!existsSync(filePath)) return c.json({ error: "file not found" }, 404);
  const content = readFileSync(filePath, "utf8");
  const key = "disable-model-invocation";
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
  const alreadySet = Boolean(frontmatter[key]);
  let updated = content;
  if (disableModelInvocation && !alreadySet) {
    updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
    if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
  } else if (!disableModelInvocation && alreadySet) {
    updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
  }
  if (updated !== content) await writeFile(filePath, updated, "utf8");
  return c.json({ success: true });
});

app.post("/api/skills/search", async (c) => {
  const { query, limit } = await c.req.json<{ query?: string; limit?: number }>();
  if (!query?.trim()) return c.json({ error: "query required" }, 400);
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  try {
    const res = await fetch(`${SKILLS_API_BASE}/api/search?q=${encodeURIComponent(query.trim())}&limit=${lim}`, { cache: "no-store" });
    if (!res.ok) return c.json({ error: `skills.sh search failed (HTTP ${res.status})` }, 502);
    const data = (await res.json()) as { skills?: Array<{ id?: string; name?: string; source?: string; installs?: number }> };
    const results = (data.skills ?? [])
      .map((s) => ({
        package: s.id ?? `${s.source ?? ""}/${s.name ?? ""}`,
        name: s.name ?? "",
        installs: s.installs ?? 0,
        url: s.id ? `${SKILLS_API_BASE}/${s.id}` : "",
      }))
      .sort((a, b) => b.installs - a.installs);
    return c.json({ results });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// F06 install: locate SKILL.md in the source GitHub repo via the trees API,
// fetch its raw content, write to ~/.web-pi/skills/<name>/SKILL.md. Best-effort:
// if the tree call is rate-limited or the skill can't be located, surface a
// clear error. Pure HTTP (no `npx skills`).
app.post("/api/skills/install", async (c) => {
  const { package: pkg, scope } = await c.req.json<{ package?: string; scope?: "global" | "project" }>();
  if (!pkg?.trim()) return c.json({ error: "package required" }, 400);
  // pkg = "owner/repo/skillName" (skills.sh id) or "owner/repo@skillName".
  const cleaned = pkg.trim().replace(/^.*@/, "").replace(/^github:\//, "");
  const parts = cleaned.split("/");
  if (parts.length < 3) return c.json({ error: "package must be owner/repo/skillName" }, 400);
  const [owner, repo, ...rest] = parts;
  const skillName = rest.join("/");
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  try {
    const treeRes = await fetch(`https://api.github.com/repos/${ownerEnc}/${repoEnc}/git/trees/HEAD?recursive=1`, { headers: githubHeaders() });
    if (!treeRes.ok) {
      const detail = treeRes.status === 403 || treeRes.status === 429
        ? "GitHub API rate-limited — set GITHUB_TOKEN env to raise the limit"
        : `GitHub trees API HTTP ${treeRes.status}`;
      return c.json({ error: detail }, 502);
    }
    const tree = (await treeRes.json()) as { tree?: Array<{ path?: string; type?: string }> };
    // skills.sh's skillName can differ from the GitHub dir name (e.g. skillName
    // "vercel-react-best-practices" but the repo dir is "react-best-practices").
    // Match by the dir containing SKILL.md, via exact / suffix / contains
    // (case-insensitive) — robust against prefix drift.
    const lower = skillName.toLowerCase();
    const blobs = (tree.tree ?? []).filter((t) => t.type === "blob" && t.path?.toLowerCase().endsWith("/skill.md"));
    const dirName = (p?: string) => {
      if (!p) return "";
      const parts = p.toLowerCase().split("/"); // [..., "<dir>", "skill.md"]
      return parts[parts.length - 2] ?? "";
    };
    const blob =
      blobs.find((t) => dirName(t.path) === lower) ??
      blobs.find((t) => { const d = dirName(t.path); return d && (lower.endsWith(d) || d.endsWith(lower) || lower.includes(d) || d.includes(lower)); }) ??
      blobs.find((t) => t.path?.toLowerCase().includes(lower));
    if (!blob?.path) return c.json({ error: `SKILL.md not found in ${owner}/${repo} matching ${skillName}` }, 404);
    const rawRes = await fetch(`https://raw.githubusercontent.com/${ownerEnc}/${repoEnc}/HEAD/${blob.path}`, { headers: githubHeaders() });
    if (!rawRes.ok) return c.json({ error: `fetch SKILL.md failed (HTTP ${rawRes.status})` }, 502);
    const content = await rawRes.text();
    // Write to global ~/.web-pi/skills/<name>/SKILL.md (project-scope deferred —
    // the agent's additionalSkillPaths covers the global dir; project-scope would
    // need a per-cwd dir + that cwd's loader config).
    const skillDir = join(WEB_PI_SKILLS_DIR, skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
    return c.json({ success: true, name: skillName, path: join(skillDir, "SKILL.md"), source: `${owner}/${repo}` });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.post("/api/skills/uninstall", async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: "name required" }, 400);
  const skillDir = join(WEB_PI_SKILLS_DIR, name.trim());
  if (!skillDir.startsWith(WEB_PI_SKILLS_DIR)) return c.json({ error: "invalid name" }, 400);
  try { await rm(skillDir, { recursive: true, force: true }); return c.json({ success: true }); }
  catch (e) { return c.json({ error: String(e) }, 500); }
});

app.get("/api/files/*", async (c) => {
  const reqPath = c.req.path.replace(/^\/api\/files\/?/, "");
  const filePath = reqPath ? "/" + reqPath : "/";
  const type = (c.req.query("type") ?? "list") as "list" | "read" | "download" | "meta" | "watch";
  const roots = allowedRootsFn([...sessions.values()].map((rt) => ({ cwd: rt.cwd })));
  if (!isPathAllowed(filePath, roots)) {
    return c.json({ error: "access denied (outside session cwd)" }, 403);
  }
  let stat: fs.Stats;
  try {
    stat = statSync(filePath);
  } catch {
    return c.json({ error: "not found" }, 404);
  }

  if (type === "list") {
    if (!stat.isDirectory()) return c.json({ error: "not a directory" }, 400);
    const dirents = readdirSync(filePath, { withFileTypes: true });
    const entries = dirents
      .filter((d) => !IGNORED_NAMES.has(d.name) && !IGNORED_SUFFIXES.some((s) => d.name.endsWith(s)))
      .map((d) => {
        const isDir = resolveDirentIsDirectory(d, path.join(filePath, d.name));
        return isDir === null ? null : { name: d.name, isDir };
      })
      .filter((x): x is { name: string; isDir: boolean } => x !== null)
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    return c.json({ entries, path: filePath });
  }

  if (!stat.isFile()) return c.json({ error: "not a file" }, 400);

  if (type === "meta") {
    return c.json({
      size: stat.size,
      language: getLanguage(filePath),
      mime: getImageMime(filePath) || getAudioMime(filePath) || (isPdfPath(filePath) ? "application/pdf" : "text/plain"),
      isImage: getImageMime(filePath) !== null,
      isAudio: getAudioMime(filePath) !== null,
      isPdf: isPdfPath(filePath),
    });
  }

  // download: inline (browser renders or saves).
  if (type === "download") {
    const mime = getImageMime(filePath) || getAudioMime(filePath) || (isPdfPath(filePath) ? "application/pdf" : "application/octet-stream");
    const data = readFileSync(filePath);
    return new Response(data, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache",
        "Content-Disposition": `inline; filename="${path.basename(filePath)}"`,
      },
    });
  }

  // read: text → {content,language}; media/pdf → stream bytes (with range).
  const imageMime = getImageMime(filePath);
  if (imageMime) {
    if (stat.size > IMAGE_PREVIEW_MAX_BYTES) return c.json({ error: "image too large (>10MB)" }, 413);
    return streamFile(filePath, stat, imageMime, c.req.header("range") ?? null);
  }
  const audioMime = getAudioMime(filePath);
  if (audioMime) return streamFile(filePath, stat, audioMime, c.req.header("range") ?? null);
  if (isPdfPath(filePath)) return streamFile(filePath, stat, "application/pdf", c.req.header("range") ?? null);

  // text
  if (stat.size > TEXT_PREVIEW_MAX_BYTES) return c.json({ error: "file too large for preview (>256KB)" }, 413);
  const content = readFileSync(filePath, "utf-8");
  return c.json({ content, language: getLanguage(filePath), size: stat.size });

  function streamFile(p: string, s: fs.Stats, contentType: string, rangeHeader: string | null) {
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${path.basename(p)}"`,
    };
    if (!rangeHeader) {
      const stream = createReadStream(p);
      return new Response(stream as unknown as ReadableStream, { headers: { ...headers, "Content-Length": String(s.size) } });
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!m) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${s.size}` } });
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : s.size - 1;
    if (!m[1] && m[2]) { start = Math.max(s.size - Number(m[2]), 0); end = s.size - 1; }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= s.size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${s.size}` } });
    }
    end = Math.min(end, s.size - 1);
    const stream = createReadStream(p, { start, end });
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${s.size}` },
    });
  }
});

// F05: SSE file watch — emits `change` on fs.watch so the frontend re-fetches
// (live preview refresh for logs/generated files).
app.get("/api/files-watch", (c) => {
  const filePath = c.req.query("path") ?? "";
  const roots = allowedRootsFn([...sessions.values()].map((rt) => ({ cwd: rt.cwd })));
  if (!filePath || !isPathAllowed(filePath, roots)) return c.json({ error: "access denied" }, 403);
  const encoder = new TextEncoder();
  let watcher: fs.FSWatcher | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      send("connected", { filePath });
      try {
        watcher = fs.watch(filePath, () => {
          try {
            const s = statSync(filePath);
            send("change", { mtime: s.mtime.toISOString(), size: s.size });
          } catch {
            send("change", { mtime: new Date().toISOString(), size: 0 });
          }
        });
        watcher.on("error", () => { try { controller.close(); } catch { /* */ } });
      } catch {
        send("error", { message: "failed to watch" });
        controller.close();
      }
    },
    cancel() { try { watcher?.close(); } catch { /* */ } },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
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
  sessionLastEvent.delete(sessionId);
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
    reasoning: p.reasoning,
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
    // Per-model ctx/maxTokens/reasoning overrides: drop blanks/zeroes so unset
    // fields fall back to the provider default at registration time. `source`
    // ("live" from GET /models | "manual" tier-pick) is preserved so the UI can
    // keep showing live values read-only across reloads.
    const mc: Record<string, { contextWindow?: number; maxTokens?: number; reasoning?: boolean; source?: "live" | "manual" }> = {};
    if (p.modelConfig && typeof p.modelConfig === "object") {
      for (const [mid, ml] of Object.entries(p.modelConfig)) {
        if (!mid) continue;
        const cfg = ml as { contextWindow?: number; maxTokens?: number; reasoning?: boolean; source?: "live" | "manual" };
        const ctx = typeof cfg.contextWindow === "number" && cfg.contextWindow > 0 ? cfg.contextWindow : undefined;
        const max = typeof cfg.maxTokens === "number" && cfg.maxTokens > 0 ? cfg.maxTokens : undefined;
        const reasoning = typeof cfg.reasoning === "boolean" ? cfg.reasoning : undefined;
        const source = cfg.source === "live" || cfg.source === "manual" ? cfg.source : undefined;
        if (ctx || max || reasoning !== undefined) {
          mc[mid] = {
            ...(ctx ? { contextWindow: ctx } : {}),
            ...(max ? { maxTokens: max } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
            ...(source ? { source } : {}),
          };
        }
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
      reasoning: typeof p.reasoning === "boolean" ? p.reasoning : undefined,
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
// model ids, not just the registered fallback. ALSO parse each entry's
// context_length / max_completion_tokens / reasoning when the endpoint returns
// them (OpenRouter, Together, vLLM, …) so ctx/maxTokens/reasoning auto-fill —
// the UI then shows them read-only instead of asking the user to type token
// counts. Endpoints that don't surface these fields (plain OpenAI /models) →
// the UI falls back to a tier dropdown. Does NOT persist the key.
//
// Field-name variance across OpenAI-compatible /models responses is real, so we
// probe several known keys (top-level + nested under top_provider) per entry.
function pickLimit(m: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === "number" && v > 0) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      const n = Number(v);
      if (n > 0) return n;
    }
  }
  return undefined;
}
function pickNested(m: Record<string, unknown>, container: string, keys: string[]): number | undefined {
  const c = m[container];
  if (c && typeof c === "object") return pickLimit(c as Record<string, unknown>, keys);
  return undefined;
}
const CTX_KEYS = ["context_length", "context_window", "max_context_length", "max_context_tokens", "max_model_len"];
const MAX_KEYS = ["max_completion_tokens", "max_output_tokens", "max_tokens", "max_generation_tokens", "output_token_limit"];
function extractLiveLimits(m: Record<string, unknown>): { contextWindow?: number; maxTokens?: number; reasoning?: boolean } {
  const contextWindow = pickLimit(m, CTX_KEYS) ?? pickNested(m, "top_provider", CTX_KEYS);
  const maxTokens = pickLimit(m, MAX_KEYS) ?? pickNested(m, "top_provider", MAX_KEYS);
  const reasoningRaw = m["reasoning"] ?? pickNested(m, "top_provider", ["reasoning"]);
  const reasoning = reasoningRaw === true || reasoningRaw === "true";
  return { contextWindow, maxTokens, reasoning };
}

app.post("/api/settings/test", async (c) => {
  const body = await c.req.json<{
    providerId?: string;
    apiKey?: string;
    baseUrl?: string;
    api?: string;
    models?: string[];
    contextWindow?: number;
    maxTokens?: number;
    modelConfig?: Record<string, { contextWindow?: number; maxTokens?: number; reasoning?: boolean; source?: "live" | "manual" }>;
    custom?: boolean;
  }>();
  const providerId = body.providerId?.trim();
  if (!providerId) return c.json({ ok: false, error: "providerId required" }, 400);
  try {
    if (body.apiKey) await modelRuntime.setRuntimeApiKey(providerId, body.apiKey);
    // effective key for the /models enumeration: prefer the just-provided key,
    // fall back to the persisted credential (so fetch works without re-entering
    // the key when hasKey is already true).
    const effKey = body.apiKey || credsState[providerId];

    // 1) For custom OpenAI-compatible providers, GET {baseUrl}/models to
    //    enumerate real model ids AND auto-fill ctx/maxTokens/reasoning from the
    //    response when the endpoint surfaces them (B2). Plain OpenAI /models
    //    returns only ids → ctx/maxTokens stay undefined → UI tier dropdown.
    type LiveLimits = { contextWindow?: number; maxTokens?: number; reasoning?: boolean };
    type LiveModel = { id: string; name: string; provider: string; reasoning: boolean; contextWindow: number; maxTokens: number; source: "live"; _live: LiveLimits };
    let liveModels: LiveModel[] | null = null;
    let liveErr: string | undefined;
    if (body.custom && body.baseUrl && (body.api === "openai-completions" || body.api === "openai-responses" || (!body.api))) {
      try {
        const url = body.baseUrl.replace(/\/+$/, "") + "/models";
        const r = await fetch(url, {
          headers: effKey ? { Authorization: `Bearer ${effKey}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = (await r.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
          const entries = (j.data ?? j.models ?? []) as Record<string, unknown>[];
          const parsed = entries
            .map((m): LiveModel | null => {
              const id = typeof m.id === "string" ? m.id : undefined;
              if (!id) return null;
              const lim = extractLiveLimits(m);
              return {
                id,
                name: typeof m.name === "string" ? m.name : id,
                provider: providerId,
                reasoning: Boolean(lim.reasoning),
                contextWindow: lim.contextWindow ?? (body.contextWindow ?? 128000),
                maxTokens: lim.maxTokens ?? (body.maxTokens ?? 8192),
                source: "live",
                // carry the live-detected values so the UI can show them read-only
                _live: lim,
              };
            })
            .filter((x): x is LiveModel => x !== null);
          if (parsed.length) liveModels = parsed;
        } else {
          liveErr = `endpoint returned ${r.status}`;
        }
      } catch (e) {
        liveErr = String(e);
      }
    }

    // 2) Register the custom provider (when custom) with per-model limits.
    //    Prefer live-detected values (source:"live"); else the user's per-model
    //    modelConfig override (source:"manual"); else body defaults; else global.
    if (body.custom && body.baseUrl) {
      const api = body.api || "openai-completions";
      const liveById = new Map((liveModels ?? []).map((m) => [m.id, m]));
      const modelIds =
        liveModels && liveModels.length
          ? liveModels.map((m) => m.id)
          : body.models && body.models.length
            ? body.models
            : [providerId];
      const providerLike = {
        contextWindow: body.contextWindow,
        maxTokens: body.maxTokens,
        modelConfig: body.modelConfig,
      };
      const limits = modelIds.map((id) => {
        const live = liveById.get(id)?._live;
        const resolved = resolveModelLimits(providerLike, id);
        // live-detected values win over stored config (they're fresh from the
        // endpoint); reasoning likewise.
        return {
          id,
          contextWindow: live?.contextWindow ?? resolved.contextWindow,
          maxTokens: live?.maxTokens ?? resolved.maxTokens,
          reasoning: live?.reasoning ?? resolved.reasoning,
        };
      });
      modelRuntime.registerProvider(providerId, {
        name: providerId,
        baseUrl: body.baseUrl,
        authHeader: true,
        api,
        models: limits.map(({ id, contextWindow, maxTokens, reasoning }) => ({
          id,
          name: id,
          api,
          reasoning,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
        })),
      });
    }

    // 3) Return the model list for the picker + auto-fill. Each entry carries
    //    the resolved ctx/maxTokens/reasoning + source ("live" if the endpoint
    //    surfaced the value, else "registered"). The UI writes the live values
    //    into modelConfig so they show read-only on next load.
    if (liveModels && liveModels.length) {
      const out = liveModels.map((m) => {
        const lim = m._live ?? {};
        const hasLive = Boolean(lim.contextWindow || lim.maxTokens || lim.reasoning);
        return {
          id: m.id,
          name: m.name,
          provider: providerId,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          // per-field "auto-filled" flags so the UI knows which fields came live
          // (read-only) vs which are the fallback (tier dropdown).
          contextWindowLive: lim.contextWindow != null,
          maxTokensLive: lim.maxTokens != null,
          reasoningLive: lim.reasoning === true,
          source: hasLive ? "live" : ("registered" as const),
        };
      });
      return c.json({ ok: true, models: out, source: "live", warning: liveErr });
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
        maxTokens: m.maxTokens,
        contextWindowLive: false,
        maxTokensLive: false,
        reasoningLive: false,
        source: "registered" as const,
        warning: liveErr ? `could not fetch /models (${liveErr}); showing registered model` : undefined,
      })),
      source: "registered",
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
      const rt_ = rt(c);
      const m = s.model;
      send({
        type: "session_init",
        sessionId: s.sessionId,
        // BUG FIX (F04 surfaced): use rt(c).cwd (this connection's runtime),
        // NOT rt().cwd — rt() with no arg returns the FIRST live session, so
        // every session_init used to report the first session's cwd regardless
        // of which session the SSE was for. Switching cwd/worktree now reports
        // the correct cwd.
        cwd: rt_.cwd,
        model: m ? { id: m.id, provider: m.provider } : null,
        thinking: s.thinkingLevel,
        availableThinkingLevels: s.getAvailableThinkingLevels(),
        streaming: s.isStreaming,
      });
      unsub = s.subscribe((event) => {
        bufferPartial(event as { type?: string; toolCallId?: unknown; partialResult?: unknown });
        send(event);
        // Stall detection: record the last event time so /api/health can report
        // how long the session has been silent while streaming.
        sessionLastEvent.set(s.sessionId, Date.now());
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
          // Stall probe (Task2): if the session is streaming but hasn't emitted
          // a real event in STALL_MS, push a `session_stall` data frame so the
          // frontend surfaces "possibly disconnected" instead of spinning. The
          // frontend dedups (fires onStall only on the false→true transition).
          const last = sessionLastEvent.get(s.sessionId) ?? 0;
          if (s.isStreaming && last && Date.now() - last > STALL_MS) {
            send({ type: "session_stall", stalledMs: Date.now() - last });
          }
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
