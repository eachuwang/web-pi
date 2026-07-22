import { useState } from "react";
import type { LiveSession } from "../lib/api";
import { Icon } from "./Icon";

// G01 left sidebar: live session list with title (auto from first prompt) +
// cwd tag, new / switch / rename / archive / delete. The dashboard's old
// Sessions panel moved here (#1 collapses to a thin dots-only rail).
//
// Concurrency: a streaming session shows a pulse dot. The active one is
// highlighted. Click to switch (the parent re-points all api calls at it).

export function Sidebar({
  sessions,
  activeId,
  max,
  onSelect,
  onNew,
  onRename,
  onArchive,
  onDelete,
  collapsed,
  onToggleCollapse,
}: {
  sessions: LiveSession[];
  activeId: string | null;
  max: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const atCap = sessions.length >= max;

  if (collapsed) {
    // #1: thin rail — dots only (active highlighted), hover for title; expand
    // button at the top. Keeps the browser surface for the chat + dashboard.
    return (
      <aside className="sidebar collapsed">
        <button className="sb-collapse" onClick={onToggleCollapse} title="expand sessions"><Icon name="chevron-right" /></button>
        <div className="sb-list">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className={`sb-rail${s.sessionId === activeId ? " active" : ""}`}
              onClick={() => onSelect(s.sessionId)}
              title={`${s.title ?? "untitled"} · ${s.cwd}${s.streaming ? " · streaming" : ""}`}
            >
              <span className={`sb-dot${s.streaming ? " on" : ""}`} />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span>Sessions</span>
        <div className="sb-head-right">
          <button className="sb-new" onClick={onNew} disabled={atCap} title={atCap ? `max ${max} reached` : "new session"}>
            <Icon name="plus" /> new
          </button>
          <button className="sb-collapse" onClick={onToggleCollapse} title="collapse"><Icon name="chevron-down" /></button>
        </div>
      </div>
      <div className="sb-list">
        {sessions.length === 0 && <div className="sb-empty">no sessions</div>}
        {sessions.map((s) => {
          const active = s.sessionId === activeId;
          const cwdTag = s.cwd.split("/").filter(Boolean).pop() ?? s.cwd;
          return (
            <div
              key={s.sessionId}
              className={`sb-item${active ? " active" : ""}`}
              onClick={() => editing !== s.sessionId && onSelect(s.sessionId)}
            >
              {editing === s.sessionId ? (
                <input
                  className="sb-rename"
                  autoFocus
                  value={draft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRename(s.sessionId, draft.trim() || s.title || "untitled");
                      setEditing(null);
                    } else if (e.key === "Escape") {
                      setEditing(null);
                    }
                  }}
                  onBlur={() => setEditing(null)}
                />
              ) : (
                <>
                  <span className={`sb-dot${s.streaming ? " on" : ""}`} title={s.streaming ? "streaming" : "idle"} />
                  <span className="sb-title">{s.title ?? "untitled"}</span>
                  <span className="sb-cwd" title={s.cwd}>{cwdTag}</span>
                  <span className="sb-actions">
                    <button
                      className="sb-act"
                      title="rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDraft(s.title ?? "");
                        setEditing(s.sessionId);
                      }}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="sb-act sb-archive"
                      title="archive (keep file, free slot)"
                      onClick={(e) => {
                        e.stopPropagation();
                        onArchive(s.sessionId);
                      }}
                    >
                      <Icon name="archive" />
                    </button>
                    <button
                      className="sb-act sb-delete"
                      title="delete session + file"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.sessionId);
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="sb-foot">
        {sessions.length}/{max} live
      </div>
    </aside>
  );
}
