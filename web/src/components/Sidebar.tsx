import { useState } from "react";
import type { LiveSession } from "../lib/api";

// G01 left sidebar: live session list with title (auto from first prompt) +
// cwd tag, new / switch / rename. The dashboard's old Sessions panel moves here.
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
}: {
  sessions: LiveSession[];
  activeId: string | null;
  max: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const atCap = sessions.length >= max;

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span>Sessions</span>
        <button className="sb-new" onClick={onNew} disabled={atCap} title={atCap ? `max ${max} reached` : "new session"}>
          + new
        </button>
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
                  <button
                    className="sb-edit"
                    title="rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraft(s.title ?? "");
                      setEditing(s.sessionId);
                    }}
                  >
                    ✎
                  </button>
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
