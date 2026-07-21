import { useCallback, useEffect, useState } from "react";

// F05: file tree. Recursive TreeNode with lazy subdir loading (expand →
// fetchEntries), expandedPaths hoisted to parent, IGNORED filtering done
// server-side. Hover row → "mention" inserts the relative path into the chat
// input (plain text, per F05 grill). Borrowed from pi-web's FileExplorer.

interface Entry { name: string; isDir: boolean }
interface Node { name: string; fullPath: string; isDir: boolean; loaded: boolean }

const API_BASE = import.meta.env.DEV ? "http://127.0.0.1:3000" : "";

async function fetchEntries(dir: string): Promise<Node[]> {
  const res = await fetch(`${API_BASE}/api/files/${encode(dir)}?type=list`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const data = (await res.json()) as { entries?: Entry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: `${dir}/${e.name}`,
    isDir: e.isDir,
    loaded: !e.isDir,
  }));
}
// encode a path for the URL segment — keep leading slash, URI-encode each part.
function encode(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

function TreeNode({
  node, depth, cwd, onOpenFile, onMention, expanded, onToggle,
}: {
  node: Node; depth: number; cwd: string;
  onOpenFile: (p: string) => void;
  onMention: (rel: string) => void;
  expanded: Set<string>;
  onToggle: (p: string, open: boolean) => void;
}) {
  const [children, setChildren] = useState<Node[]>([]);
  const [loaded, setLoaded] = useState(node.loaded);
  const [loading, setLoading] = useState(false);
  const open = expanded.has(node.fullPath);

  const load = useCallback(async () => {
    if (loaded) return;
    setLoading(true);
    try { setChildren(await fetchEntries(node.fullPath)); setLoaded(true); } catch { /* */ }
    finally { setLoading(false); }
  }, [loaded, node.fullPath]);

  useEffect(() => { if (open && loaded) void load().catch(() => {}); /* re-fetch on external refresh */ }, [open, loaded, load]);

  const click = () => {
    if (node.isDir) { const next = !open; onToggle(node.fullPath, next); if (next && !loaded) void load(); }
    else onOpenFile(node.fullPath);
  };
  const rel = node.fullPath.replace(cwd + "/", "").replace(cwd, "");

  return (
    <div>
      <div className="fe-row" onClick={click} title={node.fullPath} style={{ paddingLeft: 6 + depth * 12 }}>
        <span className="fe-chev">{node.isDir ? (open ? "▾" : "▸") : ""}</span>
        <span className="fe-name">{node.name}</span>
        {loading && <span className="fe-loading">…</span>}
        {onMention && (
          <button className="fe-mention" title="insert path into chat" onClick={(e) => { e.stopPropagation(); onMention(rel); }}>@</button>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((c) => (
            <TreeNode key={c.fullPath} node={c} depth={depth + 1} cwd={cwd} onOpenFile={onOpenFile} onMention={onMention} expanded={expanded} onToggle={onToggle} />
          ))}
          {loaded && children.length === 0 && <div className="fe-empty" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>empty</div>}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({
  cwd, onOpenFile, onMention,
}: {
  cwd: string;
  onOpenFile: (p: string) => void;
  onMention: (rel: string) => void;
}) {
  const [roots, setRoots] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Reset expansion on cwd switch.
  useEffect(() => { setExpanded(new Set()); }, [cwd]);
  useEffect(() => {
    setLoading(true); setErr(null);
    fetchEntries(cwd).then(setRoots).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  }, [cwd]);

  const toggle = (p: string, open: boolean) => setExpanded((prev) => {
    const n = new Set(prev); if (open) n.add(p); else n.delete(p); return n;
  });

  return (
    <div className="fe">
      <div className="fe-head">files · <span className="fe-cwd">{cwd}</span></div>
      {loading ? <div className="fe-empty">loading…</div>
        : err ? <div className="fe-empty err">{err}</div>
        : roots.map((n) => (
          <TreeNode key={n.fullPath} node={n} depth={0} cwd={cwd} onOpenFile={onOpenFile} onMention={onMention} expanded={expanded} onToggle={toggle} />
        ))}
    </div>
  );
}
