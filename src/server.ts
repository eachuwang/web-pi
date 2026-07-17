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
//   GET  /api/events           SSE stream of AgentSessionEvent

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
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

const PORT = Number(process.env.PORT ?? 3000);
const cwd = process.env.WEB_PI_CWD ?? process.cwd();

const modelRuntime = await ModelRuntime.create();

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

const holder: { runtime: AgentSessionRuntime } = {
  runtime: await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(cwd),
  }),
};
const rt = (): AgentSessionRuntime => holder.runtime;

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

app.get("/api/health", (c) => {
  const s = rt().session;
  const m = s.model;
  return c.json({
    ok: true,
    sessionId: s.sessionId,
    cwd: rt().cwd,
    streaming: s.isStreaming,
    hasModel: Boolean(m),
    model: m ? { id: m.id, provider: m.provider } : null,
    thinking: s.thinkingLevel,
  });
});

app.get("/api/stats", (c) => c.json(rt().session.getSessionStats()));

app.get("/api/messages", (c) => {
  const msgs = rt().session.messages;
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
  const loader = rt().services.resourceLoader;
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
  await rt().session.setModel(m);
  return c.json({ ok: true, model: { id: m.id, provider: m.provider } });
});

app.post("/api/thinking", async (c) => {
  const { level } = await c.req.json<{ level?: string }>();
  if (!level || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
    return c.json({ ok: false, error: "invalid level" }, 400);
  }
  rt().session.setThinkingLevel(level as ThinkingLevel);
  return c.json({ ok: true, level });
});

app.post("/api/prompt", async (c) => {
  const body = await c.req.json<{
    message?: string;
    streamingBehavior?: "steer" | "followUp";
  }>();
  const message = body.message?.trim();
  if (!message) return c.json({ accepted: false, error: "message required" }, 400);
  const result = await new Promise<{ accepted: boolean; error?: string }>((resolve) => {
    rt().session
      .prompt(message, {
        streamingBehavior: body.streamingBehavior,
        preflightResult: (ok) => resolve({ accepted: ok }),
      })
      .catch((e: unknown) => resolve({ accepted: false, error: String(e) }));
  });
  return c.json(result, result.accepted ? 200 : 409);
});

app.post("/api/abort", async (c) => {
  await rt().session.abort();
  return c.json({ aborted: true });
});

app.post("/api/compact", async (c) => {
  const { customInstructions } = await c.req.json<{ customInstructions?: string }>();
  try {
    await rt().session.compact(customInstructions);
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
  if (path === rt().session.sessionFile) {
    return c.json({ ok: false, error: "cannot delete the active session" }, 409);
  }
  try {
    await unlink(path);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
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

app.post("/api/session", async (c) => {
  const { cwd: newCwd, sessionPath } = await c.req.json<{ cwd?: string; sessionPath?: string }>();
  if (!newCwd) return c.json({ ok: false, error: "cwd required" }, 400);
  try {
    rt().session.dispose();
    const sm = sessionPath ? SessionManager.open(sessionPath, undefined, newCwd) : SessionManager.create(newCwd);
    holder.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: newCwd,
      agentDir: getAgentDir(),
      sessionManager: sm,
    });
    const s = rt().session;
    const m = s.model;
    return c.json({
      ok: true,
      sessionId: s.sessionId,
      cwd: rt().cwd,
      hasModel: Boolean(m),
      model: m ? { id: m.id, provider: m.provider } : null,
      thinking: s.thinkingLevel,
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
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
      const s = rt().session;
      const m = s.model;
      send({
        type: "session_init",
        sessionId: s.sessionId,
        cwd: rt().cwd,
        model: m ? { id: m.id, provider: m.provider } : null,
        thinking: s.thinkingLevel,
      });
      unsub = s.subscribe((event) => send(event));
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

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  console.log(`web-pi on http://127.0.0.1:${info.port} (cwd: ${rt().cwd})`);
});
