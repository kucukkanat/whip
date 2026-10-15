#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KNOWN_CLIS, makeHarness } from "./adapters";
import { loadTasks, runSuite } from "./engine";
import { bold, diff, dim, html, scorecard, suggest } from "./report";
import type { Run } from "./types";

const HELP = `${bold("whip")} - evaluate agent harnesses, not models

  whip <target>                    run the default suite, print a scorecard
  whip compare <target> --variant k=v --variant k=v   one change at a time, deltas vs first
  whip diff <runA> <runB>          compare two saved runs (paths, ids, or "latest", "latest~1")
  whip suggest [run]               rule-based hints for the failures in a run
  whip report [runs...]            write a static HTML report
  whip clis                        list known CLIs and how they are invoked

  target: claude | codex | opencode | copilot | gemini | aider | goose | "ollama <model>"
          ./harness.ts (SDK: default-exported function) | "any-cmd --flag" (prompt on stdin, or {prompt})
  flags:  -n/--repeat N (3)  --only <regex|category>  --variant key=value|key=file  --evals <dir> (./evals)
          --timeout ms  --no-save     config: optional whip.config.ts (default export)`;

type Config = { target?: string; repeat?: number; variants?: Record<string, string>[]; evals?: string; only?: string };

function parseArgs(argv: string[]) {
  const pos: string[] = [], variants: string[] = [], o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variant" || a === "-v") variants.push(argv[++i]);
    else if (a === "-n" || a === "--repeat") o.repeat = argv[++i];
    else if (a === "--no-save") o.noSave = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, variants, o };
}

const RUNS = ".whip/runs";
const listRuns = () => (existsSync(RUNS) ? readdirSync(RUNS).filter((f) => f.endsWith(".json")).sort() : []);
function loadRun(ref = "latest"): Run {
  const m = ref.match(/^latest(?:~(\d+))?$/);
  const rs = listRuns();
  const p = m ? join(RUNS, rs[rs.length - 1 - Number(m[1] ?? 0)] ?? "") : existsSync(ref) ? ref : join(RUNS, ref.replace(/\.json$/, "") + ".json");
  if (!existsSync(p) || p === RUNS + "/") throw new Error(`run not found: ${ref} (saved runs live in ${RUNS})`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** `system=prompts/a.md` → label `prompts/a.md`, value = file contents. Plain values pass through. */
const parseVariant = (s: string) => {
  const out: Record<string, string> = {};
  for (const kv of s.split(",")) { const i = kv.indexOf("="); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
  return out;
};
const load = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, existsSync(x) ? readFileSync(x, "utf8") : x]));

async function save(run: Run, noSave: boolean) {
  if (noSave) return;
  mkdirSync(RUNS, { recursive: true });
  await Bun.write(join(RUNS, `${run.id}.json`), JSON.stringify(run, null, 2));
}

async function main() {
  const [cmd0, ...rest] = process.argv.slice(2);
  const sub = ["compare", "diff", "suggest", "report", "clis", "run"].includes(cmd0) ? cmd0 : "run";
  const { pos, variants, o } = parseArgs(sub === "run" && cmd0 !== "run" ? [cmd0, ...rest].filter(Boolean) : rest);
  if (o.help || (!cmd0 && !existsSync("whip.config.ts"))) return console.log(HELP);

  if (sub === "clis") return console.log(Object.entries(KNOWN_CLIS).map(([k, v]) => `  ${k.padEnd(9)} ${v.join(" ")}`).join("\n"));
  if (sub === "diff") { const a = loadRun(pos[0] ?? "latest~1"), b = loadRun(pos[1] ?? "latest"); return console.log(diff(a, b)); }
  if (sub === "suggest") return console.log(suggest(loadRun(pos[0])));
  if (sub === "report") {
    const runs = (pos.length ? pos : ["latest"]).map(loadRun);
    await Bun.write(".whip/report.html", html(runs));
    return console.log(`wrote ${resolve(".whip/report.html")}`);
  }

  const cfg: Config = existsSync("whip.config.ts") ? (await import(resolve("whip.config.ts"))).default : {};
  const target = pos[0] ?? cfg.target;
  if (!target) throw new Error("no target. Try: whip claude, whip ./my-harness.ts, or set target in whip.config.ts");
  const repeat = Number(o.repeat ?? cfg.repeat ?? 3);
  const tasks = loadTasks(String(o.evals ?? cfg.evals ?? "evals"), (o.only as string) ?? cfg.only);
  const { adapter, harness } = await makeHarness(target);
  const sets = variants.length ? variants.map(parseVariant) : cfg.variants?.length && sub === "compare" ? cfg.variants : [{}];
  console.error(dim(`whip: ${target} → ${adapter} adapter · ${tasks.length} tasks × ${repeat}${sets.length > 1 ? ` × ${sets.length} variants` : ""}`));

  const runs: Run[] = [];
  for (const v of sets) {
    let done = 0;
    const run = await runSuite({ harness, target, adapter, tasks, repeat, vars: load(v), onTask: () => process.stderr.isTTY && process.stderr.write(`\r${dim(`  ${++done}/${tasks.length}`)}`) });
    run.variant = v;
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    await save(run, !!o.noSave);
    runs.push(run);
    console.log(scorecard(run) + "\n");
  }
  for (const r of runs.slice(1)) console.log(diff(runs[0], r, Object.values(r.variant).join(",")) + "\n");
  if (!o.noSave) { await Bun.write(".whip/report.html", html(runs)); console.log(dim(`saved ${RUNS}/${runs.at(-1)!.id}.json · report .whip/report.html · next: whip suggest`)); }
}

main().catch((e) => { console.error(`whip: ${(e as Error).message}`); process.exit(1); });
