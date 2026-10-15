import { expect, test } from "bun:test";
import { COPILOT_SAFE, resolveTuner, sdkAdapter } from "../src/adapters";
import { loadTasks, runSuite } from "../src/engine";
import { html } from "../src/report";
import { applyEdit, buildTunerPrompt, confirmGate, libraryProposer, noiseOf, parseEdits, splitTasks, tune, tunerProposer, verdict, type Proposer } from "../src/tune";
import type { Harness, Task } from "../src/types";

// A deterministic toy harness: task `x` passes when the system prompt contains every word in `needs[x]` and none in `breaks[x]`.
const toy = (needs: Record<string, string[]>, breaks: Record<string, string[]> = {}): Harness => async ({ prompt, vars }) => {
  const id = prompt.match(/^task (\w+)/)![1], sys = vars.system ?? "";
  const ok = (needs[id] ?? []).every((w) => sys.includes(w)) && !(breaks[id] ?? []).some((w) => sys.includes(w));
  return { text: ok ? "PASS" : "nope", ms: 0 };
};
const T = (id: string, category: string): Task => ({ id, category, prompt: `task ${id}`, checks: [{ contains: "PASS" }] });
const fixed = (...edits: string[][]): Proposer => { let i = 0; return { kind: "tuner", label: "tuner", propose: async () => (edits[i++] ?? []).map((line) => ({ op: "add" as const, line, source: "tuner" })) }; };
const base = { target: "toy", adapter: "sdk" as const, repeat: 1, key: "system", instructions: "" };

test("parseEdits: fences, prose, single object, arrays, trailing junk, aliases", () => {
  const want = [{ op: "add", line: "Retry on ERROR.", reason: "r" }];
  expect(parseEdits('Sure!\n```json\n{"edits":[{"op":"add","line":"Retry on ERROR.","reason":"r"}]}\n```\nHope it helps')).toEqual(want);
  expect(parseEdits('Here you go: {"edits":[{"op":"add","line":"Retry on ERROR.","reason":"r"}]} }}} trailing junk {')).toEqual(want);
  expect(parseEdits('{"op":"add","line":"Retry on ERROR.","reason":"r"}')).toEqual(want);
  expect(parseEdits('[{"op":"add","line":"Retry on ERROR.","reason":"r",},]')).toEqual(want); // trailing commas
  expect(parseEdits('{"edits":[{"op":"Replace","target":"Use tools.","line":"Only call a tool when needed."},{"action":"delete","line":"Be nice."},{"line":"Bare line\\nwrapped"}]}')).toEqual([
    { op: "replace", line: "Only call a tool when needed.", target: "Use tools." }, { op: "remove", line: "Be nice." }, { op: "add", line: "Bare line wrapped" }]);
  expect(parseEdits('{"edits":[{"op":"add","line":"has a } brace"}]}')).toEqual([{ op: "add", line: "has a } brace" }]);
  expect(parseEdits("\x1b[32m{\"edits\":[{\"op\":\"add\",\"line\":\"x y\"}]}\x1b[0m")).toEqual([{ op: "add", line: "x y" }]);
  expect(parseEdits("I don't know.")).toEqual([]);
  expect(parseEdits('{"edits":[{"op":"explode","line":"x"}]}')).toEqual([]);
  expect(parseEdits('{"edits": [{"op":"add","line":"a')).toEqual([]); // truncated
});

test("applyEdit: add, replace (exact and fuzzy target), remove, no-ops", () => {
  const l = ["You are helpful.", "Use tools when useful."];
  expect(applyEdit(l, { op: "add", line: "Retry once." })).toEqual([...l, "Retry once."]);
  expect(applyEdit(l, { op: "add", line: "you are  HELPFUL." })).toBeNull();
  expect(applyEdit(l, { op: "replace", target: "use tools when useful", line: "Only call a tool when needed." })).toEqual(["You are helpful.", "Only call a tool when needed."]);
  expect(applyEdit(l, { op: "replace", target: "not there at all", line: "X." })).toEqual([...l, "X."]);
  expect(applyEdit(l, { op: "remove", line: "You are helpful." })).toEqual(["Use tools when useful."]);
  expect(applyEdit(l, { op: "remove", line: "Missing line" })).toBeNull();
});

test("splitTasks: seeded, deterministic, stratified, never empties a category", () => {
  const tasks = loadTasks("nope");
  const a = splitTasks(tasks, 0.3, 1), b = splitTasks(tasks, 0.3, 1);
  expect(a.heldout.map((t) => t.id)).toEqual(b.heldout.map((t) => t.id));
  expect(a.heldout.length).toBe(Math.round(tasks.length * 0.3));
  expect(a.train.length + a.heldout.length).toBe(tasks.length);
  for (const c of new Set(tasks.map((t) => t.category))) expect(a.train.some((t) => t.category === c)).toBe(true);
  const seeds = new Set([1, 2, 3, 4, 5].map((s) => splitTasks(tasks, 0.3, s).heldout.map((t) => t.id).join()));
  expect(seeds.size).toBeGreaterThan(1);
  expect(splitTasks(tasks, 0, 1).heldout).toEqual([]);
});

test("verdict: accept on gain; reject category drop >10, held-out drop, no gain", () => {
  const cur = { train: 0.5, heldout: 0.5, cats: { honesty: 1, format: 0.2 } };
  expect(verdict(cur, { train: 0.6, heldout: 0.5, cats: { honesty: 1, format: 0.4 } })).toEqual({ keep: true, why: "" });
  expect(verdict(cur, { train: 0.6, heldout: 0.5, cats: { honesty: 0.67, format: 0.8 } })).toEqual({ keep: false, why: "honesty −33" });
  expect(verdict(cur, { train: 0.6, heldout: 0.5, cats: { honesty: 0.9, format: 0.4 } }).keep).toBe(true); // exactly 10 points is allowed
  expect(verdict(cur, { train: 0.6, heldout: 0.4, cats: cur.cats })).toEqual({ keep: false, why: "held-out −10" });
  expect(verdict(cur, { train: 0.5, heldout: 0.9, cats: cur.cats })).toEqual({ keep: false, why: "no gain" });
  expect(verdict(cur, { train: 0.5, heldout: 0.5, cats: cur.cats }, false).keep).toBe(true); // pruning: holding is enough
  expect(verdict(cur, { train: 0.4, heldout: 0.5, cats: cur.cats }, false).why).toBe("train −10");
  // a drop inside measurement noise does not count; deterministic runs have zero noise
  expect(verdict(cur, { train: 0.6, heldout: 0.45, cats: cur.cats }, true, { heldout: 0.1 }).keep).toBe(true);
});

test("noiseOf: zero for deterministic tasks, positive for flaky ones", async () => {
  const tasks = [T("a", "x"), T("b", "x")];
  const r = await runSuite({ harness: toy({ a: ["A"] }), target: "t", adapter: "sdk", tasks, repeat: 3, vars: { system: "A" } });
  expect(noiseOf(r, r)).toBe(0);
  const flip = { ...r, tasks: r.tasks.map((t) => ({ ...t, passRate: 0.5 })) };
  expect(noiseOf(flip, flip)).toBeGreaterThan(0);
});

test("loop: stacks kept edits, rejects category drops, prunes dead lines, stops at plateau", async () => {
  const tasks = [T("a", "x"), T("b", "x"), T("c", "y"), T("d", "y")];
  const harness = toy({ a: ["ALPHA"], b: ["BETA"], c: [], d: [] }, { c: ["BAD"] });
  const log: string[] = [];
  const r = await tune({ ...base, harness, tasks, heldoutIds: [], instructions: "Be nice.", log: (l) => log.push(l),
    proposer: fixed(["ALPHA rule", "BAD BETA rule", "BETA rule"], ["nothing useful"]) });
  expect(r.steps.filter((s) => s.phase === "tune").map((s) => [s.line, s.kept, s.why])).toEqual([
    ["ALPHA rule", true, ""], ["BAD BETA rule", false, "y −50"], ["BETA rule", true, ""]]);
  expect(r.instructions.after).toBe("ALPHA rule\nBETA rule"); // "Be nice." cost nothing, so the prune pass removed it
  expect(r.removed).toBe(1);
  expect(r.changelog).toEqual([{ line: "ALPHA rule", fixed: ["a"] }, { line: "BETA rule", fixed: ["b"] }]);
  expect(r.final.score).toBe(1);
  expect(r.tunerCalls).toBe(1); // all train tasks passed after the first call
  expect(log.some((l) => /✗ \+BAD BETA rule.*rejected \(y −50\)/.test(l))).toBe(true);
});

test("held-out guard: an edit that helps train but hurts held-out is rejected", async () => {
  const tasks = [T("a", "x"), T("h", "x")];
  const harness = toy({ a: ["FIX"], h: [] }, { h: ["OVERFIT"] });
  const r = await tune({ ...base, harness, tasks, heldoutIds: ["h"], proposer: fixed(["FIX OVERFIT"], ["FIX"]) });
  expect(r.split).toEqual({ train: ["a"], heldout: ["h"] });
  expect(r.steps[0]).toMatchObject({ line: "FIX OVERFIT", kept: false, why: "held-out −100" });
  expect(r.steps[1]).toMatchObject({ line: "FIX", kept: true });
  expect(r.final).toMatchObject({ train: 1, heldout: 1 });
});

test("budget caps tuner calls; plateau ends early", async () => {
  const tasks = [T("a", "x"), T("b", "x")];
  let calls = 0;
  const p: Proposer = { kind: "tuner", label: "tuner", propose: async () => { calls++; return [{ op: "add", line: `useless ${calls}`, source: "tuner" }]; } };
  const r = await tune({ ...base, harness: toy({ a: ["A"], b: ["B"] }), tasks, heldoutIds: [], proposer: p, budget: 1 });
  expect(r.tunerCalls).toBe(1);
  expect(calls).toBe(1);
  calls = 0;
  const r2 = await tune({ ...base, harness: toy({ a: ["A"], b: ["B"] }), tasks, heldoutIds: [], proposer: p, budget: 10 });
  expect(r2.tunerCalls).toBe(2); // tuner patience: two barren calls, then stop
});

test("confirmation gate: --yes, TTY answers, and no TTY without --yes", async () => {
  const ask = (a: string) => () => a;
  expect(await confirmGate({ yes: true, tty: false, question: "?", ask: ask("") })).toBe("go");
  expect(await confirmGate({ tty: false, question: "?", ask: ask("y") })).toBe("need-yes");
  expect(await confirmGate({ tty: true, question: "?", ask: ask("y") })).toBe("go");
  expect(await confirmGate({ tty: true, question: "?", ask: ask("YES ") })).toBe("go");
  expect(await confirmGate({ tty: true, question: "?", ask: ask("") })).toBe("abort");
  expect(await confirmGate({ tty: true, question: "?", ask: () => null })).toBe("abort");
  // declining before the first tuner call means no tuner call and no target run
  let ran = 0;
  const r = await tune({ ...base, harness: async () => { ran++; return { text: "", ms: 0 }; }, tasks: [T("a", "x")], proposer: fixed(["X"]), confirm: async () => false });
  expect(r.aborted).toBe(true);
  expect(ran).toBe(0);
  // library mode never asks
  let asked = 0;
  await tune({ ...base, harness: toy({ a: [] }), tasks: [T("a", "x")], heldoutIds: [], proposer: libraryProposer(), confirm: async () => (asked++, true) });
  expect(asked).toBe(0);
});

test("resolveTuner: presets, models, copilot safety flags, custom commands", () => {
  expect(resolveTuner("claude").argv.slice(0, 3)).toEqual(["claude", "-p", "{prompt}"]);
  expect(resolveTuner("ollama:qwen2.5:14b").argv).toEqual(["ollama", "run", "qwen2.5:14b", "{prompt}"]);
  expect(resolveTuner("copilot:gpt-5").argv).toEqual(["copilot", "-p", "{prompt}", ...COPILOT_SAFE, "--model", "gpt-5"]);
  const c = resolveTuner("copilot --model x -p {prompt} --allow-all-tools").argv;
  expect(c).not.toContain("--allow-all-tools");
  for (const f of COPILOT_SAFE) expect(c).toContain(f);
  expect(resolveTuner("my-llm --temp 0")).toEqual({ argv: ["my-llm", "--temp", "0"], stdin: true });
  expect(resolveTuner("claude -p {prompt}").stdin).toBe(false);
});

test("tuner prompt: instructions, prompt, output and broken check of failed train tasks only", async () => {
  const tasks = [T("a", "x")];
  const r = await runSuite({ harness: toy({ a: ["A"] }), target: "t", adapter: "sdk", tasks, repeat: 1, vars: { system: "" } });
  const p = buildTunerPrompt(["Be nice."], [{ task: tasks[0], result: r.tasks[0] }]);
  expect(p).toContain("<instructions>\nBe nice.\n</instructions>");
  expect(p).toContain("### task a [x]");
  expect(p).toContain("task a");
  expect(p).toContain("nope");
  expect(p).toContain('Broken check: missing "PASS"');
  let seen = "";
  const prop = tunerProposer("fake", undefined, async (_spec, prompt) => { seen = prompt; return '```json\n{"edits":[{"op":"add","line":"A"}]}\n```'; });
  await tune({ ...base, harness: toy({ a: ["A"], h: ["H"] }), tasks: [T("a", "x"), T("h", "x")], heldoutIds: ["h"], proposer: prop });
  expect(seen).toContain("### task a");
  expect(seen).not.toContain("### task h"); // held-out failures never reach the tuner
});

test("library proposer: mock tiny model goes from ~29% to ~100%, offline", async () => {
  const harness = await sdkAdapter("examples/mock-tiny.ts");
  const r = await tune({ harness, target: "examples/mock-tiny.ts", adapter: "sdk", tasks: loadTasks("nope"), repeat: 3, key: "system", instructions: "", proposer: libraryProposer() });
  expect(r.baseline.score).toBeLessThan(0.45);
  expect(r.final.score).toBeGreaterThanOrEqual(0.9);
  expect(r.tunerCalls).toBe(0);
  expect(r.steps.every((s) => s.source === "library" || s.source === "prune")).toBe(true);
  expect(r.instructions.after).toMatch(/never invent/);
  expect(html([r.baselineRun, r.finalRun], r)).toContain("<h2>Tune</h2>");
});

test("tuner proposer: mock tuner CLI drives the loop and its bad edit is rejected", async () => {
  const harness = await sdkAdapter("examples/mock-tiny.ts");
  const r = await tune({ harness, target: "examples/mock-tiny.ts", adapter: "sdk", tasks: loadTasks("nope"), repeat: 3, key: "system",
    instructions: "You are a helpful assistant. Use tools when useful.", proposer: tunerProposer("bun examples/mock-tuner.ts"), budget: 4 });
  expect(r.tunerCalls).toBeGreaterThanOrEqual(1);
  expect(r.tunerCalls).toBeLessThanOrEqual(4);
  expect(r.final.score).toBeGreaterThanOrEqual(0.9);
  expect(r.steps.some((s) => s.source === "tuner" && s.op === "replace" && s.kept)).toBe(true);
  expect(r.steps.find((s) => /skip caveats/.test(s.line))?.kept).toBe(false);
}, 30_000);
