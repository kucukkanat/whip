import { useEffect, useState } from "react";
import { PAGES } from "./docs";
import { Md, slugify } from "./md";

const CATS = [...new Set(PAGES.map((p) => p.category))];

export default function Docs({ slug, hash }: { slug: string; hash: string }) {
  const page = PAGES.find((p) => p.slug === slug) ?? PAGES[0];
  const [filter, setFilter] = useState("All");
  const [active, setActive] = useState("");
  const toc = page.md.split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => ({ t: l.replace(/^#+ /, ""), sub: l.startsWith("###") }));
  const idx = PAGES.indexOf(page), prev = PAGES[idx - 1], next = PAGES[idx + 1];

  useEffect(() => {
    const a = hash.split("::")[1];
    if (a) requestAnimationFrame(() => document.getElementById(a)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  }, [hash]);
  useEffect(() => {
    const els = toc.map((h) => document.getElementById(slugify(h.t))).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting)[0]; if (v) setActive(v.target.id); }, { rootMargin: "-80px 0px -70% 0px" });
    els.forEach((e) => io.observe(e)); return () => io.disconnect();
  }, [page.slug]);

  return (
    <div className="grid min-h-[calc(100vh-4rem)] grid-cols-1 md:grid-cols-[260px_1fr] xl:grid-cols-[280px_1fr_260px]">
      <aside className="border-b border-zinc-200 p-4 md:sticky md:top-16 md:h-[calc(100vh-4rem)] md:overflow-y-auto md:border-r md:border-b-0 dark:border-zinc-800" aria-label="Docs navigation">
        <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter sections">
          {["All", ...CATS].map((c) => <button key={c} onClick={() => setFilter(c)} aria-pressed={filter === c}
            className={`rounded-full px-2.5 py-1 text-xs ${filter === c ? "bg-lime text-black" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400"}`}>{c}</button>)}
        </div>
        <nav className="flex gap-6 overflow-x-auto md:block">
          {CATS.filter((c) => filter === "All" || c === filter).map((c) => (
            <div key={c} className="mb-5 shrink-0">
              <h2 className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{c}</h2>
              <ul>{PAGES.filter((p) => p.category === c).map((p) => (
                <li key={p.slug}><a href={`#/docs/${p.slug}`} aria-current={p === page ? "page" : undefined}
                  className={`flex min-h-10 items-center rounded-md px-2 text-sm ${p === page ? "bg-lime/15 font-medium text-zinc-950 dark:text-lime" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}>{p.title}</a></li>
              ))}</ul>
            </div>
          ))}
        </nav>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 px-5 py-10 outline-none md:px-12 xl:px-16">
        <p className="text-sm font-medium text-lime-700 dark:text-lime">{page.category}</p>
        <h1 className="mt-1 text-4xl font-bold tracking-tight">{page.title}</h1>
        <p className="mt-2 text-lg text-zinc-500">{page.summary}</p>
        <article className="mt-6"><Md src={page.md} /></article>
        <nav className="mt-14 grid gap-3 border-t border-zinc-200 pt-6 sm:grid-cols-2 dark:border-zinc-800" aria-label="Pagination">
          {prev ? <a href={`#/docs/${prev.slug}`} className="rounded-xl border border-zinc-200 p-4 hover:border-lime dark:border-zinc-800"><div className="text-xs text-zinc-500">← Previous</div><div className="font-medium">{prev.title}</div></a> : <span />}
          {next && <a href={`#/docs/${next.slug}`} className="rounded-xl border border-zinc-200 p-4 text-right hover:border-lime dark:border-zinc-800"><div className="text-xs text-zinc-500">Next →</div><div className="font-medium">{next.title}</div></a>}
        </nav>
      </main>
      <aside className="hidden border-l border-zinc-200 p-6 xl:block xl:sticky xl:top-16 xl:h-[calc(100vh-4rem)] xl:overflow-y-auto dark:border-zinc-800" aria-label="On this page">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">On this page</h2>
        <ul className="space-y-1 border-l border-zinc-200 text-sm dark:border-zinc-800">
          {toc.map((h) => { const id = slugify(h.t); return (
            <li key={id}><a href={`#/docs/${page.slug}::${id}`} className={`-ml-px block border-l py-1 ${h.sub ? "pl-6" : "pl-3"} ${active === id ? "border-lime text-zinc-950 dark:text-white" : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"}`}>{h.t}</a></li>); })}
        </ul>
        <div className="mt-8 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <div className="font-medium">Try it offline</div>
          <code className="mt-2 block font-mono text-xs text-zinc-500">whip examples/mock-tiny.ts</code>
        </div>
      </aside>
    </div>
  );
}
