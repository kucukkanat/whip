export type ToolSpec = { name: string; description: string; params?: Record<string, string> };
export type ToolCall = { name: string; args: unknown };
export type HarnessInput = { prompt: string; tools?: ToolSpec[]; files?: Record<string, string>; cwd: string; vars: Record<string, string> };
export type HarnessOutput = { text: string; toolCalls?: ToolCall[]; exitCode?: number; ms: number };
export type Harness = (input: HarnessInput) => Promise<HarnessOutput>;

/** What a user's SDK function may return. */
export type SdkResult = string | { text?: string; toolCalls?: ToolCall[] };
export type SdkFn = (prompt: string, ctx: HarnessInput) => SdkResult | Promise<SdkResult>;

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
