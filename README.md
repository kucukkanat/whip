# Whip

**Score your agent's harness, then improve its prompt.** Whip runs a fixed suite of small, deterministic tasks through your agent (system prompt, tools, scaffolding) and shows which instructions are missing. Tiny models benefit most.

```sh
whip <target>                                   # run the tasks, print a scorecard and hints
whip <target> -v system=@a.md -v system=@b.md   # compare two prompts
whip tune <target> prompts/a.md                 # let whip improve the prompt for you
whip diff                                       # compare the last two saved runs
```

That's the whole CLI. `whip <command> --help` has the details. When you make a mistake, whip tells you what to type instead.

## Quickstart

```sh
bun install && bun link                 # makes `whip` available (or use `bun src/cli.ts`)
whip examples/mock-tiny.ts              # scorecard for an offline fake tiny model
whip tune examples/mock-tiny.ts examples/prompts/baseline.md   # watch it go from ~29% to 100%
```

## 1. Pick a target

The target is the agent being scored. Three kinds:

| target | example | how whip talks to it |
|---|---|---|
| a built-in CLI | `whip claude` | runs it non-interactively (`whip run --help` shows the exact command) |
| your code | `whip ./my-harness.ts` | calls its default export |
| any command | `whip "my-agent --fast {prompt}"` | prompt at `{prompt}`, otherwise on stdin; answer on stdout |

Built-ins: `claude`, `codex`, `opencode`, `copilot`, `gemini`, `aider`, `goose`, `"ollama <model>"`.

**Your code** is one default-exported function. `defineHarness` is optional and only adds types:

```ts
// my-harness.ts
import { defineHarness } from "whip";

export default defineHarness(async (prompt, ctx) => {
  return myModel({ system: ctx.vars.system, prompt, cwd: ctx.cwd }); // return a string
});
```

Return a string, or `{ text, toolCalls: [{ name, args }] }` if you track tool calls yourself. `ctx` has `vars` (your variables), `cwd` (a fresh sandbox directory), `tools` and `files`. To type your variables: `defineHarness<"system" | "tools">(...)`. For a real local model, see [examples/ollama.ts](examples/ollama.ts).

## 2. Pass it a prompt

A **variable** is any named text your harness reads, usually the system prompt. Set it with `-v`:

```sh
whip ./my-harness.ts -v system=@prompts/a.md     # @ reads a file
whip ./my-harness.ts -v system="Be brief."       # or give the text
```

| your target | reads `-v system=…` as |
|---|---|
| `.ts` / `.js` harness | `ctx.vars.system` |
| a command | `$WHIP_SYSTEM`, or `{system}` placed in the command |
| a built-in CLI | not at all: wrap it, e.g. `"claude -p {prompt} --append-system-prompt {system}"` |

Whip warns when a variable never reaches the agent, for example when a harness never reads `ctx.vars.system`.

## 3. Compare prompts

Give the same variable two values and whip runs once per value, then prints what changed:

```sh
whip ./my-harness.ts -v system=@prompts/a.md -v system=@prompts/b.md
```

```
Whip diff  baseline 29% → prompts/b.md 100%  +71
  format                  33% → 100%  +67
  recovery                 0% → 100%  +100
  ▲ format-json              0% → 100%  flipped
```

The first value is the baseline. Only one variable may vary per comparison, so every change has one cause. Variables given once (e.g. `-v tools=@tools.md`) apply to every run.

Every run is saved to `.whip/runs/`. Compare any two later with `whip diff` (default: the last two), e.g. `whip diff latest~3 latest`. Add `--html` for a report.

## 4. Let whip tune the prompt

```sh
whip tune ./my-harness.ts prompts/a.md                  # offline: whip's built-in hints
whip tune ./my-harness.ts prompts/a.md --tuner claude   # a model proposes the edits
whip tune ./my-harness.ts prompts/a.md --write          # also save the result into prompts/a.md
```

Whip edits the prompt one line at a time and keeps an edit only when:

- the score goes up,
- no category drops more than 10 points, and
- a set of held-out tasks (never shown to the tuner) doesn't get worse.

Then it removes any line that isn't pulling its weight. The result goes to `.whip/tuned.md`. Your file is only changed with `--write`.

```
✓ +If the information is not in the prompt or …   17 → 33   kept
✗ +Be concise: answer directly and skip caveat…   47 → 42   rejected (honesty −50)
✓ +If a tool returns ERROR, read it, then retr…   58 → 67   kept
```

- **`--tuner`** picks who proposes edits. Presets: `claude`, `copilot`, `codex`, `gemini`, `opencode`, `ollama:<model>`; `name:<model>` adds `--model`. Any command works too: it gets the prompt at `{prompt}` or on stdin and replies `{"edits":[{"op":"add","line":"..."}]}`. See `whip tune --help`.
- **Cost.** Whip asks before calling a tuner and shows an estimate. `--yes` skips the question (required in CI). `--budget N` caps tuner calls (default 5).
- **Privacy.** A tuner sees the failing tasks' prompts and your agent's answers. Without `--tuner`, nothing leaves your machine.
- **Another variable.** `--key tools` tunes `ctx.vars.tools` instead of `system`.

## Flags

| flag | default | for |
|---|---|---|
| `-v key=value` / `key=@file` | | a variable for your harness; repeat a key to compare values |
| `-n N` | 3 | attempts per task |
| `--only <regex\|category>` | all | run some tasks, e.g. `--only format` |
| `--evals <dir>` | `./evals` | your own tasks, added to the built-in ones |
| `--no-save` | | write nothing to `.whip/` |
| `--tuner`, `--key`, `--budget`, `--write`, `--yes` | | `whip tune` only |
| `--html` | | `whip diff` only |

**Config (optional).** `whip.config.ts` sets defaults, so a bare `whip` works. Flags win. Example: [examples/whip.config.ts](examples/whip.config.ts).

```ts
export default {
  target: "./my-harness.ts",
  variants: [{ system: "@prompts/a.md" }, { system: "@prompts/b.md" }], // used when no -v is given
  tune: { tuner: "claude", budget: 5, holdout: 0.3, seed: 1, timeout: 300000 },
};
```

**Exit codes.** `0` when the command finishes, whatever the score. `1` on any error.

## The default suite

17 tasks in `tasks/*.yaml`: tool-selection, arguments, format, multi-step, recovery, instruction-following, honesty and concision. Each runs 3 times, so you get pass rates instead of coin flips. Each attempt runs in a fresh temp directory, so files a coding agent edits are checked on disk.

**Tools are simulated.** Tasks declare tools; whip describes them in the prompt with a one-line protocol (`TOOL <name> {"arg":"value"}`), answers calls with the simulated result and calls your harness again, up to 4 turns. Tool calls are also read from JSON event streams (Claude Code, Codex, OpenCode, Copilot) and from `toolCalls` you return.

## Writing your own tasks

Drop `*.yaml` or `*.json` files into `./evals/`. They're picked up automatically.

```yaml
- id: store-hours
  category: tool-selection
  prompt: "When does IKEA Delft open on Saturday?"
  files: { notes.md: "seed files for the sandbox" }      # optional
  tools:                                                 # optional, simulated
    - name: store_hours
      description: Opening hours for an IKEA store
      params: { store: string, day: string }
      sim: { result: "Saturday 09:00-21:00", failFirst: 0 }   # or a list with `when: {arg: value}`
  checks:
    - { tool: store_hours, args: { store: "/delft/i" } }  # "/re/flags" strings are regexes
    - { contains: "09:00" }
```

| check | passes when |
|---|---|
| `contains` / `notContains` | text includes / excludes (case-insensitive) |
| `regex` / `notRegex` (+`flags`) | text matches / doesn't |
| `json: {required, types, exact}` | output parses as a JSON object; `exact` forbids fences |
| `lines: <re>, count` | every line matches, optional exact line count |
| `tool, args, minCalls` | the tool was called (args are a subset match) |
| `noTool: true` | no tool was called |
| `file, exists, contains` | sandbox file state after the run |
| `exitCode` | process exit code (otherwise non-zero always fails) |
| `maxWords` | answer length budget |
| `judge` | reserved for an LLM judge; off, never calls out |

## Layout

```
src/cli.ts       commands
src/args.ts      flag parsing, validation and "did you mean" messages
src/adapters.ts  SDK + CLI adapters, built-in CLI table, tool-call parsing
src/engine.ts    task loading, sandbox, tool loop, repeats
src/checks.ts    structured checks
src/report.ts    scorecard, diff, hints, HTML
src/tune.ts      whip tune: split, proposers, keep rules, greedy loop, prune
tasks/           default suite
examples/        offline fake tiny model (SDK and CLI), Ollama harness, mock tuner, prompts, custom eval
site/            landing page + docs (Vite, React, Tailwind)
```

`bun test` runs the unit tests. Whip makes no network calls of its own and keeps results in `.whip/`.
