// Thin API client. In dev, the Vite server (5173/5177) calls the Hono backend
// (3000) cross-origin via CORS; in prod, both are same-origin on one port.
const API_BASE = import.meta.env.DEV ? "http://127.0.0.1:3000" : "";

// G01: append ?sessionId= to session-scoped routes (omitted → backend uses the
// default/first live session, keeping single-session callers working).
function sid(sessionId?: string): string {
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
}

export async function sendPrompt(
  message: string,
  streamingBehavior?: "steer" | "followUp",
  sessionId?: string,
): Promise<{ accepted: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/prompt${sid(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, streamingBehavior }),
  });
  return (await res.json()) as { accepted: boolean; error?: string };
}

export function eventStreamUrl(sessionId?: string): string {
  return `${API_BASE}/api/events${sid(sessionId)}`;
}

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
};

export type SlashCommand = { cmd: string; desc: string; kind: "prompt" | "skill" };

export async function getCommands(): Promise<SlashCommand[]> {
  const res = await fetch(`${API_BASE}/api/commands`);
  return (await res.json()) as SlashCommand[];
}

export async function getModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${API_BASE}/api/models`);
  return (await res.json()) as ModelInfo[];
}

export async function switchModel(
  provider: string,
  id: string,
  sessionId?: string,
): Promise<{ ok: boolean; error?: string; model?: { id: string; provider: string } }> {
  const res = await fetch(`${API_BASE}/api/model${sid(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, id }),
  });
  return (await res.json()) as { ok: boolean; error?: string; model?: { id: string; provider: string } };
}

export async function setThinkingLevel(
  level: string,
  sessionId?: string,
): Promise<{ ok: boolean; error?: string; level?: string }> {
  const res = await fetch(`${API_BASE}/api/thinking${sid(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  });
  return (await res.json()) as { ok: boolean; error?: string; level?: string };
}

export async function abortRun(sessionId?: string): Promise<{ aborted: boolean }> {
  const res = await fetch(`${API_BASE}/api/abort${sid(sessionId)}`, { method: "POST" });
  return (await res.json()) as { aborted: boolean };
}

export async function compactNow(customInstructions?: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/compact${sid(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customInstructions }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}

export type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type SessionStat = {
  sessionId: string;
  sessionFile?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: ContextUsage;
};

export async function getStats(sessionId?: string): Promise<SessionStat> {
  const res = await fetch(`${API_BASE}/api/stats${sid(sessionId)}`);
  return (await res.json()) as SessionStat;
}

export type HistSeg =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; id: string };

export type HistMessage = { id: string; role: "user" | "assistant"; segments: HistSeg[] };

export async function getMessages(sessionId?: string): Promise<HistMessage[]> {
  const res = await fetch(`${API_BASE}/api/messages${sid(sessionId)}`);
  return (await res.json()) as HistMessage[];
}

export type SessionListItem = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
};

export async function getSessions(cwd: string): Promise<SessionListItem[]> {
  const res = await fetch(`${API_BASE}/api/sessions?cwd=${encodeURIComponent(cwd)}`);
  return (await res.json()) as SessionListItem[];
}

export type DirEntry = { name: string; path: string };

export async function getDirs(
  path: string,
): Promise<{ path: string; parent: string; entries: DirEntry[]; error?: string }> {
  const res = await fetch(`${API_BASE}/api/dirs?path=${encodeURIComponent(path)}`);
  return (await res.json()) as { path: string; parent: string; entries: DirEntry[]; error?: string };
}

export async function deleteSession(path: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/sessions?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  return (await res.json()) as { ok: boolean; error?: string };
}

export type GitInfo = { repo: boolean; current: string; branches: string[] };

export async function getGitBranch(cwd?: string): Promise<GitInfo> {
  const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`${API_BASE}/api/git/branch${q}`);
  return (await res.json()) as GitInfo;
}

export async function gitCheckout(branch: string): Promise<{ ok: boolean; current?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/git/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch }),
  });
  return (await res.json()) as { ok: boolean; current?: string; error?: string };
}

export async function gitCreateBranch(
  name: string,
  from?: string,
): Promise<{ ok: boolean; current?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/git/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, from }),
  });
  return (await res.json()) as { ok: boolean; current?: string; error?: string };
}

export async function switchSession(
  cwd: string,
  sessionPath?: string,
): Promise<{
  ok: boolean;
  sessionId: string;
  cwd: string;
  hasModel: boolean;
  model: { id: string; provider: string } | null;
  thinking: string;
  error?: string;
}> {
  const res = await fetch(`${API_BASE}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, sessionPath }),
  });
  return (await res.json()) as {
    ok: boolean;
    sessionId: string;
    cwd: string;
    hasModel: boolean;
    model: { id: string; provider: string } | null;
    thinking: string;
    error?: string;
  };
}

// G01 multi-session
export type LiveSession = {
  sessionId: string;
  cwd: string;
  title: string | null;
  streaming: boolean;
  hasModel: boolean;
  model: { id: string; provider: string } | null;
  created: number;
};

export async function getLiveSessions(): Promise<{ sessions: LiveSession[]; max: number }> {
  const res = await fetch(`${API_BASE}/api/sessions/live`);
  return (await res.json()) as { sessions: LiveSession[]; max: number };
}

export async function renameSession(
  sessionId: string,
  title: string,
): Promise<{ ok: boolean; title?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/session/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, title }),
  });
  return (await res.json()) as { ok: boolean; title?: string; error?: string };
}

// ---- Settings (D01/G03: self-contained model provider config) ----

export type SettingsProvider = {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string; // wire format for custom providers (KnownApi)
  models?: string[]; // model ids this provider offers
  contextWindow?: number;
  maxTokens?: number;
  custom?: boolean;
  enabled?: boolean;
  apiKey?: string; // write-only: sent on PUT, never returned by GET
  hasKey?: boolean; // read-only: returned by GET
};

export type SettingsData = {
  providers: SettingsProvider[];
  maxSessions: number;
};

export async function getSettings(): Promise<SettingsData> {
  const res = await fetch(`${API_BASE}/api/settings`);
  return (await res.json()) as SettingsData;
}

export async function putSettings(
  data: SettingsData,
): Promise<{ ok: boolean; applied?: string[]; failed?: { id: string; error: string }[] }> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return (await res.json()) as { ok: boolean; applied?: string[]; failed?: { id: string; error: string }[] };
}

export type TestModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
};

export async function testProvider(input: {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  api?: string;
  models?: string[];
  contextWindow?: number;
  maxTokens?: number;
  custom?: boolean;
}): Promise<{
  ok: boolean;
  models?: TestModel[];
  source?: "live" | "registered";
  warning?: string;
  error?: string;
}> {
  const res = await fetch(`${API_BASE}/api/settings/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await res.json()) as {
    ok: boolean;
    models?: TestModel[];
    source?: "live" | "registered";
    warning?: string;
    error?: string;
  };
}

export async function reloadSettings(): Promise<{
  ok: boolean;
  applied?: string[];
  failed?: { id: string; error: string }[];
}> {
  const res = await fetch(`${API_BASE}/api/settings/reload`, { method: "POST" });
  return (await res.json()) as { ok: boolean; applied?: string[]; failed?: { id: string; error: string }[] };
}

// G05 reconnect replay: full snapshot restored before resuming SSE.
export type Snapshot = {
  sessionId: string;
  cwd: string;
  model: { id: string; provider: string } | null;
  thinking: string;
  streaming: boolean;
  messages: HistMessage[];
  inProgress: { segments: HistSeg[] } | null;
  pendingToolCalls: string[];
  queue: { steering: string[]; followUp: string[] };
  partialResults: Record<string, string[]>;
};

export async function getSnapshot(sessionId?: string): Promise<Snapshot> {
  const res = await fetch(`${API_BASE}/api/snapshot${sid(sessionId)}`);
  return (await res.json()) as Snapshot;
}
