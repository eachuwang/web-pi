import { useEffect, useState } from "react";
import { getDirs, getSessions, type DirEntry, type SessionListItem } from "../lib/api";
import { Icon } from "./Icon";

// Directory browser + session resume picker. Browses subdirs of a path, lists
// saved sessions in the selected cwd, and calls back on "new session here" or
// "resume this session".
export function CwdPicker({
  cwd,
  onClose,
  onSwitched,
}: {
  cwd: string;
  onClose: () => void;
  onSwitched: (cwd: string, sessionPath?: string) => void;
}) {
  const [path, setPath] = useState(cwd);
  const [parent, setParent] = useState(cwd);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (p: string) => {
    setLoading(true);
    setErr(null);
    try {
      const d = await getDirs(p);
      // Use the server's resolved path (empty/relative input → server picks a
      // real absolute dir) so the input always shows the directory we're
      // actually browsing, and "sessions here" matches it.
      const resolved = d.path ?? p;
      setPath(resolved);
      setEntries(d.entries ?? []);
      setParent(d.parent ?? resolved);
      setErr(d.error ?? null);
      setSessions(await getSessions(resolved));
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(cwd);
  }, [cwd]);

  const goUp = () => {
    if (parent !== path) void load(parent);
  };
  const useHere = () => onSwitched(path);
  const resume = (s: SessionListItem) => onSwitched(s.cwd || path, s.path);

  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <header className="sheet-head">
          <div className="sheet-title">switch session / cwd</div>
          <div className="x" onClick={onClose}><Icon name="close" /></div>
        </header>
        <div className="sheet-body">
          <div className="path-input">
            <button className="btn" onClick={goUp} disabled={parent === path}><Icon name="arrow-up" /></button>
            <input
              className="path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void load(path)}
              spellCheck={false}
            />
            <button className="btn" onClick={() => void load(path)}>go</button>
          </div>
          {err && <div className="empty">{err}</div>}
          <div className="dir-list">
            {loading ? (
              <div className="empty">loading…</div>
            ) : entries.length === 0 ? (
              <div className="empty">no subdirectories</div>
            ) : (
              entries.map((d) => (
                <div key={d.path} className="dir-row" onClick={() => void load(d.path)}>
                  <Icon name="chevron-right" className="ic" /> {d.name}
                </div>
              ))
            )}
          </div>
          <button className="btn primary" onClick={useHere}>new session in this directory</button>
          <h2 style={{ marginTop: 18 }}>sessions here</h2>
          {sessions.length === 0 ? (
            <div className="empty">no saved sessions</div>
          ) : (
            sessions.map((s) => (
              <div key={s.path} className="session-row" onClick={() => resume(s)}>
                <span className="ttl">{s.name || s.firstMessage?.slice(0, 50) || s.id.slice(0, 8)}</span>
                <span className="badge">{s.messageCount} msg</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
