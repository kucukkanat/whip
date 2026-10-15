# Whip

**Evaluate the harness, not the model.** Whip runs a fixed suite of small, deterministic tasks through your agent harness (system prompt, tool definitions, scaffolding) and tells you exactly which instruction gaps make tiny models fail. Change one thing, re-run, watch the number move.

- **Zero config.** `whip <target>` detects the harness type, runs the suite, prints a scorecard.
- **Thin wrapper.** One engine, two adapters. 0 lines to plug in a CLI, ~5 for an SDK.
- **Scored on success, not vibes.** Regex, JSON schema, tool name and args, files on disk, exit codes.
- **Local and offline.** No telemetry, no network calls of its own. Results stay in `.whip/`.

## 30-second quickstart

```sh
bun install && bun link                                # makes `whip` available (local only)
whip examples/mock-tiny.ts                             # scorecard for an offline fake tiny model
whip compare examples/mock-tiny.ts --variant system=examples/prompts/baseline.md --variant system=examples/prompts/tuned.md
```

Without linking, use `bun src/cli.ts` instead of `whip`.

## Plug in a CLI (0 lines)

```sh
whip claude            # claude -p … --output-format stream-json
whip codex             # codex exec --json --sandbox workspace-write …
whip opencode          # opencode run --format json …
whip copilot           # copilot -p … --allow-all-tools --output-format json
whip "ollama qwen2.5:0.5b"
whip "my-agent --fast"             # anything else: prompt on stdin, answer on stdout
whip "hermes chat -q {prompt}"     # or put {prompt} where the prompt goes
```

Each task runs in a fresh temp directory seeded with the task's files, so edits a coding CLI makes are checked on disk. Variants reach CLIs as env vars (`--variant system=a.md` → `$WHIP_SYSTEM`) and as `{system}` placeholders. `whip clis` prints the table.

| name | invocation | notes |
|---|---|---|
| claude | `claude -p {prompt} --output-format stream-json --verbose --allowedTools Read,Edit,Write,Bash` | tool_use events parsed |
| codex | `codex exec --json --skip-git-repo-check --sandbox workspace-write {prompt}` | JSONL items parsed |
| opencode | `opencode run --format json {prompt}` | JSONL |
| copilot | `copilot -p {prompt} --allow-all-tools --output-format json` | JSONL |
| gemini | `gemini -p {prompt} --output-format json --yolo` | |
| aider | `aider --message {prompt} --yes-always --no-git` | text + files |
| goose | `goose run -t {prompt}` | text + files |
| ollama | `ollama run <model> {prompt}` | raw tiny model, text tool protocol |

## Plug in an SDK harness (~5 lines)

```ts
// my-harness.ts
import { defineHarness } from "whip"; // optional helper; a plain default export works too
import { runAgent } from "./agent";

export default defineHarness(async (prompt, ctx) => runAgent({ system: ctx.vars.system, prompt, cwd: ctx.cwd }));
```

```sh
whip ./my-harness.ts
```

Return a string, or `{ text, toolCalls: [{ name, args }] }`. `ctx` has `cwd`, `tools`, `files` and `vars` (your variants).

### How tools work

Tasks declare simulated tools. Whip describes them in the prompt with a one-line text protocol: `TOOL <name> {"arg":"value"}`. When a harness calls a tool (through returned `toolCalls`, JSONL events or `TOOL` lines), Whip answers with the simulated result and calls the harness again, for up to 4 turns. That lets the same task test tool choice, arguments and error recovery on any harness, including a bare `ollama run`.

## Compare variants: the feedback loop

```sh
whip compare ./my-harness.ts --variant system=prompts/a.md --variant system=prompts/b.md
whip diff latest~1 latest      # any two saved runs (ids, paths, latest, latest~N)
whip suggest                   # rule-based hints from the latest failures, no model needed
whip report latest~1 latest    # static HTML at .whip/report.html
```

The first variant is the baseline. Whip prints deltas per category and per task and marks tasks that **flipped**. Change one element per variant so the delta has one cause.

## Default suite

17 tasks in `tasks/*.yaml` across tool-selection, arguments, format, multi-step, recovery, instruction-following, honesty and concision. Each runs 3 times (`-n`), and the scorecard shows pass rate and mean latency.

## Task file format

Drop `*.yaml` or `*.json` into `./evals/` (or pass `--evals dir`) and they're picked up automatically.

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
| `judge` | reserved for an LLM judge; off by default, never calls out |

## Config (optional)

`whip.config.ts` with a default export: `target`, `repeat`, `evals`, `only`, `variants: [{ system: "a.md" }, …]`. Flags win. See `examples/whip.config.ts`.

## Layout

```
src/cli.ts       commands and flags
src/adapters.ts  SDK + CLI adapters, known CLI table, tool-call parsing
src/engine.ts    task loading, sandbox, tool loop, repeats
src/checks.ts    structured checks
src/report.ts    scorecard, diff, suggest, HTML
tasks/           default suite
examples/        offline fake tiny model (SDK and CLI), prompt variants, custom eval
site/            landing page + docs (Vite, React, Tailwind)
```

`bun test` runs the unit tests.
