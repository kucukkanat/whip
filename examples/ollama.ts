// A real tiny model through Ollama's HTTP API, with the system prompt from -v system=... (or the prompt being tuned).
// whip examples/ollama.ts -v system=@examples/prompts/baseline.md
// whip tune examples/ollama.ts examples/prompts/baseline.md
import { defineHarness } from "../src/index";

const model = process.env.OLLAMA_MODEL ?? "qwen2.5:1.5b";

export default defineHarness<"system">(async (prompt, ctx) => {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    body: JSON.stringify({ model, system: ctx.vars.system ?? "", prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`ollama: ${res.status} ${await res.text()} (is "ollama serve" running and ${model} pulled?)`);
  return (await res.json()).response as string;
});
