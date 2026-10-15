// Optional. Copy to ./whip.config.ts. Flags win over these values.
export default {
  target: "./examples/mock-tiny.ts",
  repeat: 3,
  evals: "./examples/evals",
  // `whip` with no -v runs each variant and compares them to the first. @ reads a file.
  variants: [{ system: "@examples/prompts/baseline.md" }, { system: "@examples/prompts/tuned.md" }],
  // tune: { tuner: "claude", budget: 5, holdout: 0.3, seed: 1, timeout: 300000 },
};
