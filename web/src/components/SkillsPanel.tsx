import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";

// F06: skill management panel. List (from the agent's own loader — zero drift),
// enable/disable (frontmatter toggle via PATCH), search (skills.sh /api/search),
// install (pure-HTTP from the GitHub source repo, written to ~/.web-pi/skills).
// Per the (c) decision: no `npx skills` runtime dependency — self-contained.
const API_BASE = import.meta.env.DEV ? "http://127.0.0.1:3000" : "";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}
interface SearchResult { package: string; name: string; installs: number; url: string }

export function SkillsPanel({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newlyInstalled, setNewlyInstalled] = useState<Set<string>>(new Set());

  const sid = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/skills${sid}`);
      const d = (await r.json()) as { skills?: Skill[]; error?: string };
      if (d.error) setErr(d.error);
      else setSkills(d.skills ?? []);
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, [sid]);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (s: Skill) => {
    setToggling(s.filePath);
    try {
      const next = !s.disableModelInvocation;
      await fetch(`${API_BASE}/api/skills`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: s.filePath, disableModelInvocation: next }),
      });
      setSkills((prev) => prev.map((x) => x.filePath === s.filePath ? { ...x, disableModelInvocation: next } : x));
    } catch (e) { setErr(String(e)); }
    finally { setToggling(null); }
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true); setErr(null); setResults([]);
    try {
      const r = await fetch(`${API_BASE}/api/skills/search`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });
      const d = (await r.json()) as { results?: SearchResult[]; error?: string };
      if (d.error) setErr(d.error); else setResults(d.results ?? []);
    } catch (e) { setErr(String(e)); }
    finally { setSearching(false); }
  };

  const install = async (pkg: string, name: string) => {
    setInstalling(pkg);
    setErr(null);
    try {
      const r = await fetch(`${API_BASE}/api/skills/install`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: pkg, scope: "global" }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      if (!r.ok || d.error) { setErr(d.error ?? `HTTP ${r.status}`); return; }
      setNewlyInstalled((p) => new Set(p).add(name));
      void load();
    } catch (e) { setErr(String(e)); }
    finally { setInstalling(null); }
  };

  const installed = new Set(skills.map((s) => s.name.toLowerCase()));

  return (
    <div className="modal" style={{ zIndex: 60 }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ maxWidth: 640 }}>
        <header className="sheet-head">
          <div className="sheet-title">skills</div>
          <div className="x" onClick={onClose}><Icon name="close" /></div>
        </header>
        <div className="sheet-body">
          {err && <div className="fork-hint" style={{ color: "var(--red)" }}>{err}</div>}

          {/* Add skill: search skills.sh + install from GitHub source */}
          <div className="sk-section">add skill</div>
          <div className="sk-search-row">
            <input
              className="sk-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="search skills.sh (e.g. react, deploy)"
            />
            <button className="sk-btn" disabled={searching} onClick={search}>{searching ? "…" : "search"}</button>
          </div>
          {results.length > 0 && (
            <div className="fork-list" style={{ marginBottom: 12 }}>
              {results.map((r) => {
                const isInstalled = installed.has(r.name.toLowerCase());
                return (
                  <div key={r.package} className="sk-result">
                    <div className="sk-result-main">
                      <div className="wt-branch">{r.name}</div>
                      <div className="wt-path">{r.package} · {r.installs.toLocaleString()} installs</div>
                    </div>
                    <button
                      className="sk-btn"
                      disabled={installing === r.package || isInstalled}
                      onClick={() => install(r.package, r.name)}
                    >
                      {isInstalled ? "installed" : installing === r.package ? "…" : "install"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Installed skills list + enable/disable toggle */}
          <div className="sk-section">installed ({skills.length})</div>
          {loading ? <div className="empty">loading…</div>
            : skills.length === 0 ? <div className="empty">no skills yet — search and install one above</div>
            : (
              <div className="fork-list">
                {skills.map((s) => (
                  <div key={s.filePath} className={`sk-skill ${newlyInstalled.has(s.name) ? "sk-new" : ""}`}>
                    <div className="sk-skill-main">
                      <div className="wt-branch">
                        {s.name}
                        {newlyInstalled.has(s.name) && <span className="sk-new-tag">new</span>}
                      </div>
                      <div className="wt-path">{s.description?.slice(0, 80) ?? ""}</div>
                      <div className="sk-path" title={s.filePath}>{s.filePath}</div>
                    </div>
                    <button
                      className={`sk-toggle ${s.disableModelInvocation ? "off" : "on"}`}
                      disabled={toggling === s.filePath}
                      onClick={() => toggle(s)}
                      title={s.disableModelInvocation ? "disabled in model prompt — click to enable" : "visible in model prompt — click to disable"}
                    >
                      {toggling === s.filePath ? "…" : s.disableModelInvocation ? "off" : "on"}
                    </button>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
