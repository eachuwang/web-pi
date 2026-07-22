import { Fragment, useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  abortRun,
  compactNow,
  deleteSession,
  disposeSession,
  forkSession,
  getCommands,
  getForkPoints,
  getGitBranch,
  getMessages,
  getModels,
  getSessions,
  getSnapshot,
  getStats,
  getUsage,
  getLiveSessions,
  renameSession,
  sendPrompt,
  setThinkingLevel,
  switchModel,
  switchSession,
  type GitInfo,
  type HistMessage,
  type ImageContent,
  type ModelInfo,
  type SessionListItem,
  type SessionStat,
  type SlashCommand,
  type UsageData,
  type ForkPoint,
} from "./lib/api";
import { useEventStream, type AgentEvent } from "./hooks/useEventStream";
import { CwdPicker } from "./components/CwdPicker";
import { GitBranchPicker } from "./components/GitBranchPicker";
import { SkillPicker } from "./components/SkillPicker";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { Sidebar } from "./components/Sidebar";
import { WorktreePicker } from "./components/WorktreePicker";
import { FileExplorer } from "./components/FileExplorer";
import { FileViewer } from "./components/FileViewer";
import { SkillsPanel } from "./components/SkillsPanel";
import type { LiveSession } from "./lib/api";

type Seg =
  | { kind: "thinking"; id: string; text: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      tcid: string;
      name: string;
      status: "running" | "success" | "error";
      args?: string;
      result?: string;
      partial?: string;
    }
  | { kind: "text"; id: string; text: string };

type Entry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; segs: Seg[]; streaming: boolean }
  | { kind: "system"; id: string; text: string; cls: "" | "a" | "ok" | "err" };

const THINK_OPTS = [
  { l: "off", v: "off" },
  { l: "min", v: "minimal" },
  { l: "low", v: "low" },
  { l: "med", v: "medium" },
  { l: "high", v: "high" },
  { l: "xhigh", v: "xhigh" },
  { l: "max", v: "max" },
] as const;

type Cmd = { cmd: string; desc: string; kind: "meta" | "prompt" | "skill" };

type ConfirmDlg = { title: string; body: string; confirm: () => void };

const META_COMMANDS: Cmd[] = [
  { cmd: "/compact", desc: "compact context (summarize older messages)", kind: "meta" },
  { cmd: "/clear", desc: "clear the chat display", kind: "meta" },
  { cmd: "/cwd", desc: "switch working directory", kind: "meta" },
  { cmd: "/new", desc: "new session in this cwd", kind: "meta" },
  { cmd: "/sessions", desc: "resume a saved session", kind: "meta" },
];
const human = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};
const money = (n: number): string => {
  if (!isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(0)}`;
};
const cap = (s: string, max = 4000): string => (s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s);

const skillFromTool = (name: string, args?: string): string | null => {
  if (name !== "read" || !args) return null;
  const bs = String.fromCharCode(92);
  const norm = args.split(bs).join("/").replace(/[/]+/g, "/").toLowerCase();
  const j = norm.indexOf("/skill.md");
  if (j < 0) return null;
  const before = norm.slice(0, j);
  const k = before.lastIndexOf("skills/");
  if (k < 0) return null;
  return before.slice(k + 7) || null;
};

function ThinkingBody({ text, done }: { text: string; done: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && done) el.scrollTop = 0;
  }, [done]);
  return (
    <div ref={ref} className={`body ${done ? "think-full" : "think-live"}`}>
      <div className="think-text">{text}</div>
    </div>
  );
}

function TextSegment({ text, streaming }: { text: string; streaming: boolean }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="seg text">
      <div className="seg-toolbar">
        <button
          className="seg-btn"
          onClick={() => setMode((m) => (m === "preview" ? "source" : "preview"))}
          title={mode === "preview" ? "show markdown source" : "show markdown preview"}
        >
          {mode === "preview" ? "md" : "preview"}
        </button>
        <button className="seg-btn" onClick={() => void copy()} title="copy output">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {mode === "preview" ? (
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
          {streaming && <span className="cursor" />}
        </div>
      ) : (
        <pre className="md-source">{text}{streaming && <span className="cursor" />}</pre>
      )}
    </div>
  );
}

export function App() {
  const listRef = useRef<Entry[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const idRef = useRef(0);
  const nextId = () => String(++idRef.current);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  // Stall (Task2): true when a turn is streaming but no SSE event has arrived
  // past the threshold → the upstream likely hung. `reconnectKey` forces the
  // EventSource to reopen (banner's reconnect action) without switching session.
  const [stalled, setStalled] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  // Ref mirror of `streaming` so effects (steer-consumed status) can read the
  // current value without re-running on every streaming toggle, and a ref of
  // the previous steer queue to detect consumption.
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const prevSteerRef = useRef<string[]>([]);
  // Set when a queued steer is consumed (queue.steer non-empty → empty while
  // streaming). The next `message_start` (assistant) opens a FRESH assistant
  // bubble for the steer's reply instead of merging into the previous reply —
  // so a consumed steer reads like a normal back-and-forth [user][assistant].
  const pendingSteerBubbleRef = useRef(false);
  const [input, setInput] = useState("");
  // F01: image attachments. `previewUrl` is a blob URL for the chip thumbnail;
  // `data`/`mimeType` is the ImageContent payload sent to the backend. Capped
  // at 4 images / 5MB each (matches the server cap). Cleared on send.
  const [images, setImages] = useState<Array<{ name: string; data: string; mimeType: string; previewUrl: string }>>([]);
  const [session, setSession] = useState<{ id: string; cwd: string } | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSession[]>([]);
  const [liveMax, setLiveMax] = useState(4);
  const [model, setModel] = useState<{ id: string; provider: string } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinking, setThinking] = useState<string>("off");
  // Levels the current model supports (SDK clamps to this). Drives the thinking
  // dropdown filter — a reasoning:false model (custom-provider models) only
  // supports "off", so the dropdown offers just that instead of letting the
  // user pick a level that silently clamps back (the "shows med / backend off"
  // desync). null = not yet loaded → show the full ladder.
  const [availableThinking, setAvailableThinking] = useState<string[] | null>(null);
  const [queue, setQueue] = useState<{ steer: string[]; follow: string[] }>({ steer: [], follow: [] });
  // F02: topbar status. `compacting` flashes during context compaction;
  // `retry` flashes during auto-retry. Both surfaced in the topbar strip
  // (replacing the old main-chat pushSystem lines) so the user sees run state
  // at a glance without scrolling. Cleared on the matching *_end event.
  const [compacting, setCompacting] = useState(false);
  const [retry, setRetry] = useState<{ attempt: number; maxAttempts: number } | null>(null);
  const [stats, setStats] = useState<SessionStat | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [sessionsList, setSessionsList] = useState<SessionListItem[]>([]);
  const [picker, setPicker] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDlg | null>(null);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [branchPicker, setBranchPicker] = useState(false);
  const [skillPicker, setSkillPicker] = useState(false);
  // F04: git worktree picker. Switching = doSwitch(worktreePath) → new live
  // session in that cwd.
  const [wtPicker, setWtPicker] = useState(false);
  // F05: resident file tree (right pane). `viewerFile` opens the right viewer
  // drawer for a file path. Mention inserts a relative path into the chat input
  // (plain text, per F05 grill).
  const [viewerFile, setViewerFile] = useState<string | null>(null);
  // F06: skills management panel (search/install/enable-disable).
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // F03: session fork picker. `forkPoints` lists user messages forkable from;
  // picking one POSTs /api/fork and switches activeSessionId to the new
  // (branched) session — SSE reopens + applySnapshot rebuilds the chat.
  const [forkPicker, setForkPicker] = useState(false);
  const [forkPoints, setForkPoints] = useState<ForkPoint[]>([]);
  const [forking, setForking] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  const curAssistant = (): Extract<Entry, { kind: "assistant" }> | null => {
    // Scan back for the last ASSISTANT entry — NOT just l[length-1]. A trailing
    // user/system entry (e.g. a steer's rejected pushSystem, or any mid-stream
    // system note) used to make this return null, which dropped thinking_delta
    // / text_delta / tool events for the in-flight assistant → "thinking stops
    // refreshing after sending a new message" (Bug 2). Scanning back keeps the
    // live assistant as the delta target regardless of trailing non-assistant
    // entries.
    const l = listRef.current;
    for (let i = l.length - 1; i >= 0; i--) {
      const e = l[i];
      if (e.kind === "assistant") return e;
    }
    return null;
  };
  const lastSegOf = (kind: Seg["kind"]): Seg | undefined => {
    const a = curAssistant();
    if (!a) return undefined;
    for (let i = a.segs.length - 1; i >= 0; i--) {
      if (a.segs[i].kind === kind) return a.segs[i];
    }
    return undefined;
  };
  const pushSystem = (text: string, cls: "" | "a" | "ok" | "err" = "") => {
    listRef.current = [...listRef.current, { kind: "system", id: nextId(), text, cls }];
    bump();
  };

  const fetchStats = async () => {
    try {
      const st = await getStats(activeSessionId ?? undefined);
      setStats(st);
      // Sync thinking dropdown to the model's actual (clamped) level + the
      // levels it supports. fetchStats runs on model switch (setModel may clamp
      // thinking to the new model's supported ladder) + session_init + agent
      // events — keeps the dropdown honest about what the SDK will accept.
      if (st.thinkingLevel) setThinking(st.thinkingLevel);
      if (Array.isArray(st.availableThinkingLevels)) setAvailableThinking(st.availableThinkingLevels);
    } catch (e) {
      pushSystem(`stats: ${String(e)}`, "err");
    }
  };
  const fetchUsage = async () => {
    try {
      setUsage(await getUsage());
    } catch {
      // odometer optional — dashboard just won't show the all-time total
    }
  };
  const fetchLiveSessions = async () => {
    try {
      const r = await getLiveSessions();
      setLiveSessions(r.sessions);
      setLiveMax(r.max);
    } catch {
      // ignore — sidebar just won't refresh
    }
  };
  const fetchGit = async () => {
    try {
      // F04: pass activeSessionId so the backend resolves THIS session's cwd
      // (rt(c)) instead of the first live session — otherwise switching
      // cwd/worktree leaves the git branch display stale.
      setGitInfo(await getGitBranch(activeSessionId ?? undefined));
    } catch {
      setGitInfo(null);
    }
  };
  const fetchSessions = async (cwdValue: string) => {
    try {
      setSessionsList(await getSessions(cwdValue));
    } catch (e) {
      pushSystem(`sessions: ${String(e)}`, "err");
    }
  };
  const fetchMessages = async () => {
    try {
      const ms = await getMessages(activeSessionId ?? undefined);
      listRef.current = ms.map((m) => mapHistory(m));
      bump();
    } catch (e) {
      pushSystem(`history: ${String(e)}`, "err");
    }
  };

  function mapHistory(m: HistMessage): Entry {
    if (m.role === "user") {
      const textSeg = m.segments.find((s) => s.kind === "text");
      return { kind: "user", id: m.id, text: textSeg && textSeg.kind === "text" ? textSeg.text : "" };
    }
    return {
      kind: "assistant",
      id: m.id,
      streaming: false,
      segs: m.segments.map((s, i) =>
        s.kind === "thinking"
          ? { kind: "thinking", id: `${m.id}-t${i}`, text: s.text, done: true }
          : s.kind === "tool"
            ? { kind: "tool", id: `${m.id}-c${i}`, tcid: s.id, name: s.name, status: "success" as const }
            : { kind: "text", id: `${m.id}-x${i}`, text: s.text },
      ),
    };
  }

  // G05 reconnect replay: on reconnect while a turn is in progress, fetch the
  // snapshot (settled history + in-progress streamingMessage + pending tools
  // marked running + queue + buffered partialResult) and rebuild the chat list,
  // then let the resumed SSE stream continue appending.
  async function applySnapshot() {
    try {
      const snap = await getSnapshot(activeSessionId ?? undefined);
      setSession({ id: snap.sessionId, cwd: snap.cwd });
      if (snap.model) setModel(snap.model);
      if (snap.thinking) setThinking(snap.thinking);
      if (Array.isArray(snap.availableThinkingLevels)) setAvailableThinking(snap.availableThinkingLevels);
      setStreaming(snap.streaming);
      setConnected(true);
      listRef.current = snap.messages.map(mapHistory);
      if (snap.inProgress && snap.streaming) {
        const pending = new Set(snap.pendingToolCalls);
        const segs: Seg[] = snap.inProgress.segments.map((s) => {
          const id = nextId();
          if (s.kind === "thinking") return { kind: "thinking", id, text: s.text, done: true };
          if (s.kind === "tool") {
            const buf = snap.partialResults[s.id];
            return {
              kind: "tool",
              id,
              tcid: s.id,
              name: s.name,
              status: pending.has(s.id) ? "running" : "success",
              ...(buf?.length ? { partial: buf.join("\n") } : {}),
            };
          }
          return { kind: "text", id, text: s.text };
        });
        listRef.current = [...listRef.current, { kind: "assistant", id: nextId(), segs, streaming: true }];
      }
      setQueue({ steer: snap.queue.steering, follow: snap.queue.followUp });
      // G05: seed the steer baseline from the snapshot so a steer that's
      // consumed right after reconnect (prevSteer non-empty → empty) is
      // detected by the synchronous queue_update handler — without this,
      // prevSteerRef stays [] and the non-empty→empty transition is missed.
      prevSteerRef.current = [...snap.queue.steering];
      bump();
      void fetchStats();
      void fetchUsage();
      void fetchGit();
      void fetchSessions(snap.cwd);
    } catch (e) {
      pushSystem(`snapshot: ${String(e)}`, "err");
    }
  }

  useEventStream(
    (e: AgentEvent) => {
      // eslint-disable-next-line no-console
      console.log("[web-pi]", e.type, e);
      switch (e.type) {
        case "session_init": {
          const s = e as {
            sessionId?: string;
            cwd?: string;
            model?: { id: string; provider: string } | null;
            thinking?: string;
            availableThinkingLevels?: string[];
            streaming?: boolean;
          };
          setSession({ id: s.sessionId ?? "", cwd: s.cwd ?? "" });
          setActiveSessionId(s.sessionId ?? null);
          if (s.model) setModel(s.model);
          if (s.thinking) setThinking(s.thinking);
          if (Array.isArray(s.availableThinkingLevels)) setAvailableThinking(s.availableThinkingLevels);
          setStreaming(Boolean(s.streaming));
          setConnected(true);
          // G05: if a turn is in progress on (re)connect, restore the full
          // snapshot (settled + in-progress + pending tools + queue); else
          // just reload settled history.
          if (Boolean(s.streaming)) void applySnapshot();
          else void fetchMessages();
          void fetchStats();
          void fetchUsage();
          void fetchGit();
          void fetchSessions(s.cwd ?? "");
          void fetchLiveSessions();
          break;
        }
        case "agent_start": {
          setStreaming(true);
          listRef.current = [...listRef.current, { kind: "assistant", id: nextId(), segs: [], streaming: true }];
          bump();
          break;
        }
        case "agent_end": {
          const a = curAssistant();
          if (a) a.streaming = false;
          setStreaming(false);
          // Surface a pending retry (the SDK will follow with auto_retry_start
          // carrying the errorMessage). Without this the user sees the reply
          // stop with no indication whether it's done or retrying.
          if ((e as { willRetry?: boolean }).willRetry) {
            // F02: the SDK will follow with auto_retry_start — the topbar retry
            // indicator covers this, no main-chat line needed.
          }
          void fetchStats();
          void fetchUsage();
          bump();
          break;
        }
        case "message_start": {
          // A new assistant message is starting mid-run. The FIRST one follows
          // agent_start's pre-created entry (pendingSteerBubbleRef is false →
          // reuse it, same as before). A subsequent one means a queued steer was
          // just consumed: pendingSteerBubbleRef was set by the queue_update
          // handler → open a FRESH bubble so the steer's reply stands alone
          // (thinking/text/tool) instead of merging into the previous reply.
          // Tool-call continuations (message_start after a toolResult, not after
          // a consumed steer) keep the flag false → stay in the same bubble.
          const role = (e as { message?: { role?: string } }).message?.role;
          if (role === "assistant" && pendingSteerBubbleRef.current) {
            pendingSteerBubbleRef.current = false;
            const prev = curAssistant();
            if (prev) prev.streaming = false;
            listRef.current = [...listRef.current, { kind: "assistant", id: nextId(), segs: [], streaming: true }];
            bump();
          }
          break;
        }
        case "message_update": {
          const ame = e.assistantMessageEvent as { type: string; delta?: string } | undefined;
          const a = curAssistant();
          if (!a || !ame) break;
          if (ame.type === "thinking_start") {
            a.segs = [...a.segs, { kind: "thinking", id: nextId(), text: "", done: false }];
            bump();
          } else if (ame.type === "thinking_delta" && ame.delta) {
            const s = lastSegOf("thinking");
            if (s && s.kind === "thinking") {
              s.text += ame.delta;
              bump();
            }
          } else if (ame.type === "thinking_end") {
            const s = lastSegOf("thinking");
            if (s && s.kind === "thinking") {
              s.done = true;
              bump();
            }
          } else if (ame.type === "text_start") {
            a.segs = [...a.segs, { kind: "text", id: nextId(), text: "" }];
            bump();
          } else if (ame.type === "text_delta" && ame.delta) {
            const s = lastSegOf("text");
            if (s && s.kind === "text") {
              s.text += ame.delta;
              bump();
            }
          }
          break;
        }
        case "tool_execution_start": {
          const a = curAssistant();
          if (a) {
            const tcid = String(e.toolCallId ?? "");
            const name = String(e.toolName ?? "tool");
            const args = e.args !== undefined ? cap(JSON.stringify(e.args, null, 2)) : undefined;
            a.segs = [...a.segs, { kind: "tool", id: nextId(), tcid, name, status: "running", args }];
            bump();
          }
          break;
        }
        case "tool_execution_end": {
          const a = curAssistant();
          if (a) {
            const tcid = String(e.toolCallId ?? "");
            const seg = [...a.segs].reverse().find((s) => s.kind === "tool" && s.tcid === tcid);
            if (seg && seg.kind === "tool") {
              seg.status = e.isError ? "error" : "success";
              if (e.result !== undefined) seg.result = cap(JSON.stringify(e.result, null, 2));
              bump();
            }
          }
          break;
        }
        case "queue_update": {
          const q = e as { steering?: string[]; followUp?: string[] };
          const nowSteer = q.steering ?? [];
          const prevSteer = prevSteerRef.current;
          // Steer consumed: the running turn picked up a queued steer
          // (prevSteer non-empty → now empty while streaming). Surface the
          // consumed steer texts as USER entries SYNCHRONOUSLY here (not in a
          // deferred effect) so they land BEFORE the steer's reply streams —
          // the chat then reads like a normal back-and-forth
          // [user steer][assistant reply]. Also flag the next assistant
          // message_start to open a fresh bubble (see message_start handler).
          // Previously this was an async useEffect pushing a "正在回复排队消息…"
          // system line, which (a) landed AFTER the reply (race → misplaced)
          // and (b) left the reply merged into the previous bubble — so the
          // user saw only the system prompt and no visible reply.
          if (prevSteer.length > 0 && nowSteer.length === 0 && streamingRef.current) {
            for (const t of prevSteer) {
              listRef.current = [...listRef.current, { kind: "user", id: nextId(), text: t }];
            }
            pendingSteerBubbleRef.current = true;
            bump();
          }
          prevSteerRef.current = nowSteer;
          setQueue({ steer: nowSteer, follow: q.followUp ?? [] });
          break;
        }
        case "compaction_start":
          // F02: topbar indicator replaces the old main-chat pushSystem.
          setCompacting(true);
          break;
        case "compaction_end": {
          const ce = e as { errorMessage?: string; aborted?: boolean; willRetry?: boolean };
          setCompacting(false);
          // Success/abort → topbar only; a genuine compaction ERROR still merits
          // a main-chat line (it's actionable).
          if (ce.errorMessage) pushSystem(`⚠ 上下文压缩失败：${ce.errorMessage}`, "err");
          void fetchStats();
          break;
        }
        // F02: auto_retry now drives a topbar indicator instead of main-chat
        // lines. A final failure (success=false after all attempts) is still
        // surfaced in chat as an actionable error.
        case "auto_retry_start": {
          const ar = e as { attempt?: number; maxAttempts?: number; errorMessage?: string };
          if (ar.attempt && ar.maxAttempts) setRetry({ attempt: ar.attempt, maxAttempts: ar.maxAttempts });
          break;
        }
        case "auto_retry_end": {
          const ar = e as { success?: boolean; attempt?: number; finalError?: string };
          setRetry(null);
          if (!ar.success) pushSystem(`⚠ 重试 ${ar.attempt ?? "?"} 次仍失败：${ar.finalError ?? ""}`, "err");
          break;
        }
        case "message_end": {
          // A message that ended in error/abort — surface it (auto_retry may
          // also fire, but a non-retryable stopReason would otherwise vanish).
          const msg = (e as { message?: { stopReason?: string; errorMessage?: string } }).message;
          if (msg?.stopReason === "error" || msg?.stopReason === "aborted") {
            pushSystem(`⚠ 模型中止（${msg.stopReason}）${msg.errorMessage ? `：${msg.errorMessage}` : ""}`, "err");
          }
          break;
        }
      }
    },
    setConnected,
    activeSessionId ?? undefined,
    (s) => setStalled(s),
    reconnectKey,
  );

  // Reset the steer baseline on session switch so a stale non-empty queue from
  // the previous session doesn't falsely read as "consumed" by the synchronous
  // queue_update handler. (The steer-consumed UX itself — appending the
  // consumed steer as a user entry + opening a fresh reply bubble — now lives
  // in the queue_update event handler above, so it lands before the reply
  // streams, not in a deferred race.)
  useEffect(() => {
    prevSteerRef.current = [];
    pendingSteerBubbleRef.current = false;
  }, [activeSessionId]);

  const refreshModels = useCallback(() => {
    void getModels()
      .then(setModels)
      .catch((e) => pushSystem(`models: ${String(e)}`, "err"));
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    void getCommands()
      .then(setSlashCmds)
      .catch(() => {});
  }, [activeSessionId]);

  useEffect(() => {
    const el = chatRef.current;
    if (el && stickBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const isExpanded = (s: Seg): boolean =>
    s.kind === "thinking" ? !s.done || expanded.has(s.id) : s.kind === "tool" ? expanded.has(s.id) : true;

  // F01: read dropped/pasted files into ImageContent (base64, no data: prefix)
  // + a blob preview URL. Caps at MAX_IMAGES total and rejects files over
  // MAX_IMG_BYTES (≈5MB) with an inline system note so the user knows why a
  // paste vanished. Non-image files are silently skipped (the chat surface is
  // text+image, not arbitrary file attach — file browse/attach is F05/F01-later).
  const MAX_IMAGES = 4;
  const MAX_IMG_BYTES = 5 * 1024 * 1024;
  const addFiles = (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (incoming.length === 0) return;
    setImages((prev) => {
      const room = MAX_IMAGES - prev.length;
      if (room <= 0) {
        pushSystem(`图片上限 ${MAX_IMAGES} 张，未添加新图`, "err");
        return prev;
      }
      const accepted: Array<{ name: string; data: string; mimeType: string; previewUrl: string }> = [];
      for (const f of incoming) {
        if (accepted.length >= room) {
          pushSystem(`图片上限 ${MAX_IMAGES} 张，部分未添加`, "err");
          break;
        }
        if (f.size > MAX_IMG_BYTES) {
          pushSystem(`图片过大未添加（${f.name}，>5MB）`, "err");
          continue;
        }
        accepted.push({
          name: f.name,
          mimeType: f.type,
          data: "", // filled by the async reader below
          previewUrl: URL.createObjectURL(f),
        });
      }
      if (accepted.length === 0) return prev;
      // Read each accepted file's base64 asynchronously; the chip renders from
      // previewUrl immediately, data fills in before send.
      for (let i = 0; i < accepted.length; i++) {
        const chip = accepted[i];
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          // result = "data:<mime>;base64,<base64>"
          const m = /^data:[^;]+;base64,(.+)$/.exec(result);
          const data = m ? m[1] : "";
          setImages((cur) => cur.map((it) => (it === chip ? { ...it, data } : it)));
        };
        reader.readAsDataURL(incoming.find((f) => f.name === chip.name && f.type === chip.mimeType) ?? incoming[0]);
      }
      return [...prev, ...accepted];
    });
  };
  const removeImage = (idx: number) => {
    setImages((prev) => {
      const [removed] = prev.filter((_, i) => i === idx);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const submit = async () => {
    const text = input.trim();
    if (!text && images.length === 0) return;
    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0] ?? "";
      if (META_COMMANDS.some((m) => m.cmd === cmd)) {
        runMeta(cmd);
        setInput("");
        return;
      }
    }
    stickBottom.current = true;
    // F01: only send images whose base64 has finished reading; drop chips
    // still loading data silently (the reader will have surfaced a note if it
    // failed). Build the ImageContent payload from attached images.
    const imgPayload: ImageContent[] = images
      .filter((im) => im.data)
      .map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }));
    // While the model is streaming, a new message is a STEER: it's queued
    // (streamingBehavior:"steer") and shown in the dashboard Queue panel via
    // queue_update — NOT appended to the chat list here. It's appended as a
    // USER entry LATER, synchronously in the queue_update handler, the moment
    // the running turn consumes it (prevSteer non-empty → empty) — so it lands
    // just before the steer's reply and reads like a normal back-and-forth.
    // When not streaming, the message is a normal prompt → appended here, and
    // the server emits agent_start, which appends a fresh assistant entry.
    if (!streaming) {
      listRef.current = [...listRef.current, { kind: "user", id: nextId(), text: text || (imgPayload.length ? "📎 image" : "") }];
    }
    setInput("");
    // Revoke blob URLs after sending (preview chips clear below).
    for (const im of images) URL.revokeObjectURL(im.previewUrl);
    setImages([]);
    try {
      const r = await sendPrompt(text, streaming ? "steer" : undefined, activeSessionId ?? undefined, imgPayload.length ? imgPayload : undefined);
      if (!r.accepted) pushSystem(`prompt rejected: ${r.error ?? ""}`, "err");
    } catch (e) {
      pushSystem(`network: ${String(e)}`, "err");
    }
  };

  const doAbort = async () => {
    try {
      await abortRun(activeSessionId ?? undefined);
      pushSystem("aborted", "err");
    } catch (e) {
      pushSystem(`abort: ${String(e)}`, "err");
    }
  };
  // Stall banner "reconnect": force-reopen the SSE stream for the active
  // session. Used when the model looks hung — a fresh connection re-runs
  // session_init (which re-applies the snapshot) and resumes the live stream.
  const reconnectStream = () => {
    setStalled(false);
    setReconnectKey((k) => k + 1);
  };
  const doCompact = async () => {
    pushSystem("compacting…", "a");
    try {
      const r = await compactNow(undefined, activeSessionId ?? undefined);
      if (!r.ok) pushSystem(`compact: ${r.error ?? ""}`, "err");
    } catch (e) {
      pushSystem(`compact: ${String(e)}`, "err");
    }
  };

  const runMeta = (cmd: string) => {
    if (cmd === "/compact") void doCompact();
    else if (cmd === "/clear") {
      listRef.current = [];
      bump();
    } else if (cmd === "/cwd" || cmd === "/sessions") {
      setPicker(true);
    } else if (cmd === "/new") {
      if (session?.cwd) void doSwitch(session.cwd, undefined);
    }
  };
  const selectCmd = (cmd: Cmd) => {
    if (cmd.kind === "meta") {
      runMeta(cmd.cmd);
      setInput("");
    } else {
      setInput(`${cmd.cmd} `);
    }
    setSlashIndex(0);
  };

  const allCmds: Cmd[] = [...META_COMMANDS, ...slashCmds];
  const slashQ = input.trim().split(/\s+/)[0] ?? "";
  const slashFiltered = input.startsWith("/") && !input.includes(" ") ? allCmds.filter((c) => c.cmd.startsWith(slashQ)) : [];
  const slashOpen = slashFiltered.length > 0;

  const onModelChange = async (provider: string, id: string) => {
    const r = await switchModel(provider, id, activeSessionId ?? undefined);
    if (r.ok && r.model) {
      setModel(r.model);
      pushSystem(`model ▸ ${r.model.id}`, "ok");
      // Refresh stats so the dashboard's Context panel reflects the new model's
      // contextWindow/maxTokens immediately (per-model limits — switching models
      // switches the registered limits; without this the panel shows stale ctx).
      void fetchStats();
    } else pushSystem(`model: ${r.error ?? "failed"}`, "err");
  };
  const onThinkingChange = async (level: string) => {
    const r = await setThinkingLevel(level, activeSessionId ?? undefined);
    if (r.ok) {
      // Use the ACTUAL level the SDK clamped to (a reasoning:false model clamps
      // any level to "off"), not the optimistic requested one — otherwise the
      // dropdown shows the requested level while session_init reports the
      // clamped value.
      setThinking(r.level ?? level);
      if (Array.isArray(r.available)) setAvailableThinking(r.available);
      pushSystem(`thinking ▸ ${r.level ?? level}`, "ok");
    } else pushSystem(`thinking: ${r.error ?? "failed"}`, "err");
  };
  const doSwitch = async (newCwd: string, sessionPath?: string) => {
    setPicker(false);
    listRef.current = [];
    setStats(null);
    setQueue({ steer: [], follow: [] });
    setImages((prev) => { for (const im of prev) URL.revokeObjectURL(im.previewUrl); return []; });
    pushSystem(`${sessionPath ? "resume" : "new session"} → ${newCwd}`, "a");
    try {
      const r = await switchSession(newCwd, sessionPath);
      if (r.ok) {
        // G01: switchSession now CREATES a new live session; making it active
        // reconnects the SSE stream to it (useEventStream dep on activeSessionId).
        setSession({ id: r.sessionId, cwd: r.cwd });
        setActiveSessionId(r.sessionId);
        if (r.model) setModel(r.model);
        setThinking(r.thinking);
        void fetchLiveSessions();
      } else pushSystem(`switch failed: ${r.error ?? ""}`, "err");
    } catch (e) {
      pushSystem(`switch: ${String(e)}`, "err");
    }
  };
  // G01: select an existing live session from the sidebar — point the SSE + all
  // api calls at it; reload its messages/stats.
  const selectSession = (id: string) => {
    if (id === activeSessionId) return;
    listRef.current = [];
    setStats(null);
    setQueue({ steer: [], follow: [] });
    setImages((prev) => { for (const im of prev) URL.revokeObjectURL(im.previewUrl); return []; });
    setActiveSessionId(id);
  };
  const newSession = async () => {
    await doSwitch(session?.cwd ?? ".");
  };
  // F03: open the fork picker — fetches user messages forkable from the SDK
  // (entryId + text). The picker shows them as a list; picking one forks.
  const openForkPicker = async () => {
    if (streaming) {
      pushSystem("fork: wait for the current turn to finish", "err");
      return;
    }
    try {
      const r = await getForkPoints(activeSessionId ?? undefined);
      setForkPoints(r.points ?? []);
      setForkPicker(true);
    } catch (e) {
      pushSystem(`fork: ${String(e)}`, "err");
    }
  };
  // F03: fork from a user message (position:"at" → that message is the new
  // leaf, anything after it is dropped). On success the backend re-keys the
  // runtime to the branched sessionId; we switch activeSessionId to it so SSE
  // reopens and applySnapshot rebuilds the chat from the forked history.
  const doFork = async (entryId: string) => {
    setForking(true);
    try {
      const r = await forkSession(entryId, activeSessionId ?? undefined);
      if (r.ok && r.sessionId) {
        setForkPicker(false);
        pushSystem(`forked → new session`, "ok");
        listRef.current = [];
        setStats(null);
        setQueue({ steer: [], follow: [] });
        setImages((prev) => { for (const im of prev) URL.revokeObjectURL(im.previewUrl); return []; });
        setActiveSessionId(r.sessionId);
        void fetchLiveSessions();
      } else {
        pushSystem(`fork: ${r.error ?? "failed"}`, "err");
      }
    } catch (e) {
      pushSystem(`fork: ${String(e)}`, "err");
    } finally {
      setForking(false);
    }
  };
  const doRename = async (id: string, title: string) => {
    const r = await renameSession(id, title);
    if (r.ok) void fetchLiveSessions();
  };

  // #3: dispose a live session. archive keeps the file (resumable later via the
  // cwd picker); delete unlinks it. Backend always keeps ≥1 live session and
  // returns the id to switch to. If the disposed one was active, reconnect SSE.
  const disposeLive = async (id: string, archive: boolean) => {
    const r = await disposeSession(id, archive);
    if (!r.ok) {
      pushSystem(`${archive ? "archive" : "delete"}: ${r.error ?? "failed"}`, "err");
      return;
    }
    pushSystem(archive ? "session archived" : "session deleted", archive ? "a" : "ok");
    if (r.newActiveId && r.newActiveId !== activeSessionId) {
      listRef.current = [];
      setStats(null);
      setQueue({ steer: [], follow: [] });
      setActiveSessionId(r.newActiveId);
    }
    void fetchLiveSessions();
  };
  const onArchiveSession = (id: string) => void disposeLive(id, true);
  const onDeleteLive = (id: string) => {
    setConfirmDialog({
      title: "delete session",
      body: "Delete this session and its saved file? This cannot be undone.",
      confirm: async () => {
        setConfirmDialog(null);
        await disposeLive(id, false);
      },
    });
  };

  const onDeleteSession = (path: string) => {
    setConfirmDialog({
      title: "delete session",
      body: "Delete this session? This cannot be undone.",
      confirm: async () => {
        setConfirmDialog(null);
        const r = await deleteSession(path);
        if (r.ok) {
          pushSystem("session deleted", "ok");
          void fetchSessions(session?.cwd ?? "");
        } else {
          pushSystem(`delete: ${r.error ?? "failed"}`, "err");
        }
      },
    });
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, slashFiltered.length - 1));
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if ((ev.key === "Enter" && !ev.shiftKey) || ev.key === "Tab") {
        ev.preventDefault();
        if (slashFiltered[slashIndex]) selectCmd(slashFiltered[slashIndex]);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        setInput("");
        return;
      }
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void submit();
    } else if (ev.key === "Escape" && streaming) {
      ev.preventDefault();
      void doAbort();
    }
  };

  const liveState: "on" | "working" | "off" = connected ? (streaming ? "working" : "on") : "off";
  const ctxPct = stats?.contextUsage?.percent ?? null;
  const entries = listRef.current;

  return (
    <div className="flex h-full flex-col">
      <header className="app">
        <div className="brand">web-pi</div>
        <div className="head-right">
          <span className={`pill ${liveState}`}>·{liveState === "on" ? "live" : liveState}</span>
          <button
            className="gear"
            onClick={() => setSkillsOpen(true)}
            title="skills — search / install / enable-disable"
            aria-label="skills"
          >
            ⚡
          </button>
          <button
            className="gear"
            onClick={() => void openForkPicker()}
            disabled={streaming}
            title="fork — branch a new session from a past user message"
            aria-label="fork session"
          >
            ↳
          </button>
          <button
            className={`gear ${showSettings ? "on" : ""}`}
            onClick={() => setShowSettings((v) => !v)}
            title="settings — model providers"
            aria-label="settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {/* F02: topbar status strip — context % + cost + compaction/retry
          indicator. Replaces the old main-chat pushSystem lines for these
          transient run states (kept in chat only for genuine errors). Narrow
          screens collapse to context% + status. */}
      <div className="topbar">
        <span className="tb-ctx" title={`context: ${human(stats?.contextUsage?.tokens ?? 0)} / ${human(stats?.contextUsage?.contextWindow ?? 0)} tokens`}>
          <span className="tb-label">ctx</span>
          <span className="tb-bar">
            <span style={{ width: `${Math.min(100, Math.max(0, ctxPct ?? 0))}%` }} />
          </span>
          <span className="tb-pct">{ctxPct === null ? "—" : `${ctxPct.toFixed(1)}%`}</span>
        </span>
        <span className="tb-cost" title="this session · all time">
          <span className="tb-label">$</span>
          {money(stats?.cost ?? 0)}<span className="tb-dim"> · {money(usage?.total.cost ?? 0)}</span>
        </span>
        <span
          className="tb-tok"
          title={`tokens — in ${human(stats?.tokens?.input ?? 0)} · out ${human(stats?.tokens?.output ?? 0)} · cache read ${human(stats?.tokens?.cacheRead ?? 0)} · total ${human(stats?.tokens?.total ?? 0)}`}
        >
          <span className="tb-label">tk</span>
          <span className="tb-dim">↑</span>{human(stats?.tokens?.input ?? 0)}
          <span className="tb-dim"> ↓</span>{human(stats?.tokens?.output ?? 0)}
        </span>
        <span className="tb-status">
          {stats && stats.pendingToolCalls.length > 0 && (
            <span className="tb-flag live" title={`${stats.pendingToolCalls.length} running tool call(s)`}>{`⚙ ${stats.pendingToolCalls.length}`}</span>
          )}
          {queue.steer.length > 0 && (
            <span className="tb-flag warn" title={`${queue.steer.length} queued steer`}>{`⇶ ${queue.steer.length}`}</span>
          )}
          {queue.follow.length > 0 && (
            <span className="tb-flag neutral" title={`${queue.follow.length} queued follow-up`}>{`↪ ${queue.follow.length}`}</span>
          )}
          {compacting && (<span className="tb-flag warn" title="compacting context">compacting…</span>)}
          {retry && (<span className="tb-flag warn" title="auto-retry in progress">{`retry ${retry.attempt}/${retry.maxAttempts}…`}</span>)}
          {streaming && !compacting && !retry && (<span className="tb-flag live" title="streaming">streaming</span>)}
        </span>
      </div>

      <div className="wrap">
        <div className={`layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
          <Sidebar
            sessions={liveSessions}
            activeId={activeSessionId}
            max={liveMax}
            onSelect={(id) => selectSession(id)}
            onNew={() => void newSession()}
            onRename={(id, title) => void doRename(id, title)}
            onArchive={onArchiveSession}
            onDelete={onDeleteLive}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
          />
          <section className="chat">
            <div
              ref={chatRef}
              className="chatlog"
              onScroll={() => {
                const el = chatRef.current;
                if (!el) return;
                stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
            >
              {entries.map((entry) => {
                if (entry.kind === "user") {
                  const sm = entry.text.match(/^\/skill:([^\s]+)\s*(.*)$/s);
                  if (sm) {
                    return (
                      <Fragment key={entry.id}>
                        {sm[2] && (
                          <div className="msg user">
                            <div className="role">you</div>
                            <div className="body">{sm[2]}</div>
                          </div>
                        )}
                        <div className="seg skill">
                          <div className="head clickable" onClick={() => toggle(entry.id)}>
                            <span className="chev">{expanded.has(entry.id) ? "▾" : "▸"}</span>
                            <span className="tag">skill</span>
                            <span className="name">{sm[1]}</span>
                            <span className="status success">✓</span>
                          </div>
                          {expanded.has(entry.id) && <div className="body">{entry.text}</div>}
                        </div>
                      </Fragment>
                    );
                  }
                  return (
                    <div key={entry.id} className="msg user">
                      <div className="role">you</div>
                      <div className="body">{entry.text}</div>
                    </div>
                  );
                }
                if (entry.kind === "system") {
                  return (
                    <div key={entry.id} className={`system ${entry.cls}`}>
                      {entry.text}
                    </div>
                  );
                }
                return (
                  <div key={entry.id} className="msg assistant">
                    <div className="role">assistant</div>
                    {entry.segs.map((s, i) => {
                      const isLast = i === entry.segs.length - 1;
                      if (s.kind === "thinking") {
                        return (
                          <div key={s.id} className={`seg thinking ${!s.done ? "active" : ""}`}>
                            <div className="head" onClick={() => s.done && toggle(s.id)}>
                              <span className="chev">{s.done ? (isExpanded(s) ? "▾" : "▸") : ""}</span>
                              <span className="label">thinking</span>
                              {!s.done && (
                                <span className="think-dots">
                                  <span />
                                  <span />
                                  <span />
                                </span>
                              )}
                            </div>
                            {(!s.done || isExpanded(s)) && s.text && <ThinkingBody text={s.text} done={s.done} />}
                          </div>
                        );
                      }
                      if (s.kind === "tool") {
                        const skillName = skillFromTool(s.name, s.args);
                        if (skillName) {
                          return (
                            <div key={s.id} className="seg skill">
                              <div className="head clickable" onClick={() => toggle(s.id)}>
                                <span className="chev">{isExpanded(s) ? "▾" : "▸"}</span>
                                <span className="tag">skill</span>
                                <span className="name">{skillName}</span>
                                <span className={`status ${s.status}`}>
                                  {s.status === "running" ? "…" : s.status === "success" ? "✓" : "✗"}
                                </span>
                              </div>
                              {isExpanded(s) && s.args && <div className="body">{s.args}</div>}
                            </div>
                          );
                        }
                        return (
                          <div key={s.id} className="seg tool">
                            <div className="head" onClick={() => toggle(s.id)}>
                              <span className="chev">{isExpanded(s) ? "▾" : "▸"}</span>
                              <span className="tag">tool</span>
                              <span className="name">{s.name}</span>
                              <span className={`status ${s.status}`}>
                                {s.status === "running" ? "…" : s.status === "success" ? "✓" : "✗"}
                              </span>
                            </div>
                            {isExpanded(s) && (s.args || s.partial || s.result) && (
                              <div className="body">
                                {s.args && `args:\n${s.args}\n`}
                                {s.partial && `live:\n${s.partial}\n`}
                                {s.result && `result:\n${s.result}`}
                              </div>
                            )}
                          </div>
                        );
                      }
                      return <TextSegment key={s.id} text={s.text} streaming={entry.streaming && isLast} />;
                    })}
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>

            {stalled && streaming && (
              <div className="stall-banner" role="status">
                <span className="stall-dot" />
                <span className="stall-text">仍在思考，但已较久无响应 — 可能已断开</span>
                <button className="stall-btn" onClick={reconnectStream} title="reopen the SSE stream">重连</button>
                <button className="stall-btn danger" onClick={() => void doAbort()} title="abort the current run">中止</button>
              </div>
            )}

            <div
              className="composer"
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
              }}
            >
              {slashOpen && (
                <div className="slash-menu">
                  {slashFiltered.map((c, i) => (
                    <div
                      key={c.cmd}
                      className={`slash-item ${i === slashIndex ? "active" : ""}`}
                      onMouseEnter={() => setSlashIndex(i)}
                      onClick={() => selectCmd(c)}
                    >
                      <span className="cmd">{c.cmd}</span>
                      <span className="desc">{c.desc}</span>
                    </div>
                  ))}
                </div>
              )}
              {images.length > 0 && (
                <div className="img-chips">
                  {images.map((im, i) => (
                    <div className="img-chip" key={`${i}-${im.name}`}>
                      <img src={im.previewUrl} alt={im.name} />
                      <button
                        className="img-chip-x"
                        title="remove image"
                        onClick={() => removeImage(i)}
                      >
                        ✕
                      </button>
                      {!im.data && <span className="img-chip-loading" title="reading file…">…</span>}
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setSlashIndex(0);
                }}
                onKeyDown={onKeyDown}
                onPaste={(e) => {
                  const files = e.clipboardData?.files;
                  if (files?.length) {
                    e.preventDefault();
                    addFiles(files);
                  }
                }}
                placeholder="Message web-pi… (Enter send · Shift+Enter newline · type / for commands · drop/paste images)"
                rows={2}
                autoFocus
              />
              <span className="enter-hint" aria-label="Enter to send">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 5v7H9" />
                  <path d="M13 8 9 12 13 16" />
                </svg>
              </span>
            </div>

            <div className="controls-row">
              <span className="ctrl-label">Model</span>
              <select
                className="sel"
                value={model ? `${model.provider}/${model.id}` : ""}
                onChange={(e) => {
                  const [p, ...rest] = e.target.value.split("/");
                  const id = rest.join("/");
                  if (p && id) void onModelChange(p, id);
                }}
                disabled={streaming}
              >
                {models.map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                    {m.name}
                  </option>
                ))}
              </select>
              <span className="ctrl-label">THINK</span>
              <select
                className="sel"
                value={thinking}
                onChange={(e) => void onThinkingChange(e.target.value)}
                disabled={streaming}
              >
                {(availableThinking
                  ? THINK_OPTS.filter((o) => availableThinking.includes(o.v))
                  : THINK_OPTS
                ).map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
              <span className="ctrl-label">skill</span>
              <button
                className="git-btn"
                onClick={() => setSkillPicker(true)}
                disabled={streaming || !slashCmds.some((c) => c.kind === "skill")}
                title="pick a skill"
              >
                <span className="branch-name">skill</span> <span className="arr" />
              </button>
              <span className="ctrl-label">DIR</span>
              <button className="cwd-btn" onClick={() => setPicker(true)} title="switch cwd / resume session">
                <span className="cwd">{session?.cwd ?? "…"}</span> <span className="arr" />
              </button>
              <span className="ctrl-label">git</span>
              <button className="git-btn" onClick={() => setBranchPicker(true)} disabled={!gitInfo?.repo} title={gitInfo?.repo ? gitInfo.current : "not a git repo"}>
                <span className="branch-name">{gitInfo ? (gitInfo.repo ? gitInfo.current : "no git") : "…"}</span> <span className="arr" />
              </button>
              <button className="git-btn" onClick={() => setWtPicker(true)} disabled={!gitInfo?.repo} title="git worktrees — switch cwd to another working tree">
                <span className="branch-name">worktree</span> <span className="arr" />
              </button>
            </div>
          </section>

          {/* F05→resident: the right pane is now a persistent file tree (like
              VS Code's explorer), no longer a popup drawer. Context/Cost/Tokens
              moved to the topbar; Queue surfaced as topbar count badges. Clicking
              a file opens the FileViewer right-drawer overlay; @ inserts a path. */}
          <aside className="dash">
            <FileExplorer
              cwd={session?.cwd ?? ""}
              onOpenFile={(p) => setViewerFile(p)}
              onMention={(rel) => {
                setInput((cur) => (cur ? `${cur} ${rel}` : rel));
                inputRef.current?.focus();
              }}
            />
          </aside>
        </div>
      </div>

      {picker && (
        <CwdPicker cwd={session?.cwd ?? ""} onClose={() => setPicker(false)} onSwitched={(c, p) => void doSwitch(c, p)} />
      )}
      {confirmDialog && (
        <div className="modal" style={{ zIndex: 60 }} onClick={(e) => e.target === e.currentTarget && setConfirmDialog(null)}>
          <div className="sheet" style={{ maxWidth: 420 }}>
            <header className="sheet-head">
              <div className="sheet-title">{confirmDialog.title}</div>
              <div className="x" onClick={() => setConfirmDialog(null)}>✕</div>
            </header>
            <div className="sheet-body">
              <div className="confirm-body">{confirmDialog.body}</div>
              <div className="confirm-actions">
                <button className="btn ghost" onClick={() => setConfirmDialog(null)}>cancel</button>
                <button className="btn danger" onClick={() => void confirmDialog.confirm()}>delete</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {branchPicker && (
        <GitBranchPicker onClose={() => setBranchPicker(false)} onChanged={() => void fetchGit()} />
      )}
      {wtPicker && (
        <WorktreePicker
          cwd={session?.cwd ?? "."}
          onClose={() => setWtPicker(false)}
          onSwitch={(path) => {
            setWtPicker(false);
            void doSwitch(path);
          }}
        />
      )}
      {/* F05: file viewer (right drawer overlay). The explorer itself is now a
          persistent right pane (see aside.dash above), so only the viewer opens
          as an overlay when a file is clicked. */}
      {viewerFile && (
        <FileViewer filePath={viewerFile} cwd={session?.cwd ?? "."} onClose={() => setViewerFile(null)} />
      )}
      {skillsOpen && (
        <SkillsPanel sessionId={activeSessionId ?? undefined} onClose={() => setSkillsOpen(false)} />
      )}
      {skillPicker && (
        <SkillPicker
          skills={slashCmds.filter((c) => c.kind === "skill")}
          onClose={() => setSkillPicker(false)}
          onPick={(cmd) => {
            const rest = input.trim();
            setInput(rest ? `${cmd} ${rest}` : `${cmd} `);
            inputRef.current?.focus();
          }}
        />
      )}
      {forkPicker && (
        <div
          className="modal"
          style={{ zIndex: 60 }}
          onClick={(e) => e.target === e.currentTarget && !forking && setForkPicker(false)}
        >
          <div className="sheet" style={{ maxWidth: 560 }}>
            <header className="sheet-head">
              <div className="sheet-title">fork from a user message</div>
              <div className="x" onClick={() => !forking && setForkPicker(false)}>✕</div>
            </header>
            <div className="sheet-body">
              <div className="fork-hint">
                Pick a past user message to branch a new session from. Everything
                after it is dropped; the original session is untouched.
              </div>
              {forkPoints.length === 0 ? (
                <div className="empty">no forkable user messages yet — send one first</div>
              ) : (
                <div className="fork-list">
                  {forkPoints.map((p, i) => (
                    <button
                      key={p.entryId ?? i}
                      className="fork-item"
                      disabled={forking}
                      onClick={() => void doFork(p.entryId)}
                    >
                      <span className="fork-idx">{i + 1}</span>
                      <span className="fork-text">{p.text.slice(0, 120)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <SettingsDrawer
          onClose={() => setShowSettings(false)}
          onProvidersChanged={refreshModels}
        />
      )}
    </div>
  );
}
