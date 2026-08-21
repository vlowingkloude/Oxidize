import { File, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchMatch, TreeEntry } from "../types";

type Location = { path: string; line?: number; column?: number };

type Props = {
  mode: "files" | "search";
  entries: TreeEntry[];
  results: SearchMatch[];
  searching: boolean;
  onSearch: (query: string) => void;
  onOpen: (location: Location) => void;
  onClose: () => void;
};

export function WorkspacePalette({ mode, entries, results, searching, onSearch, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const files = useMemo(() => {
    const candidates = entries.filter((entry) => entry.kind === "file");
    if (!query.trim()) return candidates.slice(0, 100);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return candidates
      .filter((entry) => terms.every((term) => entry.path.toLowerCase().includes(term)))
      .sort((left, right) => score(left.path, query) - score(right.path, query))
      .slice(0, 100);
  }, [entries, query]);
  const items = mode === "files" ? files : results;

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSelected(0), [items.length, query]);
  useEffect(() => {
    if (mode !== "search") return;
    const timer = window.setTimeout(() => onSearch(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [mode, onSearch, query]);

  function openSelected() {
    const item = items[selected];
    if (!item) return;
    onOpen(mode === "files" ? { path: item.path } : item);
  }

  return (
    <div className="paletteBackdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="workspacePalette" role="dialog" aria-modal="true">
        <div className="paletteInput">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder={mode === "files" ? "Search files by name…" : "Search text in workspace…"}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, items.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(value - 1, 0)); }
              if (event.key === "Enter") { event.preventDefault(); openSelected(); }
            }}
          />
          {searching ? <span className="paletteHint">Searching…</span> : <button type="button" onClick={onClose}><X size={16} /></button>}
        </div>
        <div className="paletteResults">
          {items.map((item, index) => {
            const path = item.path;
            const result = "preview" in item ? item : null;
            return (
              <button
                type="button"
                key={result ? `${path}:${result.line}:${result.column}:${index}` : path}
                className={index === selected ? "selected" : ""}
                onMouseEnter={() => setSelected(index)}
                onClick={() => onOpen(result ?? { path })}
              >
                <File size={15} />
                <span className="paletteResultBody">
                  <strong>{path}</strong>
                  {result ? <small><span>{result.line}:{result.column}</span>{result.preview}</small> : null}
                </span>
              </button>
            );
          })}
          {!searching && query && items.length === 0 ? <div className="paletteEmpty">No results</div> : null}
          {mode === "search" && !query ? <div className="paletteEmpty">Type to search up to 500 matches.</div> : null}
        </div>
      </section>
    </div>
  );
}

function score(path: string, query: string) {
  const lower = path.toLowerCase();
  const target = query.toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  if (name === target) return 0;
  if (name.startsWith(target)) return 1;
  if (name.includes(target)) return 2;
  return lower.length;
}
