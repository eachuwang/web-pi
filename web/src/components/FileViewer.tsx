import { useEffect, useRef, useState } from "react";

// F05: file viewer — right drawer overlay. Dispatches by extension (borrowed
// from pi-web's FileViewer): image → <img>, audio → <audio>, PDF → <iframe>,
// text → <pre> with line numbers. Subscribes to the SSE `watch` stream so
// edits refresh live (text re-fetches, image cache-busts). Text preview is
// plain <pre> for now (syntax highlighting via Prism is a deferred increment
// to avoid a chunky dep — F05 Resolution noted it as施工中按需引入).
const API_BASE = import.meta.env.DEV ? "http://127.0.0.1:3000" : "";

function encode(p: string): string { return p.split("/").map(encodeURIComponent).join("/"); }
function ext(p: string): string { return p.split("/").pop()?.toLowerCase().split(".").pop() ?? ""; }
function rel(p: string, cwd: string): string { return p.replace(cwd + "/", "").replace(cwd, ""); }

const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "m4a", "flac", "weba"]);

interface TextData { content: string; language: string; size: number }

export function FileViewer({ filePath, cwd, onClose }: { filePath: string; cwd: string; onClose: () => void }) {
  const e = ext(filePath);
  const isImage = IMG.has(e);
  const isAudio = AUDIO.has(e);
  const isPdf = e === "pdf";
  const [text, setText] = useState<TextData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bust, setBust] = useState(0);
  const [watching, setWatching] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const readUrl = `${API_BASE}/api/files/${encode(filePath)}?type=read${bust ? `&v=${bust}` : ""}`;

  useEffect(() => {
    setErr(null);
    setText(null);
    setBust(0);
    // Text: fetch content. Media/PDF: the <img>/<audio>/<iframe> src loads it.
    if (!isImage && !isAudio && !isPdf) {
      fetch(readUrl).then((r) => r.json()).then((d: TextData & { error?: string }) => {
        if (d.error) setErr(d.error); else setText(d);
      }).catch((e) => setErr(String(e)));
    }
    // SSE watch for live refresh.
    const es = new EventSource(`${API_BASE}/api/files-watch?path=${encode(filePath)}`);
    esRef.current = es;
    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", () => {
      setBust((b) => b + 1);
      if (!isImage && !isAudio && !isPdf) {
        // re-fetch text
        fetch(`${API_BASE}/api/files/${encode(filePath)}?type=read`).then((r) => r.json()).then((d: TextData & { error?: string }) => { if (!d.error) setText(d); }).catch(() => {});
      }
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);
    return () => { es.close(); esRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  return (
    <div className="fv-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="fv-drawer">
        <header className="fv-head">
          <span className="fv-path" title={filePath}>{rel(filePath, cwd)}</span>
          <span className={`fv-live ${watching ? "on" : ""}`} title={watching ? "live sync" : "static"}>{watching ? "● live" : "○ static"}</span>
          <button className="fv-x" onClick={onClose} title="close">✕</button>
        </header>
        <div className="fv-body">
          {err ? <div className="fv-err">{err}</div>
            : isImage ? <img className="fv-img" src={readUrl} alt={filePath} onError={() => setErr("failed to load image")} />
            : isAudio ? <audio className="fv-audio" src={readUrl} controls />
            : isPdf ? <iframe className="fv-pdf" src={readUrl} title={filePath} />
            : text ? <pre className="fv-pre">{text.content}</pre>
            : <div className="fv-err">loading…</div>}
        </div>
      </div>
    </div>
  );
}
