import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonl, resolveTuner } from "./adapters";
import { renderPrompt, runSuite } from "./engine";
import { bold, dim, green, HINTS, hintKey, html, red, yellow } from "./report";
import type { Edit, Harness, Run, Task, TaskResult, TuneLog, TuneStep } from "./types";

export type Candidate = Edit & { source: string; tasks?: string[] };
export type ProposeCtx = { lines: string[]; train: Run; tasks: Task[] };
export type Proposer = { kind: "library" | "tuner"; label: string; propose: (ctx: ProposeCtx) => Promise<Candidate[]> };
export type Scores = { train: number; heldout: number; cats: Record<string, number> };
/** How much a drop can be pure measurement noise (0 for tasks that always pass or always fail). */
export type Noise = { heldout?: number; cats?: Record<string, number> };

/** A category may not lose more than this (0.1 = 10 points) for an edit to be kept. */
export const CATEGORY_DROP = 0.1;
const EPS = 1e-9;
const pts = (x: number) => Math.round(x * 100);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// ---------- split ----------

const mulberry32 = (a: number) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = <T>(xs: T[], rand: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** Seeded, stratified split: held-out tasks are drawn round-robin across categories, never emptying a category from train. */
export function splitTasks(tasks: Task[], holdout = 0.3, seed = 1): { train: Task[]; heldout: Task[] } {
  const rand = mulberry32(seed);
  const byCat = new Map<string, Task[]>();
  for (const t of tasks) (byCat.get(t.category) ?? byCat.set(t.category, []).get(t.category)!).push(t);
  const pools = shuffle([...byCat.values()].map((ts) => shuffle(ts, rand)), rand);
  const k = Math.round(tasks.length * Math.min(Math.max(holdout, 0), 0.9));
  const held = new Set<Task>();
  for (let progressed = true; held.size < k && progressed;) {
    progressed = false;
    for (const p of pools) if (held.size < k && p.length > 1) { held.add(p.pop()!); progressed = true; }
  }
  return { train: tasks.filter((t) => !held.has(t)), heldout: tasks.filter((t) => held.has(t)) };
}

// ---------- edits ----------

/** Every top-level JSON value in `s` (objects/arrays), tolerating prose around them and trailing commas inside. */
function* jsonValues(s: string): Generator<unknown> {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{" && s[i] !== "[") continue;
    let depth = 0, str = false, end = -1;
    for (let j = i; j < s.length && end < 0; j++) {
      const ch = s[j];
      if (str) { if (ch === "\\") j++; else if (ch === '"') str = false; continue; }
      if (ch === '"') str = true;
      else if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) end = j;
    }
    if (end < 0) continue;
    const raw = s.slice(i, end + 1);
    for (const attempt of [raw, raw.replace(/,\s*([}\]])/g, "$1")]) {
      try { yield JSON.parse(attempt); i = end; break; } catch { /* try lenient form, then move on */ }
    }
  }
}

const OPS: Record<string, Edit["op"]> = { add: "add", append: "add", insert: "add", replace: "replace", update: "replace", modify: "replace", edit: "replace", remove: "remove", delete: "remove", drop: "remove" };
const oneLine = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");

function toEdits(v: unknown): Edit[] {
  if (Array.isArray(v)) return v.flatMap(toEdits);
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.edits)) return o.edits.flatMap(toEdits);
  const op = OPS[oneLine(o.op ?? o.action ?? o.type).toLowerCase()] ?? (o.op === undefined && o.line ? "add" : undefined);
  const target = oneLine(o.target ?? o.old ?? o.find) || undefined;
  const line = oneLine(o.line ?? o.text ?? o.new ?? o.content) || (op === "remove" ? target ?? "" : "");
  if (!op || !line || line.length > 400) return [];
  return [{ op, line, ...(target && op !== "remove" ? { target } : {}), ...(o.reason ? { reason: oneLine(o.reason) } : {}) }];
}

/** Pull `{edits:[{op, line, target?, reason?}]}` out of whatever a model printed: fences, prose, a bare edit, an array, trailing junk. */
export function parseEdits(text: string, max = 8): Edit[] {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const blocks = [...clean.matchAll(/```[\w-]*\s*\n?([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of [...blocks, clean]) {
    const edits = [...jsonValues(b)].flatMap(toEdits);
    if (edits.length) return edits.slice(0, max);
  }
  return [];
}

/** Apply one edit to instruction lines. Returns null when it is a no-op or its line can't be found. */
export function applyEdit(lines: string[], e: Edit): string[] | null {
  const find = (t: string) => {
    const n = norm(t), exact = lines.findIndex((l) => norm(l) === n);
    return exact >= 0 || n.length < 8 ? exact : lines.findIndex((l) => norm(l).includes(n));
  };
  if (e.op === "remove") { const i = find(e.line); return i < 0 ? null : lines.filter((_, j) => j !== i); }
  if (lines.some((l) => norm(l) === norm(e.line))) return null;
  const i = e.op === "replace" && e.target ? find(e.target) : -1;
  return i < 0 ? [...lines, e.line] : lines.map((l, j) => (j === i ? e.line : l)); // replace with a lost target degrades to add
}

// ---------- rules ----------

/**
 * Keep rule: no category drops > CATEGORY_DROP, train rises (or, when pruning, holds), held-out does not drop.
 * A drop only counts when it exceeds `noise` (see `noiseOf`); with deterministic tasks that is 0 and the rule is strict.
 */
export function verdict(cur: Scores, next: Scores, requireGain = true, noise: Noise = {}): { keep: boolean; why: string } {
  const drops = Object.entries(cur.cats).map(([k, v]) => [k, (next.cats[k] ?? 0) - v] as const)
    .filter(([k, d]) => d < -Math.max(CATEGORY_DROP, noise.cats?.[k] ?? 0) - EPS).sort((a, b) => a[1] - b[1]);
  if (drops.length) return { keep: false, why: `${drops[0][0]} −${pts(-drops[0][1])}` };
  if (next.train < cur.train - EPS) return { keep: false, why: `train −${pts(cur.train - next.train)}` };
  if (requireGain && next.train <= cur.train + EPS) return { keep: false, why: "no gain" };
  if (next.heldout < cur.heldout - (noise.heldout ?? 0) - EPS) return { keep: false, why: `held-out −${pts(cur.heldout - next.heldout)}` };
  return { keep: true, why: "" };
}

/** Two standard errors of the difference in mean pass rate between two runs (unpooled per-task Bernoulli variance: a task that flips 1 → 0 is a real change). */
export function noiseOf(a?: Run, b?: Run, category?: string): number {
  if (!a || !b) return 0;
  const ts = a.tasks.filter((t) => !category || t.category === category);
  let v = 0;
  for (const t of ts) {
    const u = b.tasks.find((x) => x.id === t.id);
    if (!u) continue;
    v += (t.passRate * (1 - t.passRate)) / (t.attempts.length || 1) + (u.passRate * (1 - u.passRate)) / (u.attempts.length || 1);
  }
  return ts.length ? 2 * Math.sqrt(v) / ts.length : 0;
}
const noise = (curT: Run, nextT: Run, curH?: Run, nextH?: Run): Noise =>
  ({ heldout: noiseOf(curH, nextH), cats: Object.fromEntries(Object.keys(curT.categories).map((k) => [k, noiseOf(curT, nextT, k)])) });

// ---------- proposers ----------

/** Library mode: map current train failures to hint keys (same rules as `whip suggest`), try each key's lines. No model. */
export function libraryProposer(): Proposer {
  return {
    kind: "library", label: "library",
    async propose({ lines, train }) {
      const byKey = new Map<keyof typeof HINTS, Set<string>>();
      for (const t of train.tasks) for (const a of t.attempts) if (a.failed[0]) {
        const k = hintKey(t.category, a.failed[0]);
        (byKey.get(k) ?? byKey.set(k, new Set()).get(k)!).add(t.id);
      }
      const have = new Set(lines.map(norm));
      const adds = [...byKey].sort((a, b) => b[1].size - a[1].size).flatMap(([k, ids]) =>
        HINTS[k].lines.filter((l) => !have.has(norm(l))).map((line): Candidate => ({ op: "add", line, reason: k, source: "library", tasks: [...ids] })));
      // Escape local optima: an earlier pick can block a later fix ("skip caveats" vs "never invent"), so also try its siblings.
      const swaps = lines.flatMap((l) => Object.entries(HINTS).filter(([, h]) => h.lines.some((x) => norm(x) === norm(l)))
        .flatMap(([k, h]) => h.lines.filter((x) => !have.has(norm(x))).map((line): Candidate => ({ op: "replace", target: l, line, reason: k, source: "library" }))));
      return [...adds, ...swaps];
    },
  };
}

const indent = (s: string) => s.trim().split("\n").map((l) => "  " + l).join("\n");

/** The editor prompt: current instructions + failed train tasks (prompt, actual output, broken checks). Held-out tasks never appear. */
export function buildTunerPrompt(lines: string[], failed: { task: Task; result: TaskResult }[], maxEdits = 5): string {
  const blocks = failed.slice(0, 8).map(({ task, result }) => {
    const a = result.attempts.find((x) => !x.pass)!;
    const calls = a.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ") || "none";
    return [`### task ${task.id} [${task.category}]  passed ${pts(result.passRate)}%`, "Task prompt:", indent(renderPrompt(task, [])), "Agent output:", indent(a.text.slice(0, 400) || "(empty)"), `Tool calls: ${calls}`, `Broken check: ${a.failed.join("; ")}`].join("\n");
  });
  return `You are editing the system prompt (instructions) of an AI agent so it passes more tasks.
Current instructions, one per line, between the tags:
<instructions>
${lines.join("\n")}
</instructions>

The agent failed these tasks:

${blocks.join("\n\n")}

Propose up to ${maxEdits} edits to the instructions. Rules:
- Each edit is one short, general, imperative line that would help similar tasks too. Do not mention task ids or expected answers.
- op "add" appends "line"; op "replace" swaps the existing line "target" for "line"; op "remove" deletes "line".
- Reply with ONLY this JSON, no prose, no code fences:
{"edits":[{"op":"add","line":"...","reason":"..."},{"op":"replace","target":"<existing line>","line":"...","reason":"..."}]}`;
}

/** Run a tuner CLI once in a throwaway directory. Prompt via {prompt} or stdin; returns its text answer. */
export async function runTuner(spec: string, prompt: string, timeoutMs = 300_000): Promise<string> {
  const { argv, stdin } = resolveTuner(spec);
  const cwd = mkdtempSync(join(tmpdir(), "whip-tuner-"));
  try {
    const p = Bun.spawn(argv.map((a) => a.replaceAll("{prompt}", prompt)), { cwd, stdin: stdin ? new Blob([prompt]) : "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    if (code !== 0 && !out.trim()) throw new Error(`exited ${code}: ${(err.trim() || "no output").slice(0, 200)}`);
    return parseJsonl(out)?.text || out;
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

/** `--tuner <cmd>`: any CLI as the editor. One propose() = one tuner call. */
export function tunerProposer(spec: string, timeoutMs?: number, call = runTuner): Proposer {
  return {
    kind: "tuner", label: "tuner",
    async propose({ lines, train, tasks }) {
      const failed = train.tasks.filter((r) => r.passRate < 1).map((result) => ({ task: tasks.find((t) => t.id === result.id)!, result }));
      return parseEdits(await call(spec, buildTunerPrompt(lines, failed), timeoutMs)).map((e) => ({ ...e, source: "tuner" }));
    },
  };
}

// ---------- confirmation ----------

/** "go" with --yes or a typed y/yes; "need-yes" when nobody can answer (stdin is not a TTY). */
export async function confirmGate(o: { yes?: boolean; tty: boolean; question: string; ask: (q: string) => string | null | Promise<string | null> }): Promise<"go" | "abort" | "need-yes"> {
  if (o.yes) return "go";
  if (!o.tty) return "need-yes";
  return /^\s*y(es)?\s*$/i.test((await o.ask(o.question)) ?? "") ? "go" : "abort";
}

// ---------- loop ----------

export type TuneOpts = {
  harness: Harness; target: string; adapter: "sdk" | "cli"; tasks: Task[]; repeat: number;
  key: string; instructions: string; vars?: Record<string, string>;
  proposer: Proposer; budget?: number; holdout?: number; seed?: number; heldoutIds?: string[];
  maxRounds?: number; prune?: boolean; recheck?: boolean;
  confirm?: (estimate: string) => Promise<boolean>; log?: (line: string) => void;
  /** Runs once after the baseline is scored; throw to stop before any edit is tried. */
  afterBaseline?: () => void | Promise<void>;
};
export type TuneResult = TuneLog & { aborted?: boolean; baselineRun: Run; finalRun: Run };

const label = (e: Edit) => { const s = e.line.length > 44 ? e.line.slice(0, 43) + "…" : e.line; return e.op === "add" ? `+${s}` : e.op === "remove" ? `−${s}` : `~${s}`; };

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
/** Recompute score and categories for a run from its task results. */
function withTasks(r: Run, tasks: TaskResult[], extra: Partial<Run> = {}): Run {
  const cats: Record<string, number[]> = {};
  for (const t of tasks) (cats[t.category] ??= []).push(t.passRate);
  return { ...r, ...extra, tasks, score: avg(tasks.map((t) => t.passRate)), categories: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, avg(v)])) };
}
/** Combine train and held-out runs into one full-suite Run in suite order. */
const mergeRuns = (a: Run, b: Run | undefined, order: Task[], id: string, variant: Record<string, string>) =>
  withTasks(a, [...a.tasks, ...(b?.tasks ?? [])].sort((x, y) => order.findIndex((t) => t.id === x.id) - order.findIndex((t) => t.id === y.id)), { id, variant });
/** Pool the attempts of two runs of the same tasks: a re-check sharpens the estimate instead of replacing it. */
const pool = (a: Run, b: Run) => withTasks(a, a.tasks.map((t) => {
  const attempts = [...t.attempts, ...(b.tasks.find((u) => u.id === t.id)?.attempts ?? [])];
  return { ...t, attempts, passRate: attempts.filter((x) => x.pass).length / attempts.length, meanMs: avg(attempts.map((x) => x.ms)) };
}));
/** Some task neither always passes nor always fails: the verdict may be noise. */
const flaky = (...rs: (Run | undefined)[]) => rs.some((r) => r?.tasks.some((t) => t.passRate > EPS && t.passRate < 1 - EPS));

const improved = (before: Run | undefined, after: Run | undefined) =>
  after?.tasks.filter((t) => t.passRate > (before?.tasks.find((s) => s.id === t.id)?.passRate ?? 1) + EPS).map((t) => t.id) ?? [];

/**
 * Greedy tuning: propose edits from train failures, score each against the current instructions,
 * keep it if `verdict` says so, stack kept edits, stop at a plateau or when the tuner budget is spent.
 * Then prune: drop any line whose removal costs nothing.
 */
export async function tune(o: TuneOpts): Promise<TuneResult> {
  const t0 = performance.now(), log = o.log ?? (() => {});
  const budget = o.budget ?? 5, holdout = o.holdout ?? 0.3, seed = o.seed ?? 1;
  const split = o.heldoutIds
    ? { train: o.tasks.filter((t) => !o.heldoutIds!.includes(t.id)), heldout: o.tasks.filter((t) => o.heldoutIds!.includes(t.id)) }
    : splitTasks(o.tasks, holdout, seed);
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const tuner = o.proposer.kind === "tuner";
  const perEval = o.tasks.length * o.repeat;

  if (tuner && o.confirm) {
    const est = `up to ${budget} tuner call${budget === 1 ? "" : "s"} (≤5 edits each) and ~${perEval * (1 + budget * 5)} target runs (${o.tasks.length} tasks × ${o.repeat} per scoring)`;
    if (!(await o.confirm(est))) return { aborted: true } as TuneResult;
  }

  const run = (tasks: Task[], text: string) => runSuite({ harness: o.harness, target: o.target, adapter: o.adapter, tasks, repeat: o.repeat, vars: { ...o.vars, [o.key]: text } });
  const scores = (tr: Run, ho?: Run): Scores => ({ train: tr.score, heldout: ho ? ho.score : 0, cats: tr.categories });
  const hasHeld = split.heldout.length > 0, recheck = o.recheck ?? true;

  let lines = o.instructions.split("\n").map((l) => l.trimEnd()).filter((l, i, a) => l || (i > 0 && i < a.length - 1));
  let curTrain = await run(split.train, lines.join("\n"));
  let curHeld = hasHeld ? await run(split.heldout, lines.join("\n")) : undefined;
  const baseTrain = curTrain, baseHeld = curHeld;
  await o.afterBaseline?.();
  log(dim(`baseline  train ${pts(curTrain.score)}% (${split.train.length} tasks) · held-out ${hasHeld ? pts(curHeld!.score) + "%" : "–"} (${split.heldout.length} tasks) · ${o.proposer.label}`));

  const steps: TuneStep[] = [];
  /** Score one candidate; train first, held-out only if train already passes the rules. */
  const attempt = async (e: Candidate, phase: TuneStep["phase"]) => {
    const next = applyEdit(lines, e);
    if (!next) { log(dim(`  · ${label(e)}  skipped (${e.op === "remove" ? "line not found" : "already present"})`)); return false; }
    const text = next.join("\n");
    const cur = lines.join("\n"), gain = phase === "tune";
    let tr = await run(split.train, text);
    let v = verdict(scores(curTrain, curHeld), { ...scores(tr), heldout: curHeld?.score ?? 0 }, gain, noise(curTrain, tr));
    if (!v.keep && recheck && (flaky(curTrain, tr) || tr.score > curTrain.score)) { // noise may have decided it, or a gain is at stake: score both sides once more, judge pooled attempts
      [curTrain, tr] = [pool(curTrain, await run(split.train, cur)), pool(tr, await run(split.train, text))];
      v = verdict(scores(curTrain, curHeld), { ...scores(tr), heldout: curHeld?.score ?? 0 }, gain, noise(curTrain, tr));
    }
    let ho: Run | undefined;
    if (v.keep && hasHeld) {
      ho = await run(split.heldout, text);
      v = verdict(scores(curTrain, curHeld), scores(tr, ho), gain, noise(curTrain, tr, curHeld, ho));
      if (!v.keep && recheck) { // train already gained here: re-score the held-out side before throwing that away
        [curHeld, ho] = [pool(curHeld!, await run(split.heldout, cur)), pool(ho, await run(split.heldout, text))];
        v = verdict(scores(curTrain, curHeld), scores(tr, ho), gain, noise(curTrain, tr, curHeld, ho));
      }
    }
    const step: TuneStep = { ...(({ source, tasks, ...rest }) => rest)(e), phase, source: e.source, kept: v.keep, why: v.why,
      train: [curTrain.score, tr.score], ...(ho && curHeld ? { heldout: [curHeld.score, ho.score] as [number, number] } : {}), fixed: v.keep ? [...improved(curTrain, tr), ...improved(curHeld, ho)] : [] };
    steps.push(step);
    const nums = `${String(pts(curTrain.score)).padStart(3)} → ${String(pts(tr.score)).padEnd(3)}`;
    const name = label(e).padEnd(46);
    if (phase === "prune") log(v.keep ? `${green("✓")} ${name} ${nums}  ${green("removed")} ${dim("(prune)")}` : dim(`· ${name} ${nums}  needed (${v.why})`));
    else log(v.keep ? `${green("✓")} ${name} ${nums}  ${green("kept")} ${dim(`(${e.source})`)}` : `${red("✗")} ${name} ${nums}  ${red("rejected")} ${dim(`(${v.why})`)}`);
    if (v.keep) { lines = next; curTrain = tr; curHeld = ho ?? curHeld; }
    return v.keep;
  };

  let calls = 0, barren = 0;
  const maxRounds = o.maxRounds ?? 10, patience = tuner ? 2 : 1;
  for (let round = 0; round < maxRounds; round++) {
    if (curTrain.score >= 1 - EPS) { log(dim("all train tasks pass")); break; }
    if (tuner && calls >= budget) { log(dim(`budget spent (${calls} tuner call${calls === 1 ? "" : "s"})`)); break; }
    let cands: Candidate[] = [];
    try { if (tuner) calls++; cands = await o.proposer.propose({ lines, train: curTrain, tasks: o.tasks }); }
    catch (e) { log(yellow(`! tuner call failed: ${(e as Error).message}`)); }
    if (tuner) log(dim(`tuner call ${calls}/${budget}: ${cands.length} edit${cands.length === 1 ? "" : "s"}`));
    let kept = 0;
    for (const c of cands) {
      const failing = new Set(curTrain.tasks.filter((t) => t.passRate < 1).map((t) => t.id));
      if (c.tasks && !c.tasks.some((t) => failing.has(t))) continue; // an earlier edit already fixed what this one targets
      if (await attempt(c, "tune")) kept++;
    }
    barren = kept ? 0 : barren + 1;
    if (barren >= patience) { log(dim("plateau: no edit improved the score")); break; }
  }

  if (o.prune ?? true) for (const l of [...lines]) if (l.trim()) await attempt({ op: "remove", line: l, source: "prune" }, "prune");

  const finalTrain = curTrain, finalHeld = curHeld;
  const variant = (v: string) => ({ [o.key]: v });
  const baselineRun = mergeRuns(baseTrain, baseHeld, o.tasks, `${id}-tune-baseline`, variant("baseline"));
  const finalRun = mergeRuns(finalTrain, finalHeld, o.tasks, `${id}-tune-final`, variant("tuned.md"));
  const summary = (r: Run, tr: Run, ho?: Run) => ({ score: r.score, train: tr.score, heldout: ho?.score ?? 0, categories: r.categories });
  const tuneSteps = steps.filter((s) => s.phase === "tune");
  return {
    whip: 1, id, target: o.target, proposer: o.proposer.label, key: o.key, seed, holdout, repeat: o.repeat,
    split: { train: split.train.map((t) => t.id), heldout: split.heldout.map((t) => t.id) },
    baseline: summary(baselineRun, baseTrain, baseHeld), final: summary(finalRun, finalTrain, finalHeld),
    instructions: { before: o.instructions, after: lines.join("\n") },
    steps, changelog: tuneSteps.filter((s) => s.kept).map((s) => ({ line: s.line, fixed: s.fixed })),
    kept: tuneSteps.filter((s) => s.kept).length, rejected: tuneSteps.filter((s) => !s.kept).length,
    removed: steps.filter((s) => s.phase === "prune" && s.kept).length, tunerCalls: calls, elapsedMs: performance.now() - t0,
    baselineRun, finalRun,
  };
}

// ---------- output ----------

export function tuneSummary(r: TuneResult): string {
  const failing = r.finalRun.tasks.filter((t) => t.passRate < 1).map((t) => t.id);
  const L = [
    "",
    bold("Whip tune") + dim(`  ${r.target} · ${r.proposer} · ${r.split.train.length} train / ${r.split.heldout.length} held-out · ×${r.repeat}`),
    `  ${bold("score")} ${pts(r.baseline.score)}% → ${bold(pts(r.final.score) + "%")}   ${dim(`train ${pts(r.baseline.train)} → ${pts(r.final.train)} · held-out ${r.split.heldout.length ? `${pts(r.baseline.heldout)} → ${pts(r.final.heldout)}` : "none"}`)}`,
    `  ${green(`kept ${r.kept}`)} · ${red(`rejected ${r.rejected}`)} · pruned ${r.removed} · ${r.tunerCalls} tuner call${r.tunerCalls === 1 ? "" : "s"} · ${(r.elapsedMs / 1000).toFixed(1)}s`,
  ];
  if (failing.length) L.push(yellow(`  still failing: ${failing.join(", ")}`) + (r.proposer === "library" ? dim("\n  the hint library is out of ideas; try a model as editor: whip tune <target> --tuner claude") : ""));
  return L.join("\n");
}

/** Write .whip/tuned.md and, unless `save` is off, .whip/tune-<id>.json, the report and the runs. Never touches the user's prompt file. */
export async function writeTune(r: TuneResult, dir = ".whip", save = true): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const { baselineRun, finalRun, aborted, ...log } = r;
  const files = [join(dir, "tuned.md"), join(dir, `tune-${r.id}.json`), join(dir, "report.html")];
  await Bun.write(files[0], r.instructions.after.trim() + "\n");
  if (!save) return files.slice(0, 1);
  await Bun.write(files[1], JSON.stringify(log, null, 2));
  await Bun.write(files[2], html([baselineRun, finalRun], log));
  mkdirSync(join(dir, "runs"), { recursive: true });
  for (const run of [baselineRun, finalRun]) await Bun.write(join(dir, "runs", `${run.id}.json`), JSON.stringify(run, null, 2));
  return files;
}
