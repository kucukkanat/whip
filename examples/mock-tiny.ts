// SDK harness: the whole plug-in is this file. `ctx.vars.system` is set by --variant system=...
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineHarness } from "../src/index";
import { tinyModel } from "./tiny-model";

export default defineHarness(async (prompt, ctx) => {
  // This toy harness also edits files, like a coding agent would.
  const cfg = join(ctx.cwd, "config.json");
  if (/change the port/.test(prompt) && existsSync(cfg)) writeFileSync(cfg, readFileSync(cfg, "utf8").replace("3000", "8080"));
  if (/hello\.txt/.test(prompt)) writeFileSync(join(ctx.cwd, "hello.txt"), "hej\n");
  return tinyModel(prompt, ctx.vars.system ?? "");
});
