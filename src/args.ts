import { existsSync, readFileSync, statSync } from "node:fs";

/** A mistake in how whip was called. The message says what to type instead. */
export class UsageError extends Error {}
export const fail = (msg: string): never => { throw new UsageError(msg); };

/** Edit distance where swapping two neighbours counts as one typo, for "did you mean". */
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** The option closest to `word`, if it is close enough to be a typo. */
export function closest(word: string, options: string[]): string | undefined {
  let best: string | undefined, bd = Infinity;
  for (const o of options) { const x = distance(word.toLowerCase(), o.toLowerCase()); if (x < bd) { best = o; bd = x; } }
  return bd <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

export const COMMANDS = ["run", "diff", "tune"] as const;
export type Command = (typeof COMMANDS)[number];

type Flag = { short?: string; value?: string; example?: string };
const SUITE: Record<string, Flag> = {
  repeat: { short: "n", value: "N", example: "-n 5" },
  only: { value: "regex|category", example: "--only format" },
  evals: { value: "dir", example: "--evals ./evals" },
  variant: { short: "v", value: "key=value", example: "-v system=@prompts/a.md" },
  "no-save": {},
  help: { short: "h" },
};
export const FLAGS: Record<Command, Record<string, Flag>> = {
  run: SUITE,
  tune: { ...SUITE, tuner: { value: "cmd", example: "--tuner claude" }, key: { value: "name", example: "--key system" }, budget: { value: "N", example: "--budget 3" }, write: {}, yes: { short: "y" } },
  diff: { html: {}, help: { short: "h" } },
};

/** Flags that no longer exist, and what to use instead. */
const MOVED: Record<string, string> = {
  "target-file": "pass the prompt file after the target instead: whip tune <target> prompts/a.md (add --key <name> to edit a variable other than system)",
  holdout: "set it in whip.config.ts instead: export default { tune: { holdout: 0.3 } }",
  seed: "set it in whip.config.ts instead: export default { tune: { seed: 1 } }",
  timeout: "set it in whip.config.ts instead: export default { tune: { timeout: 300000 } }",
};

export type Parsed = { pos: string[]; flags: Record<string, string | true>; variants: string[] };

function unknownFlag(cmd: Command, raw: string, name: string): never {
  if (MOVED[name]) fail(`--${name} was removed; ${MOVED[name]}`);
  const owner = COMMANDS.find((c) => c !== cmd && FLAGS[c][name]);
  if (owner) fail(`${raw} only works with whip ${owner}, e.g. whip ${owner} ${owner === "diff" ? "latest~1 latest" : "<target>"} ${raw}`);
  const names = (c: Command) => [...Object.keys(FLAGS[c]).map((k) => `--${k}`), ...Object.values(FLAGS[c]).filter((f) => f.short).map((f) => `-${f.short}`)];
  const bare = raw.replace(/=.*/s, "");
  const guess = closest(bare, names(cmd)) ?? closest(bare, COMMANDS.flatMap(names));
  const elsewhere = guess && !names(cmd).includes(guess) ? COMMANDS.find((c) => names(c).includes(guess)) : undefined;
  if (elsewhere) fail(`unknown flag ${bare}. Did you mean ${guess}? It only works with whip ${elsewhere}`);
  throw new UsageError(`unknown flag ${bare} for whip ${cmd}.${guess ? ` Did you mean ${guess}?` : ""} See: whip ${cmd} --help`);
}

/** Parse argv for one command. Accepts `--flag value`, `--flag=value` and `-n 5`; rejects unknown flags with a suggestion. */
export function parseArgs(cmd: Command, argv: string[]): Parsed {
  const spec = FLAGS[cmd];
  const shorts = Object.fromEntries(Object.entries(spec).filter(([, f]) => f.short).map(([k, f]) => [f.short!, k]));
  const out: Parsed = { pos: [], flags: {}, variants: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-" || /^-\d/.test(a)) { out.pos.push(a); continue; }
    const long = a.startsWith("--");
    const eq = a.indexOf("=");
    const name = long ? a.slice(2, eq > 0 ? eq : undefined) : shorts[a.slice(1)];
    const inline = long && eq > 0 ? a.slice(eq + 1) : undefined;
    const f = name ? spec[name] : undefined;
    if (!name || !f) unknownFlag(cmd, a, name ?? a);
    if (!f.value) {
      if (inline !== undefined) fail(`--${name} takes no value; write just --${name}`);
      out.flags[name] = true;
      continue;
    }
    const v = inline ?? argv[i + 1];
    if (v === undefined || (inline === undefined && /^--?[a-z]/i.test(v))) fail(`${a} needs a value (${f.value}), e.g. ${f.example}`);
    if (inline === undefined) i++;
    if (name === "variant") out.variants.push(v);
    else out.flags[name] = v;
  }
  return out;
}

/** A whole number ≥ 1 from a flag or config value. */
export function count(v: unknown, what: string, example: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`${what} must be a whole number of 1 or more, got "${v}". Example: ${example}`);
  return n;
}

/** Variable names become `ctx.vars.<key>`, `$WHIP_<KEY>` and `{key}`, so they must be identifiers. */
export function checkKey(key: string, where: string) {
  if (!/^[A-Za-z_]\w*$/.test(key)) fail(`${where}: "${key}" is not a valid variable name. Use letters, digits and _, e.g. system (it becomes ctx.vars.system, $WHIP_SYSTEM and {system})`);
  if (key === "prompt") fail(`${where}: "prompt" is reserved ({prompt} is where the task prompt goes). Use another name, e.g. system`);
}

export type Variant = { key: string; value: string; label: string; warning?: string };

/** `key=text`, or `key=@path` to read a file. A bare path that exists is a mistake, not text. */
export function parseVariant(s: string, where = "-v"): Variant {
  const i = s.indexOf("=");
  if (i <= 0) fail(`${where} ${s}: expected key=value, e.g. -v system=@prompts/a.md (@ reads a file) or -v system="Be brief."`);
  const key = s.slice(0, i), raw = s.slice(i + 1);
  checkKey(key, `${where} ${s}`);
  if (raw.startsWith("@")) {
    const file = raw.slice(1);
    if (!existsSync(file) || !statSync(file).isFile()) fail(`${where} ${s}: file not found: ${file}`);
    return { key, value: readFileSync(file, "utf8"), label: file };
  }
  if (raw && existsSync(raw) && statSync(raw).isFile()) fail(`${where} ${s}: "${raw}" is a file. To use its contents write ${key}=@${raw}`);
  const warning = /,\s*[A-Za-z_]\w*=/.test(raw) ? `${where} ${s}: one variable per -v. If you meant two, write -v ${raw.split(",").map((x, j) => (j ? x.trim() : `${key}=${x}`)).join(" -v ")}` : undefined;
  return { key, value: raw, label: raw, ...(warning ? { warning } : {}) };
}

export type Config = {
  target?: string; repeat?: number; evals?: string; only?: string;
  variants?: Record<string, string>[];
  tune?: { tuner?: string; key?: string; budget?: number; holdout?: number; seed?: number; timeout?: number };
};
const CONFIG_KEYS = ["target", "repeat", "evals", "only", "variants", "tune"];
const TUNE_KEYS = ["tuner", "key", "budget", "holdout", "seed", "timeout"];

/** Validate whip.config.ts: unknown keys get a suggestion instead of being ignored. */
export function checkConfig(c: unknown, file = "whip.config.ts"): Config {
  if (!c || typeof c !== "object") fail(`${file} must default-export an object, e.g. export default { target: "./my-harness.ts" }`);
  const o = c as Record<string, unknown>;
  const unknown = (k: string, keys: string[], at: string) => { const g = closest(k, keys); fail(`${file}: unknown key "${at}${k}".${g ? ` Did you mean "${at}${g}"?` : ""} Known: ${keys.join(", ")}`); };
  for (const k of Object.keys(o)) if (!CONFIG_KEYS.includes(k)) unknown(k, CONFIG_KEYS, "");
  if (o.variants !== undefined && (!Array.isArray(o.variants) || o.variants.some((v) => !v || typeof v !== "object")))
    fail(`${file}: variants must be a list of objects, e.g. variants: [{ system: "@prompts/a.md" }, { system: "@prompts/b.md" }]`);
  if (o.tune !== undefined) {
    if (!o.tune || typeof o.tune !== "object") fail(`${file}: tune must be an object, e.g. tune: { budget: 3 }`);
    for (const k of Object.keys(o.tune as object)) if (!TUNE_KEYS.includes(k)) unknown(k, TUNE_KEYS, "tune.");
  }
  return o as Config;
}

/** Commands that were folded into others: the exact command to type now. */
export function removedCommand(cmd: string, rest: string[]): string | undefined {
  const args = rest.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  switch (cmd) {
    case "compare": return `"whip compare" is now "whip run": give one -v per value and it prints the comparison.\n  whip run ${args.replace(/(--variant|-v)\s+(\w+)=(?!@)(\S+\.(md|txt))/g, "-v $2=@$3") || "<target> -v system=@a.md -v system=@b.md"}`;
    case "suggest": {
      const n = rest[0]?.match(/^latest(?:~(\d+))?$/);
      const ref = rest[0] ?? "latest";
      const prev = n ? `latest~${Number(n[1] ?? 0) + 1}` : "<older-run>";
      return `"whip suggest" was removed: hints now print after every "whip run", and after "whip diff" for the newer run.\n  whip diff ${prev} ${ref}`;
    }
    case "report": return `"whip report" was removed: "whip run" writes .whip/report.html every time. To build one from two saved runs:\n  whip diff ${rest.length >= 2 ? rest.slice(0, 2).join(" ") : "latest~1 latest"} --html`;
    case "clis": return `"whip clis" was removed. Built-in targets and their commands: whip run --help · tuner presets: whip tune --help`;
  }
  return undefined;
}
