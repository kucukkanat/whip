import { useEffect, useMemo, useRef, useState } from "react";
import { PAGES } from "./docs";
import { slugify } from "./md";

type Entry = { slug: string; anchor?: string; title: string; page: string; category: string; text: string };

const INDEX: Entry[] = PAGES.flatMap((p) => {
  const e: Entry[] = [{ slug: p.slug, title: p.title, page: p.title, category: p.category, text: p.summary }];
  let cur: Entry | null = null;
  for (const l of p.md.split("\n")) {
    if (/^#{2,3} /.test(l)) { const t = l.replace(/^#+ /, ""); cur = { slug: p.slug, anchor: slugify(t), title: t, page: p.title, category: p.category, text: "" }; e.push(cur); }
    else if (!l.startsWith("```")) (cur ?? e[0]).text += " " + l.replace(/[`*|]/g, " ");
  }
  return e;
});

/** Subsequence fuzzy score: rewards contiguous runs and word starts; title hits beat body hits. */
export function fuzzy(q: string, s: string): number {
  q = q.toLowerCase(); s = s.toLowerCase();
  if (!q) return 1;
  const direct = s.indexOf(q);
  if (direct >= 0) return 100 - Math.min(direct, 50) + (direct === 0 || /\W/.test(s[direct - 1]) ? 20 : 0);
  let score = 0, j = 0, run = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) { j++; run++; score += run * 2 + (i === 0 || /\W/.test(s[i - 1]) ? 5 : 0); } else run = 0;
  }
  return j === q.length ? score : 0;
}

export default function Search({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState(""), [sel, setSel] = useState(0), [cat, setCat] = useState("All");
  const input = useRef<HTMLInputElement>(null);
  const cats = ["All", ...new Set(PAGES.map((p) => p.category))];
  const results = useMemo(() => INDEX
    .filter((e) => cat === "All" || e.category === cat)
    .map((e) => ({ e, s: fuzzy(q, e.title) * 3 + fuzzy(q, e.text) * (q.length > 2 ? 1 : 0) }))
    .filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map((r) => r.e), [q, cat]);
  useEffect(() => { input.current?.focus(); const prev = document.activeElement as HTMLElement; return () => prev?.focus?.(); }, []);
  useEffect(() => setSel(0), [q, cat]);
  const go = (e: Entry) => { location.hash = `#/docs/${e.slug}${e.anchor ? "::" + e.anchor : ""}`; onClose(); };
  const snippet = (e: Entry) => { const t = e.text.trim(), i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1; return (i > 30 ? "…" + t.slice(i - 30) : t).slice(0, 110); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Search documentation" onMouseDown={(e) => e.stopPropagation()}
        className="rise w-full max-w-2xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          else if (e.key === "Enter" && results[sel]) go(results[sel]);
        }}>
        <div className="flex items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <span aria-hidden className="text-zinc-400">⌕</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search docs: try “tool args”, “jsonl”, “failFirst”"
            className="h-14 flex-1 bg-transparent outline-none placeholder:text-zinc-400" role="combobox" aria-expanded="true" aria-controls="search-results"
            aria-activedescendant={results[sel] ? `r-${sel}` : undefined} aria-label="Search" />
          <kbd className="rounded border border-zinc-300 px-1.5 font-mono text-xs text-zinc-500 dark:border-zinc-700">esc</kbd>
        </div>
        <div className="flex flex-wrap gap-1.5 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800" role="group" aria-label="Filter by category">
          {cats.map((c) => <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c}
            className={`rounded-full px-3 py-1 text-xs ${cat === c ? "bg-lime text-black" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400"}`}>{c}</button>)}
        </div>
        <ul id="search-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-zinc-500">No matches for “{q}”. Try fewer letters or another category.</li>}
          {results.map((e, i) => (
            <li key={e.slug + e.anchor} id={`r-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(e)}
              className={`cursor-pointer rounded-lg px-3 py-2.5 ${i === sel ? "bg-zinc-100 dark:bg-zinc-900" : ""}`}>
              <div className="flex items-center gap-2 text-sm"><span className="font-medium">{e.title}</span>{e.anchor && <span className="text-zinc-400">· {e.page}</span>}<span className="ml-auto text-xs text-zinc-400">{e.category}</span></div>
              <div className="truncate text-xs text-zinc-500">{snippet(e)}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
