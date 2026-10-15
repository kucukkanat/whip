import { useEffect, useState } from "react";
import Landing from "./Landing";
import Docs from "./Docs";
import Search from "./Search";

export const useHash = () => {
  const [h, set] = useState(location.hash || "#/");
  useEffect(() => { const f = () => set(location.hash || "#/"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
};

export function Logo() {
  return (
    <a href="#/" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="Whip home">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden><rect width="32" height="32" rx="8" className="fill-lime" /><path d="M8 22 C14 6 20 26 25 9" stroke="#111" strokeWidth="3.5" fill="none" strokeLinecap="round" /></svg>
      <span className="text-lg">whip</span>
    </a>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.theme = dark ? "dark" : "light"; }, [dark]);
  return (
    <button onClick={() => setDark(!dark)} className="grid size-10 place-items-center rounded-lg border border-zinc-200 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900" aria-label={`Switch to ${dark ? "light" : "dark"} mode`}>
      {dark ? "☀" : "☾"}
    </button>
  );
}

export function TopBar({ onSearch }: { onSearch: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur md:px-8 dark:border-zinc-800 dark:bg-ink/80">
      <Logo />
      <nav className="ml-4 hidden gap-1 text-sm text-zinc-600 sm:flex dark:text-zinc-400" aria-label="Main">
        <a className="rounded-md px-3 py-2 hover:text-zinc-950 dark:hover:text-white" href="#/docs/quickstart">Docs</a>
        <a className="rounded-md px-3 py-2 hover:text-zinc-950 dark:hover:text-white" href="#/docs/checks">Checks</a>
        <a className="rounded-md px-3 py-2 hover:text-zinc-950 dark:hover:text-white" href="#/docs/compare">Compare</a>
      </nav>
      <button onClick={onSearch} className="ml-auto flex h-10 min-w-0 items-center gap-3 rounded-lg border border-zinc-200 px-3 text-sm text-zinc-500 hover:border-zinc-400 sm:w-72 dark:border-zinc-800" aria-label="Search docs (Command K)">
        <span aria-hidden>⌕</span><span className="hidden sm:inline">Search docs…</span>
        <kbd className="ml-auto hidden rounded border border-zinc-300 px-1.5 font-mono text-xs sm:inline dark:border-zinc-700">⌘K</kbd>
      </button>
      <ThemeToggle />
      <a href="https://github.com/kucukkanat/whip" className="hidden h-10 items-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white md:flex dark:bg-white dark:text-zinc-900">GitHub</a>
    </header>
  );
}

export default function App() {
  const hash = useHash();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } else if (e.key === "/" && !/INPUT|TEXTAREA/.test((e.target as HTMLElement).tagName)) { e.preventDefault(); setOpen(true); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);
  const slug = hash.match(/^#\/docs\/?([\w-]*)/);
  useEffect(() => { if (!hash.includes("::")) scrollTo(0, 0); }, [slug?.[1], !!slug]);
  return (
    <>
      <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }} className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-lime focus:px-3 focus:py-2 focus:text-black">Skip to content</a>
      <TopBar onSearch={() => setOpen(true)} />
      {slug ? <Docs slug={slug[1] || "quickstart"} hash={hash} /> : <Landing />}
      {open && <Search onClose={() => setOpen(false)} />}
    </>
  );
}
