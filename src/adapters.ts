import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closest } from "./args";
import type { Harness, HarnessContext, HarnessResult, SdkFn, ToolCall } from "./types";

/** Known CLIs and their non-interactive invocation. `{prompt}` is replaced by the prompt (as one argv item). */
export const KNOWN_CLIS: Record<string, string[]> = {
  claude: ["claude", "-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--allowedTools", "Read,Edit,Write,Bash"],
  codex: ["codex", "exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "{prompt}"],
  opencode: ["opencode", "run", "--format", "json", "{prompt}"],
  copilot: ["copilot", "-p", "{prompt}", "--allow-all-tools", "--output-format", "json"],
  gemini: ["gemini", "-p", "{prompt}", "--output-format", "json", "--yolo"],
  aider: ["aider", "--message", "{prompt}", "--yes-always", "--no-git"],
  goose: ["goose", "run", "-t", "{prompt}"],
  ollama: ["ollama", "run", "{model}", "{prompt}"],
};

/** Copilot as an editor: plain text out, no tools, no MCP servers, never waits for input. */
export const COPILOT_SAFE = ["--silent", "--no-color", "--no-ask-user", "--disable-builtin-mcps", "--deny-tool=shell", "--deny-tool=write"];

/** Known CLIs as `whip tune --tuner` editors: text in, text out, tools off where the CLI allows it. */
export const TUNER_CLIS: Record<string, string[]> = {
  claude: ["claude", "-p", "{prompt}", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"],
  copilot: ["copilot", "-p", "{prompt}", ...COPILOT_SAFE],
  codex: ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "{prompt}"],
  gemini: ["gemini", "-p", "{prompt}"],
  opencode: ["opencode", "run", "{prompt}"],
  ollama: ["ollama", "run", "{model}", "{prompt}"],
};

/** `claude` | `copilot:<model>` | `ollama:qwen2.5:14b` | any command (`{prompt}` or stdin). Copilot always gets COPILOT_SAFE. */
export function resolveTuner(spec: string): { argv: string[]; stdin: boolean } {
  const m = spec.trim().match(/^([\w-]+)(?::(\S+))?$/);
  if (m && TUNER_CLIS[m[1]]) {
    const base = TUNER_CLIS[m[1]], model = m[2];
    if (base.includes("{model}")) return { argv: base.map((a) => (a === "{model}" ? model ?? "qwen2.5:14b" : a)), stdin: false };
    return { argv: model ? [...base, "--model", model] : base, stdin: false };
  }
  const r = resolveCommand(spec);
  if (r.argv[0]?.split("/").pop() === "copilot") r.argv = [...r.argv.filter((a) => a !== "--allow-all-tools"), ...COPILOT_SAFE.filter((f) => !r.argv.includes(f))];
  return r;
}

const isFile =(t: string) => /\.(m?[jt]sx?)$/.test(t);
export const detect = (target: string): "sdk" | "cli" => (isFile(target) && !/\s/.test(target.trim()) ? "sdk" : "cli");

/**
 * Optional helper for type hints; a plain default-exported function works too.
 * Name your variables to get them typed: `defineHarness<"system" | "tools">((prompt, ctx) => ...)`.
 */
export const defineHarness = <K extends string = string>(fn: (prompt: string, ctx: HarnessContext<K>) => HarnessResult | Promise<HarnessResult>) => fn;

/** Pull TOOL lines (`TOOL name {json}`) out of plain text: the text tool protocol any CLI/model can speak. */
export function parseToolLines(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of text.matchAll(/^\s*TOOL\s+([\w.-]+)\s*(\{.*\})?\s*$/gm)) {
    let args: unknown = {};
    try { args = m[2] ? JSON.parse(m[2]) : {}; } catch { args = m[2]; }
    calls.push({ name: m[1], args });
  }
  return calls;
}

/** If stdout is JSONL (claude/codex/opencode/copilot json modes), extract tool calls + final text generically. */
export function parseJsonl(out: string): { text: string; toolCalls: ToolCall[] } | null {
  const lines = out.split("\n").filter((l) => l.trim());
  const objs: unknown[] = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (!o || typeof o !== "object" || Array.isArray(o)) return null; objs.push(o); } catch { return null; } }
  if (!objs.some((o: any) => "type" in o)) return null; // a plain JSON answer, not an event stream
  if (!objs.length) return null;
  const toolCalls: ToolCall[] = [];
  let text = "";
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if ((o.type === "tool_use" || o.type === "tool_call" || o.type === "function_call") && o.name) toolCalls.push({ name: o.name, args: o.input ?? o.arguments ?? o.args });
    else if (o.type === "command_execution" && o.command) toolCalls.push({ name: "shell", args: { command: o.command } });
    if (typeof o.result === "string") text = o.result;
    else if (o.type === "text" && typeof o.text === "string") text = o.text;
    else if (o.type === "agent_message" && typeof o.text === "string") text = o.text;
    for (const v of Object.values(o)) walk(v);
  };
  objs.forEach(walk);
  return { text, toolCalls };
}

/** A harness that also records which `ctx.vars` keys it read (SDK only), so whip can warn about variables with no effect. */
export type TrackedHarness = Harness & { readVars?: Set<string> };

/** SDK adapter: wrap `(prompt, ctx) => string | {text, toolCalls}`. */
export async function sdkAdapter(path: string): Promise<TrackedHarness> {
  const mod = await import(resolve(path));
  const fn: SdkFn = mod.default ?? mod.harness;
  if (typeof fn !== "function") throw new Error(`${path} must default-export a function. Example:\n  export default async (prompt, ctx) => myModel(ctx.vars.system, prompt)`);
  const readVars = new Set<string>();
  const h: TrackedHarness = async (input) => {
    const t0 = performance.now();
    const vars = new Proxy(input.vars, {
      get: (t, k) => { if (typeof k === "string") readVars.add(k); return Reflect.get(t, k); },
      has: (t, k) => { if (typeof k === "string") readVars.add(k); return Reflect.has(t, k); },
      ownKeys: (t) => { Object.keys(t).forEach((k) => readVars.add(k)); return Reflect.ownKeys(t); },
    });
    const r = await fn(input.prompt, { ...input, vars });
    const out = typeof r === "string" ? { text: r } : r;
    const text = out.text ?? "";
    return { text, toolCalls: out.toolCalls ?? parseToolLines(text), ms: performance.now() - t0 };
  };
  h.readVars = readVars;
  return h;
}

/** Turn `whip claude` / `whip "my-agent --flag"` / `whip "agent {prompt}"` into argv. */
export function resolveCommand(target: string, vars: Record<string, string> = {}): { argv: string[]; stdin: boolean } {
  const parts = target.match(/"[^"]*"|'[^']*'|\S+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? [];
  const known = KNOWN_CLIS[parts[0]];
  if (known && parts.length === 1) return { argv: known, stdin: false };
  if (known && parts[0] === "ollama" && parts.length <= 3) { // "ollama <model>" and "ollama run <model>"
    const model = parts[1] === "run" ? parts[2] : parts[1];
    return { argv: known.map((a) => (a === "{model}" ? model ?? vars.model ?? "qwen2.5:0.5b" : a)), stdin: false };
  }
  const abs = parts.map((p, i) => (i > 0 && !p.startsWith("-") && existsSync(p) ? resolve(p) : p)); // tasks run in a temp dir
  return { argv: abs, stdin: !parts.some((p) => p.includes("{prompt}")) };
}

/** CLI adapter: spawn per task in its sandbox cwd; prompt via {prompt} or stdin. Variants arrive as WHIP_<NAME> env vars and {name} placeholders. */
export function cliAdapter(target: string, timeoutMs = 120_000): Harness {
  return async (input) => {
    const { argv, stdin } = resolveCommand(target, input.vars);
    const fill = (a: string) => a.replace(/\{(\w+)\}/g, (m, k) => (k === "prompt" ? input.prompt : input.vars[k] ?? m));
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    for (const [k, v] of Object.entries(input.vars)) env[`WHIP_${k.toUpperCase()}`] = v;
    const t0 = performance.now();
    const p = Bun.spawn(argv.map(fill), { cwd: input.cwd, env, stdin: stdin ? new Blob([input.prompt]) : "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const exitCode = await p.exited;
    clearTimeout(timer);
    const j = parseJsonl(out);
    const text = j ? j.text : out.trim() || err.trim();
    return { text, toolCalls: [...(j?.toolCalls ?? []), ...parseToolLines(text)], exitCode, ms: performance.now() - t0 };
  };
}

/** Built-in targets run a fixed command, so `-v` variables never reach the agent. */
export const isBuiltin = (target: string) => {
  const parts = resolveCommand(target).argv;
  return detect(target) === "cli" && Object.values(KNOWN_CLIS).some((k) => k.length === parts.length && k.every((a, i) => a === parts[i] || a === "{model}"));
};

/** How variable `key` reaches the target: always (SDK, {key} placeholder), never (built-in), or only if the command reads $WHIP_KEY. */
export function reach(target: string, key: string): "sdk" | "placeholder" | "never" | "env" {
  if (detect(target) === "sdk") return "sdk";
  if (isBuiltin(target)) return "never";
  return target.includes(`{${key}}`) ? "placeholder" : "env";
}

/** Why `target` can't run, phrased as what to do instead; undefined when it looks fine. `commands` are whip's own, for typo hints. */
export function targetProblem(target: string, commands: string[] = []): string | undefined {
  const t = target.trim();
  if (detect(t) === "sdk") {
    if (existsSync(t)) return undefined;
    return `harness file not found: ${t}. An SDK target is a .ts/.js file that default-exports (prompt, ctx) => answer`;
  }
  const exe = resolveCommand(t).argv[0] ?? "";
  if (!exe) return "empty target. Examples: whip claude · whip ./my-harness.ts · whip \"my-agent {prompt}\"";
  if (Bun.which(exe) || (exe.includes("/") && existsSync(exe))) return undefined;
  const single = !/\s/.test(t);
  const cmd = single ? closest(t, commands) : undefined;
  if (cmd) return `"${t}" is not a whip command or a program on your PATH. Did you mean: whip ${cmd}?`;
  const cli = closest(exe, Object.keys(KNOWN_CLIS));
  if (cli && cli !== exe) return `"${exe}" is not on your PATH. Did you mean the built-in target ${cli}?`;
  for (const ext of [".ts", ".js"]) if (existsSync(t + ext)) return `"${t}" is not a program. Did you mean the harness file ${t}${ext}?`;
  if (KNOWN_CLIS[exe]) return `"${exe}" is a built-in target but isn't installed (not on your PATH). Install it, or pick another target: whip run --help`;
  return `"${exe}" is not a program on your PATH${single ? " or a whip command" : ""}. Targets: a built-in CLI (whip run --help lists them), ./my-harness.ts, or a quoted command like "my-agent {prompt}"`;
}

export async function makeHarness(target: string) {
  const adapter = detect(target);
  return { adapter, harness: adapter === "sdk" ? await sdkAdapter(target) : cliAdapter(target) };
}
