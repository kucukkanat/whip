#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { detect, KNOWN_CLIS, makeHarness, reach, resolveTuner, targetProblem, TUNER_CLIS, type TrackedHarness } from "./adapters";
import { checkConfig, checkKey, closest, COMMANDS, type Command, type Config, count, fail, parseArgs, parseVariant, removedCommand, type Variant } from "./args";
import { loadTasks, runSuite } from "./engine";
import { bold, diff, dim, html, scorecard, suggest, yellow } from "./report";
import { confirmGate, libraryProposer, tune, tunerProposer, tuneSummary, writeTune } from "./tune";
import type { Run } from "./types";

const table = (t: Record<string, string[]>) => Object.entries(t).map(([k, v]) => `    ${k.padEnd(9)} ${v.join(" ")}`).join("\n");

const HELP = `${bold("whip")} - score an agent harness, then improve its prompt

  whip <target>                                   run the tasks, print a scorecard and hints
  whip <target> -v system=@a.md -v system=@b.md   compare two prompts: one run each, then the diff
  whip tune <target> prompts/a.md                 let whip edit the prompt; only edits that score better stay
  whip diff [old] [new]                           compare two saved runs (default: the last two)

  <target>  claude | codex | opencode | copilot | gemini | aider | goose | "ollama <model>"   (built-in CLIs)
            ./my-harness.ts            your code: default-export (prompt, ctx) => answer
            "my-agent --flag {prompt}" any command: the prompt goes at {prompt}, otherwise on stdin

  -v key=value      a variable for your harness; key=@file reads a file
                    reaches it as ctx.vars.key (code) or $WHIP_KEY / {key} (commands)
  -n N              attempts per task (3)           --only <regex|category>  run some tasks
  --evals <dir>     your own tasks (./evals)        --no-save                write nothing to .whip/

  details: whip run --help · whip tune --help · whip diff --help`;

const SUITE_FLAGS = `  -v, --variant key=value  a variable for your harness; key=@path reads a file. Repeat a key to compare values:
                           -v system=@a.md -v system=@b.md runs twice. Keys given once apply to every run.
  -n, --repeat N           attempts per task (default 3)
  --only <regex|category>  only tasks whose id matches or whose category equals it
  --evals <dir>            your own task files, added to the built-in suite (default ./evals)
  --no-save                don't write .whip/runs/ or .whip/report.html
  -h, --help               this help`;

const CMD_HELP: Record<Command, string> = {
  run: `${bold("whip [run] <target>")} - run the tasks against a harness, print a scorecard and hints

  <target>  a built-in CLI, a .ts/.js harness file, or any quoted command (see below)
            optional when whip.config.ts sets target

${SUITE_FLAGS}

  Built-in targets run exactly this ({prompt} = the task prompt):
${table(KNOWN_CLIS)}
  They don't receive -v variables. To pass one, use your own command, e.g.
    whip "claude -p {prompt} --append-system-prompt {system}" -v system=@a.md

  Variables reach your harness as ctx.vars.<key> (.ts/.js), and as $WHIP_<KEY> and {key} (commands).
  Writes .whip/runs/<id>.json and .whip/report.html. Exit 0 whatever the score, 1 on error.`,
  tune: `${bold("whip tune <target> [prompt-file]")} - improve a prompt: try one edit at a time, keep it only if
the score rises, no category drops more than 10 points and held-out tasks don't drop

  whip tune ./my-harness.ts prompts/a.md                  edit prompts/a.md (as ctx.vars.system), no model needed
  whip tune ./my-harness.ts prompts/a.md --tuner claude   let a model propose the edits
  whip tune ./my-harness.ts prompts/a.md --write          also save the result into prompts/a.md

  [prompt-file]  the starting prompt (default: -v system=..., else empty). Saved to .whip/tuned.md
  --key <name>   the variable being tuned (default system → ctx.vars.system, $WHIP_SYSTEM, {system})
  --tuner <cmd>  who proposes edits. Default: whip's built-in hints (offline). Presets:
${table(TUNER_CLIS)}
                 name:<model> adds --model <model> (ollama:<model> picks the model). Or any command
                 that reads the prompt at {prompt} or on stdin and replies {"edits":[{op,line,target?,reason}]}
  --budget N     max tuner calls (default 5)
  --write        overwrite the prompt file with the result (otherwise only .whip/tuned.md)
  -y, --yes      don't ask before calling the tuner (needed when there's no terminal, e.g. CI)
  -v, -n, --only, --evals, --no-save   as in whip run --help

  Rarely needed, in whip.config.ts: tune: { holdout: 0.3, seed: 1, timeout: 300000 }`,
  diff: `${bold("whip diff [old] [new]")} - compare two saved runs, then show hints for the newer one

  run refs: latest | latest~N (N runs before the latest) | a run id from .whip/runs | a path
  default: latest~1 latest
  --html   also write both runs to .whip/report.html`,
};

const RUNS = ".whip/runs";
const listRuns = () => (existsSync(RUNS) ? readdirSync(RUNS).filter((f) => f.endsWith(".json")).sort() : []);
function loadRun(ref: string): Run {
  const rs = listRuns();
  if (!rs.length && !existsSync(ref)) fail(`no saved runs yet in ${RUNS}. Run something first: whip <target>`);
  const m = ref.match(/^latest(?:~(\d+))?$/);
  const p = m ? (rs[rs.length - 1 - Number(m[1] ?? 0)] && join(RUNS, rs[rs.length - 1 - Number(m[1] ?? 0)])) : existsSync(ref) ? ref : join(RUNS, ref.replace(/\.json$/, "") + ".json");
  if (!p || !existsSync(p)) fail(`run not found: ${ref}. There ${rs.length === 1 ? "is 1 saved run" : `are ${rs.length} saved runs`}: use latest${rs.length > 1 ? ` to latest~${rs.length - 1}` : ""}, an id from ${RUNS}, or a path`);
  return JSON.parse(readFileSync(p!, "utf8"));
}

const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
const warn = (s: string) => console.error(yellow(`whip: ${s}`));

/**
 * Turn -v flags (or config variants) into runs. A key given once is shared by every run; a key given several times
 * gives one run per value. Only one key may vary, so each comparison has one cause.
 */
export function variantSets(vs: Variant[]): { vars: Record<string, string>; labels: Record<string, string> }[] {
  const by = new Map<string, Variant[]>();
  for (const v of vs) (by.get(v.key) ?? by.set(v.key, []).get(v.key)!).push(v);
  const varying = [...by].filter(([, xs]) => xs.length > 1).map(([k]) => k);
  if (varying.length > 1) fail(`only one variable can change between runs, but ${varying.join(" and ")} both have several values. Compare one change at a time, or list exact combinations in whip.config.ts: variants: [{ ${varying.map((k) => `${k}: "..."`).join(", ")} }, ...]`);
  const shared = [...by].filter(([, xs]) => xs.length === 1).map(([, xs]) => xs[0]);
  const rows = varying.length ? by.get(varying[0])!.map((v) => [...shared, v]) : [shared];
  return rows.map((r) => ({ vars: Object.fromEntries(r.map((v) => [v.key, v.value])), labels: Object.fromEntries(r.map((v) => [v.key, v.label])) }));
}

async function loadConfig(): Promise<Config | undefined> {
  if (!existsSync("whip.config.ts")) return undefined;
  return checkConfig((await import(resolve("whip.config.ts"))).default);
}

/** Config `variants: [{system: "@a.md"}]` → one set per entry, same rules as -v. */
const configSets = (cfg: Config) => cfg.variants!.map((o) => {
  const vs = Object.entries(o).map(([k, v]) => parseVariant(`${k}=${v}`, "whip.config.ts variants:"));
  return { vars: Object.fromEntries(vs.map((v) => [v.key, v.value])), labels: Object.fromEntries(vs.map((v) => [v.key, v.label])) };
});

function suite(flags: Record<string, string | true>, cfg: Config) {
  const repeat = count(flags.repeat ?? cfg.repeat, "-n", "-n 5") ?? 3;
  const only = (flags.only as string | undefined) ?? cfg.only;
  if (only) try { new RegExp(only); } catch { fail(`--only "${only}" is not a valid regex. Use a task id pattern like "^tool-" or a category like format`); }
  const evals = String(flags.evals ?? cfg.evals ?? "evals");
  if ((flags.evals || cfg.evals) && !existsSync(evals)) fail(`--evals ${evals}: directory not found`);
  const tasks = loadTasks(evals, only);
  if (!tasks.length) {
    const all = loadTasks(evals);
    const g = only && closest(only, [...new Set(all.map((t) => t.category))]);
    fail(`--only ${only} matched no tasks.${g ? ` Did you mean --only ${g}?` : ""} Categories: ${[...new Set(all.map((t) => t.category))].join(", ")}`);
  }
  return { repeat, tasks };
}

function pickTarget(pos: string[], cfg: Config, cmd: Command, max: number): string {
  if (pos.length > max) {
    const last = pos.at(-1)!, file = existsSync(last) && /\.(md|txt)$/.test(last) ? last : undefined;
    if (cmd === "run" && file && pos.length === 2) fail(`to use ${file} as the prompt: whip ${quote(pos[0])} -v system=@${file}`);
    const parts = cmd === "tune" && file ? pos.slice(0, -1) : pos;
    fail(`too many arguments. If the target is a command with spaces, quote it: whip ${cmd === "run" ? "" : `${cmd} `}"${parts.join(" ")}"${cmd === "tune" && file ? ` ${file}` : ""}`);
  }
  const target = pos[0] ?? cfg.target;
  if (!target) fail(`no target. Examples: whip claude · whip ./my-harness.ts · whip "my-agent {prompt}"  (or set target in whip.config.ts)`);
  const problem = targetProblem(target!, [...COMMANDS, "compare", "suggest", "report", "clis", "help"]);
  if (problem) fail(problem);
  return target!;
}

async function main(argv: string[]) {
  const [first, ...rest] = argv;
  if (first === "-h" || first === "--help" || (!first && !existsSync("whip.config.ts"))) return console.log(HELP);
  if (first === "help") return console.log((COMMANDS as readonly string[]).includes(rest[0]) ? CMD_HELP[rest[0] as Command] : HELP);
  const moved = removedCommand(first, rest);
  if (moved) fail(moved);
  const cmd: Command = (COMMANDS as readonly string[]).includes(first) ? (first as Command) : "run";
  const typo = first && cmd === "run" && first !== "run" && !/[\s./]/.test(first) && !first.startsWith("-") && !Bun.which(first) && closest(first, [...COMMANDS, "help"]);
  if (typo) fail(`"${first}" is not a whip command or a program on your PATH. Did you mean: whip ${typo}${rest.length ? " " + rest.map(quote).join(" ") : ""}?`);
  const { pos, flags, variants } = parseArgs(cmd, cmd === "run" && first !== "run" ? argv : rest);
  if (flags.help) return console.log(CMD_HELP[cmd]);

  if (cmd === "diff") {
    if (pos.length > 2) fail(`whip diff takes at most two runs, e.g. whip diff latest~1 latest`);
    const a = loadRun(pos[0] ?? "latest~1"), b = loadRun(pos[1] ?? "latest");
    console.log(diff(a, b) + "\n\n" + suggest(b));
    if (flags.html) { await Bun.write(".whip/report.html", html([a, b])); console.log(dim(`wrote ${resolve(".whip/report.html")}`)); }
    return;
  }

  const cfg = (await loadConfig()) ?? {};
  if (cmd === "tune") return tuneCmd(pos, flags, variants, cfg);

  const target = pickTarget(pos, cfg, "run", 1);
  const { repeat, tasks } = suite(flags, cfg);
  const parsed = variants.map((v) => parseVariant(v));
  parsed.forEach((v) => v.warning && warn(v.warning));
  const sets = parsed.length ? variantSets(parsed) : cfg.variants?.length ? configSets(cfg) : [{ vars: {}, labels: {} }];
  const keys = [...new Set(sets.flatMap((s) => Object.keys(s.vars)))];
  if (keys.length && reach(target, keys[0]) === "never") {
    warn(`built-in targets don't receive variables, so ${keys.map((k) => `-v ${k}`).join(", ")} has no effect on ${target}.\n  ${passVarHint(target, keys[0], `whip %s -v ${keys[0]}=@prompts/a.md`)}`);
  }
  const { adapter, harness } = await makeHarness(target);
  console.error(dim(`whip: ${target} → ${adapter} adapter · ${tasks.length} tasks × ${repeat}${sets.length > 1 ? ` × ${sets.length} variants` : ""}`));

  const runs: Run[] = [];
  for (const s of sets) {
    let done = 0;
    const run = await runSuite({ harness, target, adapter, tasks, repeat, vars: s.vars, onTask: () => process.stderr.isTTY && process.stderr.write(`\r${dim(`  ${++done}/${tasks.length}`)}`) });
    run.variant = s.labels;
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    if (!flags["no-save"]) { mkdirSync(RUNS, { recursive: true }); await Bun.write(join(RUNS, `${run.id}.json`), JSON.stringify(run, null, 2)); }
    runs.push(run);
    console.log(scorecard(run) + "\n");
    if (runs.length === 1) unread(harness, keys).forEach((k) => warn(`${target} never read ctx.vars.${k}, so -v ${k} had no effect. Use it in your harness, e.g. myModel(ctx.vars.${k}, prompt)`));
  }
  for (const r of runs.slice(1)) console.log(diff(runs[0], r, Object.values(r.variant).join(",")) + "\n");
  console.log(suggest(runs.at(-1)!) + "\n");
  if (!flags["no-save"]) { await Bun.write(".whip/report.html", html(runs)); console.log(dim(`saved ${RUNS}/${runs.at(-1)!.id}.json · report .whip/report.html`)); }
}

/** How to get variable `key` into a built-in target; `usage` has %s where the new target goes. */
function passVarHint(target: string, key: string, usage: string): string {
  const exe = target.trim().split(/\s+/)[0];
  if (exe === "claude") return `Use a command that passes it: ${usage.replace("%s", `"claude -p {prompt} --append-system-prompt {${key}} --output-format stream-json --verbose --allowedTools Read,Edit,Write,Bash"`)}`;
  if (exe === "ollama") return `"ollama run" has no system-prompt flag. Use a 5-line harness that calls Ollama's API with system: ctx.vars.${key} (see examples/ollama.ts), then: ${usage.replace("%s", "./ollama.ts")}`;
  return `Wrap it in a command or script that reads $WHIP_${key.toUpperCase()} (or put {${key}} in the command), e.g. ${usage.replace("%s", `"${exe} ... {${key}} {prompt}"`)}`;
}

/** SDK harnesses record which ctx.vars they read; any of `keys` it never touched made no difference. */
const unread = (h: TrackedHarness, keys: string[]) => (h.readVars ? keys.filter((k) => !h.readVars!.has(k)) : []);

async function tuneCmd(pos: string[], flags: Record<string, string | true>, rawVariants: string[], cfg: Config) {
  // `whip tune prompts/a.md` with the target in whip.config.ts
  if (pos.length === 1 && cfg.target && existsSync(pos[0]) && statSync(pos[0]).isFile() && detect(pos[0]) === "cli") pos = [cfg.target, pos[0]];
  const key = String(flags.key ?? cfg.tune?.key ?? "system");
  checkKey(key, "--key");
  const named = pos[0] ?? cfg.target;
  if (named && pos.length <= 2 && reach(named, key) === "never") // before "is it installed?": tuning a built-in can't work at all
    fail(`built-in targets don't receive variables, so ${named} would never see the prompt being tuned and the score couldn't change.\n  ${passVarHint(named, key, `whip tune %s ${pos[1] ?? "prompts/a.md"}`)}`);
  const target = pickTarget(pos, cfg, "tune", 2);
  const file = pos[1];
  if (file && (!existsSync(file) || !statSync(file).isFile())) fail(`prompt file not found: ${file}${/\s/.test(file) ? `. If "${file}" is part of the target command, quote the whole command` : ""}`);
  const vs = rawVariants.map((v) => parseVariant(v));
  vs.forEach((v) => v.warning && warn(v.warning));
  const dup = vs.find((v, i) => vs.findIndex((x) => x.key === v.key) !== i);
  if (dup) fail(`-v ${dup.key} is given twice. whip tune edits one prompt; to compare prompts use: whip ${quote(target)} -v ${dup.key}=@a.md -v ${dup.key}=@b.md`);
  const start = vs.find((v) => v.key === key);
  if (file && start) fail(`the starting prompt is given twice (${file} and -v ${key}=...). Drop one: whip tune ${quote(target)} ${file}`);
  if (flags.write && !file) fail(`--write saves the result into a prompt file, but none was given. Usage: whip tune ${quote(target)} prompts/a.md --write`);

  const r0 = reach(target, key);
  if (r0 === "env") console.error(dim(`whip tune: ${target} gets the prompt as $WHIP_${key.toUpperCase()}; make sure it reads it (or put {${key}} in the command)`));

  const tunerSpec = (flags.tuner as string | undefined) ?? cfg.tune?.tuner;
  if (tunerSpec) {
    const exe = resolveTuner(tunerSpec).argv[0] ?? "";
    if (!Bun.which(exe) && !existsSync(exe)) {
      const g = closest(tunerSpec.split(":")[0], Object.keys(TUNER_CLIS));
      fail(`--tuner ${tunerSpec}: "${exe}" is not on your PATH.${g && g !== exe ? ` Did you mean --tuner ${g}?` : ""} Presets: ${Object.keys(TUNER_CLIS).join(", ")}, or any command (see whip tune --help)`);
    }
  }
  const budget = count(flags.budget ?? cfg.tune?.budget, "--budget", "--budget 3") ?? 5;
  if (flags.budget && !tunerSpec) warn("--budget limits --tuner calls; without --tuner it has no effect");
  const holdout = Number(cfg.tune?.holdout ?? 0.3), seed = Number(cfg.tune?.seed ?? 1);
  if (!(holdout >= 0 && holdout <= 0.9)) fail(`whip.config.ts tune.holdout must be between 0 and 0.9, got ${cfg.tune?.holdout}`);
  const { repeat, tasks } = suite(flags, cfg);

  const instructions = file ? readFileSync(file, "utf8") : start?.value ?? "";
  if (!instructions.trim()) console.error(dim(`whip tune: starting from an empty prompt. To start from yours: whip tune ${quote(target)} prompts/a.md`));
  const vars = Object.fromEntries(vs.filter((v) => v.key !== key).map((v) => [v.key, v.value]));
  const { adapter, harness } = await makeHarness(target);
  console.error(dim(`whip tune: ${target} → ${adapter} adapter · ${tasks.length} tasks × ${repeat} · edits ${key}${file ? ` (from ${file})` : ""} · ${tunerSpec ? `tuner: ${tunerSpec}` : "built-in hints (no model)"}`));
  const r = await tune({
    harness, target, adapter, tasks, repeat, key, instructions, vars,
    proposer: tunerSpec ? tunerProposer(tunerSpec, cfg.tune?.timeout) : libraryProposer(),
    budget, holdout, seed,
    log: (l) => console.log(l),
    afterBaseline: () => {
      if (unread(harness, [key]).length) fail(`${target} never read ctx.vars.${key}, so editing it can't change the score. Pass it to your model, e.g.\n  export default async (prompt, ctx) => myModel(ctx.vars.${key}, prompt)`);
    },
    confirm: async (estimate) => {
      console.error(`whip tune will make ${estimate}.`);
      const g = await confirmGate({ yes: !!flags.yes, tty: !!process.stdin.isTTY, question: "Continue? [y/N] ", ask: (q) => prompt(q) });
      if (g === "need-yes") fail("--tuner calls an external CLI and needs confirmation, but there is no terminal to ask in. Add --yes to go ahead.");
      return g === "go";
    },
  });
  if (r.aborted) { console.error("whip tune: aborted, nothing was called"); process.exit(1); }
  const files = await writeTune(r, ".whip", !flags["no-save"]);
  console.log(tuneSummary(r));
  if (flags.write && file) { await Bun.write(file, r.instructions.after.trim() + "\n"); console.log(`  updated ${file}`); }
  console.log(dim(`  wrote ${files.join(" · ")}`));
  if (!flags.write) console.log(dim(`  compare: whip ${quote(target)}${file ? ` -v ${key}=@${file}` : ""} -v ${key}=@.whip/tuned.md${file ? `   keep it: add --write, or copy .whip/tuned.md to ${file}` : ""}`));
}

if (import.meta.main) main(process.argv.slice(2)).catch((e) => {
  console.error(`whip: ${(e as Error).message}`);
  process.exit(1);
});
