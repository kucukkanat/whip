import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runCheck } from "./checks";
import type { Attempt, Harness, Run, Task, TaskResult, ToolCall, ToolSim } from "./types";

const ROOT = join(import.meta.dir, "..");

/** Default suite (tasks/*.yaml) + anything in ./evals/. */
export function loadTasks(extraDir = "evals", only?: string): Task[] {
  const dirs = [join(ROOT, "tasks"), extraDir].filter((d) => existsSync(d));
  const tasks: Task[] = [];
  for (const d of dirs) for (const f of readdirSync(d).sort()) {
    if (!/\.ya?ml$|\.json$/.test(f)) continue;
    const raw = readFileSync(join(d, f), "utf8");
    const parsed = f.endsWith(".json") ? JSON.parse(raw) : Bun.YAML.parse(raw);
    for (const t of [parsed].flat() as Task[]) tasks.push({ ...t, id: t.id ?? f.replace(/\.\w+$/, "") });
  }
  return only ? tasks.filter((t) => new RegExp(only).test(t.id) || t.category === only) : tasks;
}

/** Describes the tools in-prompt with a text protocol so ANY harness (incl. plain CLIs) can call them. */
export function renderPrompt(task: Task, history: string[]): string {
  let p = task.prompt;
  if (task.tools?.length) {
    p += "\n\nTools available. To call one, reply with a line exactly like: TOOL <name> {\"arg\":\"value\"}\n";
    for (const t of task.tools) p += `- ${t.name}(${Object.entries(t.params ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")}): ${t.description}\n`;
  }
  if (history.length) p += "\n\nTool results so far:\n" + history.join("\n") + "\nContinue. Give the final answer when done.";
  return p;
}

function simulate(task: Task, call: ToolCall, counts: Map<string, number>): string {
  const tool = task.tools?.find((t) => t.name === call.name);
  if (!tool) return `ERROR: unknown tool "${call.name}"`;
  const n = (counts.get(call.name) ?? 0) + 1; counts.set(call.name, n);
  const sims: ToolSim[] = [tool.sim ?? { result: "ok" }].flat();
  const sim = sims.find((s) => !s.when || Object.entries(s.when).every(([k, v]) => String((call.args as any)?.[k]) === v)) ?? sims.at(-1)!;
  if (sim.failFirst && n <= sim.failFirst) return `ERROR: ${sim.error ?? "temporary failure, try again"}`;
  return sim.result;
}

export async function runTask(h: Harness, task: Task, vars: Record<string, string>, maxTurns = 4): Promise<Attempt> {
  const cwd = mkdtempSync(join(tmpdir(), `whip-${task.id}-`));
  for (const [f, c] of Object.entries(task.files ?? {})) { mkdirSync(dirname(join(cwd, f)), { recursive: true }); await Bun.write(join(cwd, f), c); }
  const allCalls: ToolCall[] = [], history: string[] = [], counts = new Map<string, number>();
  let out = { text: "", ms: 0 } as Awaited<ReturnType<Harness>>, ms = 0;
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      out = await h({ prompt: renderPrompt(task, history), tools: task.tools, files: task.files, cwd, vars });
      ms += out.ms;
      const calls = out.toolCalls ?? [];
      allCalls.push(...calls);
      if (!task.tools?.length || !calls.length) break;
      for (const c of calls) history.push(`${c.name}(${JSON.stringify(c.args)}) -> ${simulate(task, c, counts)}`);
    }
  } catch (e) { out = { text: `HARNESS ERROR: ${(e as Error).message}`, exitCode: 1, ms }; }
  const failed = task.checks.map((c) => runCheck(c, { out, toolCalls: allCalls, cwd })).filter((x): x is string => !!x);
  if (out.exitCode && !task.checks.some((c) => "exitCode" in c)) failed.unshift(`exit ${out.exitCode}: ${out.text.slice(0, 60)}`);
  rmSync(cwd, { recursive: true, force: true });
  return { pass: failed.length === 0, ms, failed, text: out.text.slice(0, 2000), toolCalls: allCalls };
}

export async function runSuite(opts: { harness: Harness; target: string; adapter: "sdk" | "cli"; tasks: Task[]; repeat: number; vars: Record<string, string>; concurrency?: number; onTask?: (r: TaskResult) => void }): Promise<Run> {
  const results: TaskResult[] = [];
  const queue = [...opts.tasks];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const attempts: Attempt[] = [];
      for (let i = 0; i < opts.repeat; i++) attempts.push(await runTask(opts.harness, t, opts.vars));
      const r = { id: t.id, category: t.category, passRate: attempts.filter((a) => a.pass).length / attempts.length, meanMs: attempts.reduce((s, a) => s + a.ms, 0) / attempts.length, attempts };
      results.push(r); opts.onTask?.(r);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? (opts.adapter === "sdk" ? 4 : 2) }, worker));
  results.sort((a, b) => opts.tasks.findIndex((t) => t.id === a.id) - opts.tasks.findIndex((t) => t.id === b.id));
  const cats: Record<string, number[]> = {};
  for (const r of results) (cats[r.category] ??= []).push(r.passRate);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const now = new Date();
  return {
    whip: 1, id: now.toISOString().replace(/[:.]/g, "-"), target: opts.target, adapter: opts.adapter, variant: opts.vars,
    repeat: opts.repeat, startedAt: now.toISOString(), score: avg(results.map((r) => r.passRate)),
    categories: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, avg(v)])), tasks: results,
  };
}
