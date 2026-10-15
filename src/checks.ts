import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, HarnessOutput, ToolCall } from "./types";

export type CheckCtx = { out: HarnessOutput; toolCalls: ToolCall[]; cwd: string };

const sub = (want: unknown, got: unknown): boolean => {
  if (typeof want === "string" && want.startsWith("/") && want.lastIndexOf("/") > 0) {
    const i = want.lastIndexOf("/");
    return new RegExp(want.slice(1, i), want.slice(i + 1)).test(String(got ?? ""));
  }
  if (want && typeof want === "object") return Object.entries(want).every(([k, v]) => sub(v, (got as any)?.[k]));
  return String(want) === String(got);
};

/** Strip ``` fences so `{"a":1}` inside a code block still parses as JSON. */
export const extractJson = (t: string) => {
  const s = t.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return { ok: true, v: JSON.parse(s), wrapped: s !== t.trim() }; } catch { return { ok: false, v: undefined, wrapped: false }; }
};

/** Returns null on pass, or a short reason on fail. */
export function runCheck(c: Check, { out, toolCalls, cwd }: CheckCtx): string | null {
  const text = out.text ?? "";
  if ("file" in c) {
    const p = join(cwd, c.file), ex = existsSync(p);
    if ((c.exists ?? true) !== ex) return `file: ${c.file} ${ex ? "exists" : "missing"}`;
    if (c.contains && !readFileSync(p, "utf8").includes(c.contains)) return `file: ${c.file} lacks "${c.contains}"`;
    return null;
  }
  if ("contains" in c) return text.toLowerCase().includes(c.contains.toLowerCase()) ? null : `missing "${c.contains}"`;
  if ("notContains" in c) return text.toLowerCase().includes(c.notContains.toLowerCase()) ? `contains "${c.notContains}"` : null;
  if ("regex" in c) return new RegExp(c.regex, c.flags ?? "m").test(text) ? null : `no match /${c.regex}/`;
  if ("notRegex" in c) return new RegExp(c.notRegex, c.flags ?? "m").test(text) ? `matched /${c.notRegex}/` : null;
  if ("json" in c) {
    const j = extractJson(text);
    if (!j.ok || typeof j.v !== "object" || j.v === null) return "format: not valid JSON";
    if (c.json.exact && j.wrapped) return "format: JSON wrapped in fences/prose";
    for (const k of c.json.required ?? []) if (!(k in j.v)) return `format: missing key "${k}"`;
    for (const [k, t] of Object.entries(c.json.types ?? {})) if (typeof j.v[k] !== t) return `format: "${k}" not ${t}`;
    return null;
  }
  if ("tool" in c) {
    const named = toolCalls.filter((t) => t.name === c.tool);
    if (!named.length) return `tool: expected ${c.tool}, got ${toolCalls.map((t) => t.name).join(",") || "none"}`;
    if (named.length < (c.minCalls ?? 1)) return `tool: ${c.tool} called ${named.length}x, need ${c.minCalls}`;
    if (c.args && !named.some((t) => sub(c.args, t.args))) return `args: ${c.tool} ${JSON.stringify(named.at(-1)!.args)}`;
    return null;
  }
  if ("noTool" in c) return toolCalls.length ? `tool: unnecessary ${toolCalls[0].name}` : null;
  if ("exitCode" in c) return (out.exitCode ?? 0) === c.exitCode ? null : `exit ${out.exitCode}`;
  if ("maxWords" in c) { const n = text.split(/\s+/).filter(Boolean).length; return n <= c.maxWords ? null : `verbose: ${n} words > ${c.maxWords}`; }
  if ("lines" in c) {
    const ls = text.trim().split("\n");
    if (c.count && ls.length !== c.count) return `format: ${ls.length} lines, want ${c.count}`;
    const bad = ls.find((l) => !new RegExp(c.lines).test(l));
    return bad === undefined ? null : `format: bad line "${bad.slice(0, 40)}"`;
  }
  if ("judge" in c) return process.env.WHIP_JUDGE ? "judge: not implemented offline" : null; // off by default: never calls a model
  return "unknown check";
}
