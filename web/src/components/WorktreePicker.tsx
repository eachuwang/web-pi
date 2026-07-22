import { useEffect, useState } from "react";
import { getWorktrees, type Worktree } from "../lib/api";
import { Icon } from "./Icon";

// F04: git worktree switcher. Lists the repo's worktrees (each is an
// independent working tree on a branch); clicking one calls onSwitch(path) →
// the host creates a new live session in that cwd (doSwitch). Read-only list —
// creating new worktrees is a later increment (per F04: only切现有 first).
export function WorktreePicker({
  cwd,
  onClose,
  onSwitch,
}: {
  cwd: string;
  onClose: () => void;
  onSwitch: (path: string) => void;
}) {
  const [items, setItems] = useState<Worktree[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await getWorktrees(cwd);
        if (!r.repo) {
          setErr("not a git repo");
          return;
        }
        setItems(r.worktrees ?? []);
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, [cwd]);

  const pick = (path: string) => {
    setBusy(true);
    onSwitch(path);
  };

  return (
    <div className="modal" style={{ zIndex: 60 }} onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" style={{ maxWidth: 560 }}>
        <header className="sheet-head">
          <div className="sheet-title">git worktrees</div>
          <div className="x" onClick={() => !busy && onClose()}><Icon name="close" /></div>
        </header>
        <div className="sheet-body">
          {err ? (
            <div className="empty">{err}</div>
          ) : items.length === 0 ? (
            <div className="empty">no worktrees</div>
          ) : (
            <div className="fork-list">
              {items.map((w) => (
                <button
                  key={w.path}
                  className="fork-item"
                  disabled={busy}
                  onClick={() => pick(w.path)}
                >
                  <span className="fork-idx">{w.isMain && <Icon name="star" />}</span>
                  <span className="fork-text">
                    <div className="wt-branch">{w.branch || w.head}</div>
                    <div className="wt-path">{w.path}</div>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="fork-hint" style={{ marginTop: 10 }}>
            Switching opens a new live session in that worktree's cwd.
          </div>
        </div>
      </div>
    </div>
  );
}
