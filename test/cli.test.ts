import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBuiltin, reach, resolveCommand, sdkAdapter, targetProblem } from "../src/adapters";
import { checkConfig, closest, parseArgs, parseVariant, removedCommand } from "../src/args";
import { variantSets } from "../src/cli";

test("parseArgs: --flag value, --flag=value, short flags, repeated -v", () => {
  expect(parseArgs("tune", ["./h.ts", "a.md", "--tuner=claude", "-n", "2", "-v", "x=1", "--variant", "y=2", "--write", "-y"])).toEqual({
    pos: ["./h.ts", "a.md"], flags: { tuner: "claude", repeat: "2", write: true, yes: true }, variants: ["x=1", "y=2"],
  });
});

test("parseArgs: mistakes come back with the fix", () => {
  expect(() => parseArgs("run", ["x", "--onyl", "format"])).toThrow(/Did you mean --only\?/);
  expect(() => parseArgs("run", ["x", "--budegt", "3"])).toThrow(/Did you mean --budget\? It only works with whip tune/);
  expect(() => parseArgs("run", ["x", "--write"])).toThrow(/only works with whip tune/);
  expect(() => parseArgs("tune", ["x", "--target-file", "system=a.md"])).toThrow(/whip tune <target> prompts\/a.md/);
  expect(() => parseArgs("tune", ["x", "--holdout", "0.2"])).toThrow(/whip.config.ts/);
  expect(() => parseArgs("run", ["x", "-n"])).toThrow(/-n needs a value .* -n 5/);
  expect(() => parseArgs("run", ["x", "--only", "--no-save"])).toThrow(/needs a value/);
  expect(() => parseArgs("tune", ["x", "--write=yes"])).toThrow(/takes no value/);
});

test("closest: typos including swapped letters", () => {
  expect(closest("tnue", ["run", "diff", "tune"])).toBe("tune");
  expect(closest("cluade", ["claude", "codex"])).toBe("claude");
  expect(closest("banana", ["run", "diff", "tune"])).toBeUndefined();
});

test("parseVariant: @ reads a file; a bare existing path is called out", () => {
  const d = mkdtempSync(join(tmpdir(), "whip-v-")), f = join(d, "a.md");
  writeFileSync(f, "Be brief.");
  expect(parseVariant(`system=@${f}`)).toEqual({ key: "system", value: "Be brief.", label: f });
  expect(parseVariant("system=Be brief, please.")).toEqual({ key: "system", value: "Be brief, please.", label: "Be brief, please." });
  expect(() => parseVariant(`system=${f}`)).toThrow(`system=@${f}`);
  expect(() => parseVariant("system=@nope.md")).toThrow(/file not found: nope.md/);
  expect(() => parseVariant("system")).toThrow(/expected key=value/);
  expect(() => parseVariant("prompt=x")).toThrow(/reserved/);
  expect(() => parseVariant("my-key=x")).toThrow(/not a valid variable name/);
  expect(parseVariant("system=a,tools=b").warning).toMatch(/-v system=a -v tools=b/);
});

test("variantSets: a repeated key gives one run per value, single keys are shared", () => {
  const v = (s: string) => parseVariant(s);
  expect(variantSets([v("tools=t"), v("system=a"), v("system=b")]).map((s) => s.vars)).toEqual([{ tools: "t", system: "a" }, { tools: "t", system: "b" }]);
  expect(variantSets([v("system=a")]).map((s) => s.vars)).toEqual([{ system: "a" }]);
  expect(() => variantSets([v("system=a"), v("system=b"), v("tools=x"), v("tools=y")])).toThrow(/only one variable can change/);
});

test("removed commands point at their replacement", () => {
  expect(removedCommand("compare", ["./h.ts", "--variant", "system=a.md", "--variant", "system=b.md"])).toContain("whip run ./h.ts -v system=@a.md -v system=@b.md");
  expect(removedCommand("suggest", ["latest~2"])).toContain("whip diff latest~3 latest~2");
  expect(removedCommand("report", [])).toContain("whip diff latest~1 latest --html");
  expect(removedCommand("clis", [])).toContain("whip run --help");
  expect(removedCommand("run", [])).toBeUndefined();
});

test("checkConfig: unknown keys get a suggestion", () => {
  expect(checkConfig({ target: "x", tune: { budget: 2 } })).toEqual({ target: "x", tune: { budget: 2 } });
  expect(() => checkConfig({ varients: [] })).toThrow(/Did you mean "variants"/);
  expect(() => checkConfig({ tune: { holdot: 0.2 } })).toThrow(/Did you mean "tune.holdout"/);
  expect(() => checkConfig({ variants: ["a.md"] })).toThrow(/list of objects/);
});

test("targets: ollama run <model>, built-ins don't get variables, typos are caught", () => {
  expect(resolveCommand("ollama run qwen2.5:1.5b").argv).toEqual(["ollama", "run", "qwen2.5:1.5b", "{prompt}"]);
  expect(isBuiltin("claude")).toBe(true);
  expect(isBuiltin("ollama qwen2.5:0.5b")).toBe(true);
  expect(isBuiltin("claude -p {prompt} --append-system-prompt {system}")).toBe(false);
  expect(reach("claude", "system")).toBe("never");
  expect(reach("my-agent {system} {prompt}", "system")).toBe("placeholder");
  expect(reach("bun agent.ts", "system")).toBe("env");
  expect(reach("./h.ts", "system")).toBe("sdk");
  expect(targetProblem("./nope.ts")).toMatch(/harness file not found/);
  expect(targetProblem("tnue", ["run", "tune"])).toMatch(/Did you mean: whip tune/);
  expect(targetProblem("bun examples/mock-cli.ts")).toBeUndefined();
});

test("SDK adapter records which ctx.vars the harness read", async () => {
  const h = await sdkAdapter("examples/mock-tiny.ts");
  await h({ prompt: "hi", cwd: tmpdir(), vars: { system: "x", other: "y" } });
  expect([...h.readVars!]).toEqual(["system"]);
});
