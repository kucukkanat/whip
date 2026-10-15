export type ToolSpec = { name: string; description: string; params?: Record<string, string> };
export type ToolCall = { name: string; args: unknown };
export type HarnessInput = { prompt: string; tools?: ToolSpec[]; files?: Record<string, string>; cwd: string; vars: Record<string, string> };
export type HarnessOutput = { text: string; toolCalls?: ToolCall[]; exitCode?: number; ms: number };
export type Harness = (input: HarnessInput) => Promise<HarnessOutput>;

/** What your harness gets besides the prompt. `vars` holds the `-v key=value` variables, e.g. `ctx.vars.system`. */
export type HarnessContext<K extends string = string> = {
  cwd: string; tools?: ToolSpec[]; files?: Record<string, string>; vars: Partial<Record<K, string>>;
};
/** What your harness returns: the answer, or the answer plus the tool calls it made. */
export type HarnessResult = string | { text?: string; toolCalls?: ToolCall[] };
export type SdkFn = (prompt: string, ctx: HarnessContext) => HarnessResult | Promise<HarnessResult>;

export type Check =
  | { contains: string } | { notContains: string }
  | { regex: string; flags?: string } | { notRegex: string; flags?: string }
  | { json: { required?: string[]; types?: Record<string, string>; exact?: boolean } }
  | { tool: string; args?: Record<string, unknown>; minCalls?: number }
  | { noTool: true }
  | { file: string; exists?: boolean; contains?: string }
  | { exitCode: number }
  | { maxWords: number }
  | { lines: string; count?: number }
  | { judge: string };

/** Simulated tool: fixed result, optional failures before success. */
export type ToolSim = { result: string; failFirst?: number; error?: string; when?: Record<string, string> };

export type Task = {
  id: string; category: string; prompt: string;
  tools?: (ToolSpec & { sim?: ToolSim | ToolSim[] })[];
  files?: Record<string, string>;
  checks: Check[];
  hint?: string;
};

export type Attempt = { pass: boolean; ms: number; failed: string[]; text: string; toolCalls: ToolCall[] };
export type TaskResult = { id: string; category: string; passRate: number; meanMs: number; attempts: Attempt[] };
export type Run = {
  whip: 1; id: string; target: string; adapter: "sdk" | "cli"; variant: Record<string, string>;
  repeat: number; startedAt: string; score: number; categories: Record<string, number>; tasks: TaskResult[];
};

/** One proposed instruction edit. `replace` swaps `target` for `line`; `remove` deletes `line`. */
export type Edit = { op: "add" | "replace" | "remove"; line: string; target?: string; reason?: string };
export type TuneStep = Edit & {
  phase: "tune" | "prune"; source: string; kept: boolean; why: string;
  train: [number, number]; heldout?: [number, number]; fixed: string[];
};
/** What `whip tune` writes to .whip/tune-<id>.json (and the report's tune section). */
export type TuneLog = {
  whip: 1; id: string; target: string; proposer: string; key: string; seed: number; holdout: number; repeat: number;
  split: { train: string[]; heldout: string[] };
  baseline: { score: number; train: number; heldout: number; categories: Record<string, number> };
  final: { score: number; train: number; heldout: number; categories: Record<string, number> };
  instructions: { before: string; after: string };
  steps: TuneStep[]; changelog: { line: string; fixed: string[] }[];
  kept: number; rejected: number; removed: number; tunerCalls: number; elapsedMs: number;
};
