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
whip tune ./my-harness.ts      # let Whip propose, score and keep prompt edits (see Tuning)
```

The first variant is the baseline. Whip prints deltas per category and per task and marks tasks that **flipped**. Change one element per variant so the delta has one cause.

## Tuning: let Whip edit the prompt

```sh
whip tune examples/mock-tiny.ts                                      # library mode: no model, ~29% → 100%
whip tune examples/mock-tiny.ts --tuner "bun examples/mock-tuner.ts" --yes   # offline mock editor
whip tune ./my-harness.ts --target-file system=prompts/a.md \
  --tuner "copilot --model <claude-opus-id> -p {prompt}"             # a real model as editor
whip tune ./my-harness.ts --target-file system=prompts/a.md --tuner copilot:<claude-opus-id>   # same via preset
```

`whip tune` runs the compare loop for you, one edit at a time:

1. **Split.** A seeded split (`--seed 1`) holds out `--holdout 0.3` of the suite. Held-out tasks are spread across categories and never shown to the proposer. Baseline is scored on both halves with the usual `-n` repeats.
2. **Propose.** By default the proposer is the `whip suggest` hint library: each failure type maps to drop-in instruction lines. With `--tuner <cmd>`, any CLI becomes the editor. It gets the current instructions plus the failed train tasks (prompt, actual output, broken check) and must reply `{"edits":[{"op":"add"|"replace"|"remove","line":"…","target":"…","reason":"…"}]}`. Code fences, surrounding prose, a bare edit object or trailing junk are all fine.
3. **Score and keep.** Each edit is scored against the current instructions and **kept only if** train rises, no category drops more than 10 points, and the held-out score doesn't drop. Kept edits stack. A drop only counts if it is bigger than measurement noise (two standard errors from tasks that pass only sometimes; zero when every task always passes or always fails). When noise could have decided a verdict, or a rejection would throw away a train gain, both sides are re-scored once and the verdict uses the pooled attempts.
4. **Stop and prune.** Tuning stops when all train tasks pass, at a plateau, or when `--budget` tuner calls (default 5) are spent. A last pass removes every line whose removal costs nothing.

```
✓ +If the information is not in the prompt or …   17 → 33   kept (library)
✗ +Be concise: answer directly and skip caveat…   47 → 42   rejected (honesty −50)
✓ +If a tool returns ERROR, read it, then retr…   58 → 67   kept (library)
```

Results: `.whip/tuned.md` (the new instructions), `.whip/tune-<id>.json` (every step, plus a changelog of which line fixed which tasks), a tune section in `.whip/report.html`, and the baseline and final runs in `.whip/runs/`. Your prompt file is only overwritten with `--write`. `--no-save` writes only `tuned.md`.

- **Target vs tuner.** The target is the harness being scored. The tuner only edits text. Edits reach the target through the normal variant mechanism: `--target-file system` (default) means `ctx.vars.system` / `$WHIP_SYSTEM`. Start from a file with `--target-file system=prompts/a.md` or `--variant system=prompts/a.md`.
- **Tuner presets** (`whip clis`): `claude`, `copilot`, `codex`, `gemini`, `opencode`, `ollama:<model>`, and `name:<model>` for a `--model` flag. They run in a throwaway directory with tools off where the CLI allows it. Copilot always gets `--silent --no-color --no-ask-user --disable-builtin-mcps --deny-tool=shell --deny-tool=write`, even in a custom command. Anything else works too: `--tuner "claude -p {prompt}"`, `--tuner "copilot --model <claude-opus-id> -p {prompt}"`, `--tuner "ollama run qwen2.5:14b"` (prompt on stdin without `{prompt}`).
- **Confirmation.** Before the first tuner call Whip prints the estimated tuner and target calls and asks to continue. `--yes` skips the question. Without a TTY, `--yes` is required, otherwise it exits non-zero without calling anything. Library mode never calls a model and doesn't ask.
- **When the library runs out.** If failures remain after library mode, the summary suggests `--tuner`.

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

## CLI reference

Every command takes `--help` (`whip tune --help`). Anything that isn't a command name is a target, so `whip claude` is `whip run claude`.

| command | does |
|---|---|
| `whip [run] <target>` | run the suite, print a scorecard; writes `.whip/runs/<id>.json` and `.whip/report.html` |
| `whip compare <target> --variant k=v --variant k=v` | one run per variant, deltas vs the first; without `--variant` uses config `variants` |
| `whip diff [runA] [runB]` | compare two saved runs (default `latest~1 latest`) |
| `whip suggest [run]` | rule-based hints for a run's failures (default `latest`) |
| `whip report [runs...]` | write `.whip/report.html` (default `latest`) |
| `whip tune <target>` | propose, score and keep instruction edits (see Tuning) |
| `whip clis` | print known CLI targets and `--tuner` presets |
| `whip` | with `whip.config.ts`: run its `target`; without: print help |

Run refs (`diff`, `suggest`, `report`): `latest`, `latest~N`, a run id in `.whip/runs/` (`.json` optional), or a path.

**run / compare / tune flags**

| flag | default | description |
|---|---|---|
| `-n`, `--repeat N` | 3 | attempts per task |
| `--only <regex\|category>` | all | tasks whose id matches the regex or whose category equals the value |
| `--evals <dir>` | `./evals` | extra tasks, added to the built-in suite |
| `-v`, `--variant k=v` | | repeatable; a value that is an existing file is replaced by its contents; `k=v,k2=v2` sets several keys |
| `--no-save` | off | don't write `.whip/runs/` or `.whip/report.html` (tune: write only `.whip/tuned.md`) |
| `-h`, `--help` | | help for the command |

**tune-only flags**

| flag | default | description |
|---|---|---|
| `--tuner <preset\|cmd>` | library mode | `claude`, `copilot`, `codex`, `gemini`, `opencode`, `ollama:<model>`, `name:<model>`, or any command (`{prompt}` or stdin) |
| `--target-file key[=file]` | `system` | variable the edits go to, optionally its starting file |
| `--budget N` | 5 | max tuner calls (ignored in library mode) |
| `--holdout F` | 0.3 | share of tasks held out (0 to 0.9) |
| `--seed N` | 1 | split seed |
| `-y`, `--yes` | off | skip the confirmation; required without a TTY |
| `--write` | off | also overwrite the `--target-file` file |
| `--timeout ms` | 300000 | per tuner call (CLI targets have a fixed 120 s timeout) |

**Config.** Optional `whip.config.ts` in the current directory, default export: `target`, `repeat`, `evals`, `only` (all commands that run tasks) and `variants: [{ system: "a.md" }, …]` (`compare` only). Flags win. See `examples/whip.config.ts`.

**Environment.** `NO_COLOR` disables colors. `WHIP_JUDGE`, when non-empty, makes `judge` checks fail instead of passing. CLI targets get `WHIP_<KEY>` for each variant key.

**Exit codes.** `0` when the command finishes, whatever the score. `1` on any error, or when `whip tune` is declined or needs `--yes`.

Full reference with examples: the site's [CLI reference](site/) page (`#/docs/cli`).

## Layout

```
src/cli.ts       commands and flags
src/adapters.ts  SDK + CLI adapters, known CLI table, tool-call parsing
src/engine.ts    task loading, sandbox, tool loop, repeats
src/checks.ts    structured checks
src/report.ts    scorecard, diff, suggest (+ the hint library), HTML
src/tune.ts      whip tune: split, proposers, keep rules, greedy loop, prune
tasks/           default suite
examples/        offline fake tiny model (SDK and CLI), mock tuner, prompt variants, custom eval
site/            landing page + docs (Vite, React, Tailwind)
```

`bun test` runs the unit tests.
