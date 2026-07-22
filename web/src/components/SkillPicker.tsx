import { useEffect, useState, type KeyboardEvent } from "react";
import type { SlashCommand } from "../lib/api";
import { Icon } from "./Icon";

// Searchable skill picker: type to fuzzy-filter skills (multi-token substring
// match on name + description), arrow/enter to pick. Calls onPick with the full
// `/skill:<name>` command so the composer can prepend it to the prompt.
export function SkillPicker({
  skills,
  onClose,
  onPick,
}: {
  skills: SlashCommand[];
  onClose: () => void;
  onPick: (cmd: string) => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const nameOf = (cmd: string): string => (cmd.startsWith("/skill:") ? cmd.slice(7) : cmd);

  const filtered = skills.filter((s) => {
    const name = nameOf(s.cmd).toLowerCase();
    const qq = q.toLowerCase().trim();
    if (!qq) return true;
    return qq
      .split(" ")
      .filter((t) => t.length > 0)
      .every((tok) => name.includes(tok));
  });

  useEffect(() => {
    setIdx(0);
  }, [q]);

  const pick = (cmd: string) => {
    onPick(cmd);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[idx]) pick(filtered[idx].cmd);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ maxWidth: 480 }}>
        <header className="sheet-head">
          <div className="sheet-title">skill</div>
          <div className="x" onClick={onClose}><Icon name="close" /></div>
        </header>
        <div className="sheet-body">
          <input
            className="skill-search"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="type to filter skills…"
          />
          <div className="skill-list">
            {filtered.length === 0 ? (
              <div className="branch-muted">no matching skills</div>
            ) : (
              filtered.map((s, i) => (
                <button
                  key={s.cmd}
                  className={`skill-opt ${i === idx ? "active" : ""}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => pick(s.cmd)}
                >
                  <span className="name">{nameOf(s.cmd)}</span>
                  <span className="desc">{s.desc}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
