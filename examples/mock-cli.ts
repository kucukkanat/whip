// A CLI harness: prompt on stdin, answer on stdout, variant via $WHIP_SYSTEM. Run: whip "bun examples/mock-cli.ts"
import { tinyModel } from "./tiny-model";
const prompt = await new Response(Bun.stdin.stream()).text();
if (/hello\.txt/.test(prompt)) await Bun.write("hello.txt", "hej\n");
if (/change the port/.test(prompt)) { const f = Bun.file("config.json"); await Bun.write("config.json", (await f.text()).replace("3000", "8080")); }
console.log(tinyModel(prompt, process.env.WHIP_SYSTEM ?? ""));
