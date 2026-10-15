import { useState, type ReactNode } from "react";

export const slugify = (s: string) => s.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");

function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).map((p, i) =>
    p.startsWith("`") ? <code key={i} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800/80">{p.slice(1, -1)}</code>
    : p.startsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong>
    : p.startsWith("[") ? (([, t, h]) => <a key={i} href={h} className="font-medium text-lime-700 underline decoration-lime/50 underline-offset-2 hover:decoration-lime dark:text-lime">{t}</a>)(p.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!) : p);
}

export function Code({ code, lang }: { code: string; lang?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="group relative my-4 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-1.5 font-mono text-xs text-zinc-500 dark:border-zinc-800">
        <span>{lang || "text"}</span>
        <button onClick={() => navigator.clipboard?.writeText(code).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}
          className="rounded px-2 py-1 hover:bg-zinc-200 dark:hover:bg-zinc-800" aria-label="Copy code">{ok ? "Copied ✓" : "Copy"}</button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed"><code>{code}</code></pre>
      <span className="sr-only" aria-live="polite">{ok ? "Copied" : ""}</span>
    </div>
  );
}

/** Tiny markdown subset: ##/### headings, paragraphs, lists, fenced code, tables, `> ` callouts (first **bold** run is the title). */
export function Md({ src }: { src: string }) {
  const lines = src.trim().split("\n"), out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const lang = l.slice(3), buf: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i]);
      out.push(<Code key={i} code={buf.join("\n")} lang={lang} />);
    } else if (/^#{2,3} /.test(l)) {
      const lvl = l.startsWith("###") ? 3 : 2, t = l.replace(/^#+ /, "");
      out.push(lvl === 2 ? <h2 key={i} id={slugify(t)} className="mt-10 mb-3 scroll-mt-24 text-xl font-semibold tracking-tight">{t}</h2> : <h3 key={i} id={slugify(t)} className="mt-6 mb-2 font-semibold">{t}</h3>);
    } else if (l.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split(" | ").map((c) => c.trim().replace(/^\|\s*|\s*\|$/g, "")));
      i--;
      out.push(<div key={i} className="my-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800"><table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/60"><tr>{rows[0].map((c, j) => <th key={j} className="px-4 py-2 font-medium">{inline(c)}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, k) => <tr key={k} className="border-t border-zinc-200 dark:border-zinc-800">{r.map((c, j) => <td key={j} className="px-4 py-2 align-top">{inline(c)}</td>)}</tr>)}</tbody></table></div>);
    } else if (l.startsWith("> ")) {
      const buf: string[] = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) buf.push(lines[i].replace(/^> ?/, ""));
      i--;
      out.push(<aside key={i} role="note" className="my-5 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm leading-6 text-zinc-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-zinc-200">
        {buf.filter((b) => b.trim()).map((b, j) => <p key={j} className={j ? "mt-2" : ""}>{inline(b)}</p>)}</aside>);
    } else if (/^(- |\d+\. )/.test(l)) {
      const ordered = /^\d/.test(l), items: string[] = [];
      for (; i < lines.length && /^(- |\d+\. )/.test(lines[i]); i++) items.push(lines[i].replace(/^(- |\d+\. )/, ""));
      i--;
      const Tag = ordered ? "ol" : "ul";
      out.push(<Tag key={i} className={`my-3 space-y-1.5 pl-6 ${ordered ? "list-decimal" : "list-disc"} marker:text-zinc-400`}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</Tag>);
    } else if (l.trim()) out.push(<p key={i} className="my-3 leading-7 text-zinc-700 dark:text-zinc-300">{inline(l)}</p>);
  }
  return <>{out}</>;
}
