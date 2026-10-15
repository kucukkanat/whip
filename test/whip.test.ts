import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliAdapter, detect, parseJsonl, parseToolLines, resolveCommand, sdkAdapter } from "../src/adapters";
import { runCheck } from "../src/checks";
import { loadTasks, runSuite, runTask } from "../src/engine";
import { diff, hintFor, suggest } from "../src/report";
import type { Harness, Task } from "../src/types";

const ctx = (text: string, toolCalls: any[] = [], cwd = tmpdir()) => ({ out: { text, ms: 0 }, toolCalls, cwd });

test("detect: files are SDK, everything else CLI", () => {
  expect(detect("./h.ts")).toBe("sdk");
  expect(detect("claude")).toBe("cli");
  expect(detect("bun examples/mock-cli.ts")).toBe("cli");
});

test("resolveCommand: known CLIs, placeholder, stdin fallback", () => {
  expect(resolveCommand("codex").argv.slice(0, 2)).toEqual(["codex", "exec"]);
  expect(resolveCommand("ollama qwen2.5:0.5b").argv).toEqual(["ollama", "run", "qwen2.5:0.5b", "{prompt}"]);
  expect(resolveCommand("my-agent --x {prompt}").stdin).toBe(false);
  expect(resolveCommand("my-agent --x").stdin).toBe(true);
});

test("parse tool calls from TOOL lines and JSONL events", () => {
  expect(parseToolLines('ok\nTOOL calc {"expr":"1+1"}')).toEqual([{ name: "calc", args: { expr: "1+1" } }]);
  const j = parseJsonl('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"f":1}}]}}\n{"type":"result","result":"done"}');
  expect(j).toEqual({ text: "done", toolCalls: [{ name: "Edit", args: { f: 1 } }] });
  expect(parseJsonl("4")).toBeNull();
  expect(parseJsonl('{"item":"x","qty":3}')).toBeNull();
});

test("checks", () => {
  expect(runCheck({ contains: "ok" }, ctx("OK!"))).toBeNull();
  expect(runCheck({ regex: "^OK$", flags: "" }, ctx("OK."))).toMatch(/no match/);
  expect(runCheck({ json: { required: ["a"], types: { a: "number" } } }, ctx('{"a":"1"}'))).toMatch(/not number/);
  expect(runCheck({ json: { exact: true } }, ctx('```json\n{"a":1}\n```'))).toMatch(/wrapped/);
  expect(runCheck({ tool: "f", args: { d: "/^\\d{4}-/" } }, ctx("", [{ name: "f", args: { d: "2027-01-01" } }]))).toBeNull();
  expect(runCheck({ tool: "f", minCalls: 2 }, ctx("", [{ name: "f", args: {} }]))).toMatch(/1x/);
  expect(runCheck({ noTool: true }, ctx("", [{ name: "f", args: {} }]))).toMatch(/unnecessary/);
  expect(runCheck({ maxWords: 2 }, ctx("one two three"))).toMatch(/verbose/);
  expect(runCheck({ lines: "^- \\w+$", count: 2 }, ctx("- a\n- b"))).toBeNull();
  const d = mkdtempSync(join(tmpdir(), "whip-t-")); writeFileSync(join(d, "a.txt"), "hej");
  expect(runCheck({ file: "a.txt", contains: "hej" }, ctx("", [], d))).toBeNull();
  expect(runCheck({ file: "b.txt" }, ctx("", [], d))).toMatch(/missing/);
});

test("engine: tool loop simulates failures then success", async () => {
  const task: Task = { id: "t", category: "recovery", prompt: "status?", tools: [{ name: "get", description: "", sim: { result: "shipped", failFirst: 1 } }], checks: [{ tool: "get", minCalls: 2 }, { contains: "shipped" }] };
  const h: Harness = async ({ prompt }) => ({ text: /shipped/.test(prompt) ? "shipped" : 'TOOL get {"id":1}', toolCalls: /shipped/.test(prompt) ? [] : [{ name: "get", args: { id: 1 } }], ms: 1 });
  expect((await runTask(h, task, {})).pass).toBe(true);
});

test("default suite loads 12-20 deterministic tasks", () => {
  const t = loadTasks("nope");
  expect(t.length).toBeGreaterThanOrEqual(12);
  expect(t.length).toBeLessThanOrEqual(20);
  expect(new Set(t.map((x) => x.category)).size).toBeGreaterThanOrEqual(7);
});

test("SDK + CLI adapters: tuned prompt beats baseline on the mock tiny model", async () => {
  const tasks = loadTasks("nope");
  const sdk = await sdkAdapter("examples/mock-tiny.ts");
  const base = await runSuite({ harness: sdk, target: "m", adapter: "sdk", tasks, repeat: 2, vars: { system: "be helpful" } });
  const tuned = await runSuite({ harness: sdk, target: "m", adapter: "sdk", tasks, repeat: 2, vars: { system: await Bun.file("examples/prompts/tuned.md").text() } });
  expect(tuned.score).toBe(1);
  expect(base.score).toBeLessThan(0.5);
  expect(diff(base, tuned)).toContain("flipped");
  expect(suggest(base)).toContain("never invent");
  const cli = cliAdapter("bun examples/mock-cli.ts");
  const r = await runSuite({ harness: cli, target: "c", adapter: "cli", tasks: tasks.filter((t) => t.category === "multi-step"), repeat: 1, vars: {} });
  expect(r.score).toBe(1);
});

test("hints are category aware", () => {
  expect(hintFor("honesty", 'missing "UNKNOWN"')).toMatch(/never invent/);
  expect(hintFor("format", "format: JSON wrapped in fences/prose")).toMatch(/example/);
});
