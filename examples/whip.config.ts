// Optional. Copy to ./whip.config.ts. Every field can also be a flag.
export default {
  target: "./examples/mock-tiny.ts",
  repeat: 3,
  evals: "./examples/evals",
  // `whip compare` runs each variant; the first is the baseline. Values that are file paths are read.
  variants: [{ system: "examples/prompts/baseline.md" }, { system: "examples/prompts/tuned.md" }],
};
