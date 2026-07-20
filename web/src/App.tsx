import { Fragment, useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  abortRun,
  compactNow,
  deleteSession,
  getCommands,
  getGitBranch,
  getMessages,
  getModels,
  getSessions,
  getStats,
  sendPrompt,
  setThinkingLevel,
  switchModel,
  switchSession,
  type GitInfo,
  type HistMessage,
  type ModelInfo,
  type SessionListItem,
  type SessionStat,
  type SlashCommand,
} from "./lib/api";
import { useEventStream, type AgentEvent } from "./hooks/useEventStream";
import { CwdPicker } from "./components/CwdPicker";
import { GitBranchPicker } from "./components/GitBranchPicker";
import { SkillPicker } from "./components/SkillPicker";

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
  const [input, setInput] = useState("");
  const [session, setSession] = useState<{ id: string; cwd: string } | null>(null);
  const [model, setModel] = useState<{ id: string; provider: string } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinking, setThinking] = useState<string>("off");
  const [queue, setQueue] = useState<{ steer: string[]; follow: string[] }>({ steer: [], follow: [] });
  const [stats, setStats] = useState<SessionStat | null>(null);
  const [sessionsList, setSessionsList] = useState<SessionListItem[]>([]);
  const [picker, setPicker] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDlg | null>(null);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [branchPicker, setBranchPicker] = useState(false);
  const [skillPicker, setSkillPicker] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  const curAssistant = (): Extract<Entry, { kind: "assistant" }> | null => {
    const l = listRef.current;
    const last = l[l.length - 1];
    return last && last.kind === "assistant" ? last : null;
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
      setStats(await getStats());
    } catch (e) {
      pushSystem(`stats: ${String(e)}`, "err");
    }
  };
  const fetchGit = async () => {
    try {
      setGitInfo(await getGitBranch());
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
      const ms = await getMessages();
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
            streaming?: boolean;
          };
          setSession({ id: s.sessionId ?? "", cwd: s.cwd ?? "" });
          if (s.model) setModel(s.model);
          if (s.thinking) setThinking(s.thinking);
          setStreaming(Boolean(s.streaming));
          setConnected(true);
          if (!streaming) void fetchMessages();
          void fetchStats();
          void fetchGit();
          void fetchSessions(s.cwd ?? "");
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
          void fetchStats();
          bump();
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
          setQueue({ steer: q.steering ?? [], follow: q.followUp ?? [] });
          break;
        }
        case "compaction_start":
          pushSystem("context: compacting", "a");
          break;
        case "compaction_end":
          pushSystem("context: compacted", "ok");
          void fetchStats();
          break;
      }
    },
    setConnected,
    nonce,
  );

  useEffect(() => {
    void getModels()
      .then(setModels)
      .catch((e) => pushSystem(`models: ${String(e)}`, "err"));
  }, []);

  useEffect(() => {
    void getCommands()
      .then(setSlashCmds)
      .catch(() => {});
  }, [nonce]);

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

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0] ?? "";
      if (META_COMMANDS.some((m) => m.cmd === cmd)) {
        runMeta(cmd);
        setInput("");
        return;
      }
    }
    stickBottom.current = true;
    listRef.current = [...listRef.current, { kind: "user", id: nextId(), text }];
    setInput("");
    try {
      const r = await sendPrompt(text, streaming ? "steer" : undefined);
      if (!r.accepted) pushSystem(`prompt rejected: ${r.error ?? ""}`, "err");
    } catch (e) {
      pushSystem(`network: ${String(e)}`, "err");
    }
  };

  const doAbort = async () => {
    try {
      await abortRun();
      pushSystem("aborted", "err");
    } catch (e) {
      pushSystem(`abort: ${String(e)}`, "err");
    }
  };
  const doCompact = async () => {
    pushSystem("compacting…", "a");
    try {
      const r = await compactNow();
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
    const r = await switchModel(provider, id);
    if (r.ok && r.model) {
      setModel(r.model);
      pushSystem(`model ▸ ${r.model.id}`, "ok");
    } else pushSystem(`model: ${r.error ?? "failed"}`, "err");
  };
  const onThinkingChange = async (level: string) => {
    const r = await setThinkingLevel(level);
    if (r.ok) {
      setThinking(level);
      pushSystem(`thinking ▸ ${level}`, "ok");
    } else pushSystem(`thinking: ${r.error ?? "failed"}`, "err");
  };
  const doSwitch = async (newCwd: string, sessionPath?: string) => {
    setPicker(false);
    listRef.current = [];
    setStats(null);
    setQueue({ steer: [], follow: [] });
    pushSystem(`switching → ${newCwd}${sessionPath ? " (resume)" : ""}`, "a");
    try {
      const r = await switchSession(newCwd, sessionPath);
      if (r.ok) {
        setSession({ id: r.sessionId, cwd: r.cwd });
        if (r.model) setModel(r.model);
        setThinking(r.thinking);
        setNonce((x) => x + 1);
      } else pushSystem(`switch failed: ${r.error ?? ""}`, "err");
    } catch (e) {
      pushSystem(`switch: ${String(e)}`, "err");
    }
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
        <span className={`pill ${liveState}`}>·{liveState === "on" ? "live" : liveState}</span>
      </header>

      <div className="wrap">
        <div className="layout">
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
                            {isExpanded(s) && (s.args || s.result) && (
                              <div className="body">
                                {s.args && `args:\n${s.args}\n`}
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

            <div className="composer">
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
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setSlashIndex(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Message web-pi… (Enter send · Shift+Enter newline · type / for commands)"
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
              <span className="ctrl-label">think mode</span>
              <select
                className="sel"
                value={thinking}
                onChange={(e) => void onThinkingChange(e.target.value)}
                disabled={streaming}
              >
                {THINK_OPTS.map((o) => (
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
              <span className="ctrl-label">current Dir</span>
              <button className="cwd-btn" onClick={() => setPicker(true)} title="switch cwd / resume session">
                <span className="cwd">{session?.cwd ?? "…"}</span> <span className="arr" />
              </button>
              <span className="ctrl-label">git</span>
              <button className="git-btn" onClick={() => setBranchPicker(true)} disabled={!gitInfo?.repo} title={gitInfo?.repo ? gitInfo.current : "not a git repo"}>
                <span className="branch-name">{gitInfo ? (gitInfo.repo ? gitInfo.current : "no git") : "…"}</span> <span className="arr" />
              </button>
            </div>
          </section>

          <aside className="dash">
            <div className="panel">
              <h2>Context</h2>
              {stats?.contextUsage ? (
                <>
                  <div className="kv">
                    <span className="k">used</span>
                    <span className="v">
                      {human(stats.contextUsage.tokens ?? 0)} / {human(stats.contextUsage.contextWindow)}
                    </span>
                  </div>
                  <div className="ctxbar">
                    <span style={{ width: `${Math.min(100, Math.max(0, ctxPct ?? 0))}%` }} />
                  </div>
                  <div className="kv">
                    <span className="k">percent</span>
                    <span className="v">{ctxPct === null ? "—" : ctxPct.toFixed(1)}%</span>
                  </div>
                </>
              ) : (
                <div className="empty">—</div>
              )}
            </div>

            <div className="panel">
              <h2>Queue</h2>
              {queue.steer.length === 0 && queue.follow.length === 0 ? (
                <div className="empty">no queued messages</div>
              ) : (
                <>
                  {queue.steer.map((q, i) => (
                    <div key={`s${i}`} className="queue-item">
                      <span className="tag steer">steer</span>
                      <span className="txt">{q}</span>
                    </div>
                  ))}
                  {queue.follow.map((q, i) => (
                    <div key={`f${i}`} className="queue-item">
                      <span className="tag follow">follow</span>
                      <span className="txt">{q}</span>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="panel">
              <h2>Sessions</h2>
              {sessionsList.length === 0 ? (
                <div className="empty">none in this cwd</div>
              ) : (
                sessionsList.slice(0, 12).map((s) => (
                  <div key={s.path} className="session-row" onClick={() => void doSwitch(s.cwd || session?.cwd || "", s.path)}>
                    <span className="ttl">{s.name || s.firstMessage?.slice(0, 40) || s.id.slice(0, 8)}</span>
                    <span className="badge">{s.messageCount} msg</span>
                    <button
                      className="session-del"
                      title="delete session"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteSession(s.path);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
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
    </div>
  );
}
