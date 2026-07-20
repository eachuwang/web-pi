import { useEffect, useState } from "react";
import { getGitBranch, gitCheckout, gitCreateBranch, type GitInfo } from "../lib/api";

// Branch switcher + new-branch creator for the session cwd's git repo.
// Lists local branches (click to switch) and a form to create a new branch
// from a chosen base (or HEAD), then switches to it.
export function GitBranchPicker({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [from, setFrom] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await getGitBranch());
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);

  const checkout = async (b: string) => {
    setBusy(true);
    setErr(null);
    const r = await gitCheckout(b);
    setBusy(false);
    if (r.ok) {
      onChanged();
      onClose();
    } else {
      setErr(r.error ?? "checkout failed");
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr(null);
    const r = await gitCreateBranch(name, from || undefined);
    setBusy(false);
    if (r.ok) {
      onChanged();
      onClose();
    } else {
      setErr(r.error ?? "create failed");
    }
  };

  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ maxWidth: 440 }}>
        <header className="sheet-head">
          <div className="sheet-title">git branch</div>
          <div className="x" onClick={onClose}>✕</div>
        </header>
        <div className="sheet-body">
          {!info ? (
            <div className="branch-muted">loading…</div>
          ) : !info.repo ? (
            <div className="branch-muted">not a git repository</div>
          ) : (
            <>
              <div className="branch-current">
                current: <b>{info.current}</b>
              </div>
              <div className="branch-section-label">switch to</div>
              <div className="branch-list">
                {info.branches.map((b) => (
                  <button
                    key={b}
                    className="branch-row"
                    disabled={b === info.current || busy}
                    onClick={() => void checkout(b)}
                  >
                    <span className="branch-mark">{b === info.current ? "●" : "○"}</span>
                    <span className="branch-name">{b}</span>
                  </button>
                ))}
              </div>
              <div className="branch-section-label">new branch</div>
              <div className="branch-form">
                <input
                  className="branch-input"
                  placeholder="branch name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void create();
                  }}
                />
                <select
                  className="sel"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  disabled={busy}
                >
                  <option value="">from current</option>
                  {info.branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                <button
                  className="btn primary"
                  disabled={busy || !newName.trim()}
                  onClick={() => void create()}
                >
                  create &amp; switch
                </button>
              </div>
            </>
          )}
          {err && <div className="branch-err">{err}</div>}
        </div>
      </div>
    </div>
  );
}
