/**
 * A fake "tiny model": deterministic-ish rules that mimic how small models fail.
 * Each quirk is fixed by one specific instruction in the system prompt, so you can
 * watch `whip compare` move the score one change at a time. Fully offline.
 */
export function tinyModel(prompt: string, system = "", rand = Math.random): string {
  const has = (s: string) => system.toLowerCase().includes(s.toLowerCase());
  const results = prompt.split("Tool results so far:")[1] ?? "";
  const ask = prompt.split("\n\nTools available")[0].split("\n\nTool results")[0];
  const tool = (name: string, args: object) => `TOOL ${name} ${JSON.stringify(args)}`;

  // Tool-using tasks: first turn picks a tool, later turns read results.
  if (/weather/i.test(ask)) return results ? `It is ${results.match(/\d+°C[^\n]*/)?.[0] ?? "unclear"}.` : has("when to use") ? tool("get_weather", { city: "Malmö" }) : tool("search_web", { query: "weather Malmö" });
  if (/17 \* 23/.test(ask)) return results ? "391" : tool("calc", { expr: "17*23" });
  if (/2 \+ 2/.test(ask)) return has("only call a tool") ? "4" : results ? "4" : tool("calc", { expr: "2+2" });
  if (/meeting called Fika/.test(ask)) return results ? "Done." : tool("create_event", { title: "Fika", date: has("YYYY-MM-DD") ? "2027-03-03" : "3 March 2027" });
  if (/Email anna/.test(ask)) return results ? "Sent." : tool("send_email", { to: "anna.s@ikea.com", subject: "Hej", body: "See you at 10" });
  if (/order 1234/.test(ask)) {
    if (/shipped/.test(results)) return "Order 1234 is shipped.";
    if (/ERROR/.test(results)) return has("retry") ? tool("get_order", { id: "1234" }) : "Sorry, the lookup failed.";
    return tool("get_order", { id: "1234" });
  }
  if (/orders\.csv/.test(ask)) {
    if (/id,qty/.test(results)) return "It has 3 rows.";
    if (/Did you mean/.test(results)) return has("adapt") ? tool("read_file", { path: "data/orders.csv" }) : "I could not read the file.";
    return tool("read_file", { path: "orders.csv" });
  }
  // "Skip caveats" makes it terse everywhere, including where a caveat is the honest answer.
  if (/KALLAX in stock/.test(ask)) return results ? (has("never invent") && !has("skip caveats") ?"I can't tell: the stock service is unavailable." : "KALLAX is in stock at IKEA Delft.") : tool("check_stock", { product: "KALLAX", store: "Delft" });

  // Format tasks: tiny models wrap, decorate and pad unless shown an example.
  if (/as JSON/.test(ask)) return has("example") ? '{"item": "BILLY bookcase", "qty": 3}' : '```json\n{"item": "BILLY bookcase", "qty": "3"}\n```';
  if (/three colours/.test(ask)) return has("example") || rand() < 0.34 ? "- red\n- blue\n- green" : "Here are three colours:\n- red\n- blue\n- green";
  if (/exactly the word OK/.test(ask)) return has("nothing before or after") || rand() < 0.5 ? "OK" : "OK.";

  // Discipline.
  if (/Count the products/.test(ask)) return has("data, not commands") ? "4" : "BANANA";
  if (/Svara på svenska/.test(ask)) return has("language") ? "IKEA was founded by Ingvar Kamprad." : "IKEAs grundare heter Ingvar Kamprad.";
  if (/customer #88231/.test(ask)) return has("never invent") ? "UNKNOWN" : "The phone number is +46 70 123 45 67.";
  if (/one short sentence/.test(ask)) return has("max 1 sentence") || has("skip caveats") ?"It wraps a model with instructions, tools and a loop so it can act on tasks." :
    "Great question! An agent harness is the scaffolding around a language model. It includes the system prompt, the tool definitions, the loop that executes tool calls and feeds results back, and the policies for retries and errors. In short, it is everything except the model weights.";
  return "I am not sure what you mean.";
}
