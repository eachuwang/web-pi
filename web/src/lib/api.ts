// Thin API client. In dev, the Vite server (5173/5177) calls the Hono backend
// (3000) cross-origin via CORS; in prod, both are same-origin on one port.
const API_BASE = import.meta.env.DEV ? "http://127.0.0.1:3000" : "";

export async function sendPrompt(
  message: string,
  streamingBehavior?: "steer" | "followUp",
): Promise<{ accepted: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, streamingBehavior }),
  });
  return (await res.json()) as { accepted: boolean; error?: string };
}

export function eventStreamUrl(): string {
  return `${API_BASE}/api/events`;
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
): Promise<{ ok: boolean; error?: string; model?: { id: string; provider: string } }> {
  const res = await fetch(`${API_BASE}/api/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, id }),
  });
  return (await res.json()) as { ok: boolean; error?: string; model?: { id: string; provider: string } };
}

export async function setThinkingLevel(
  level: string,
): Promise<{ ok: boolean; error?: string; level?: string }> {
  const res = await fetch(`${API_BASE}/api/thinking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  });
  return (await res.json()) as { ok: boolean; error?: string; level?: string };
}

export async function abortRun(): Promise<{ aborted: boolean }> {
  const res = await fetch(`${API_BASE}/api/abort`, { method: "POST" });
  return (await res.json()) as { aborted: boolean };
}

export async function compactNow(customInstructions?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/compact`, {
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

export async function getStats(): Promise<SessionStat> {
  const res = await fetch(`${API_BASE}/api/stats`);
  return (await res.json()) as SessionStat;
}

export type HistSeg =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; id: string };

export type HistMessage = { id: string; role: "user" | "assistant"; segments: HistSeg[] };

export async function getMessages(): Promise<HistMessage[]> {
  const res = await fetch(`${API_BASE}/api/messages`);
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
