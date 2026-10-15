// Local-only helper: headless screenshots of the built site. Usage: node site/shots.mjs <playwright-core path>
const { chromium } = await import(process.argv[2]);
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const base = "http://localhost:4174/whip/";
for (const [name, vp] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  for (const theme of ["dark", "light"]) {
    const p = await b.newPage({ viewport: vp, reducedMotion: "reduce" });
    await p.addInitScript((t) => localStorage.setItem("theme", t), theme);
    await p.goto(base); await p.waitForTimeout(400);
    await p.screenshot({ path: `screenshots/landing-${name}-${theme}.png`, fullPage: name === "desktop" });
    await p.goto(base + "#/docs/checks"); await p.waitForTimeout(400);
    await p.screenshot({ path: `screenshots/docs-${name}-${theme}.png` });
    if (name === "desktop" && theme === "dark") { await p.keyboard.press("Control+k"); await p.keyboard.type("fail"); await p.waitForTimeout(200); await p.screenshot({ path: "screenshots/docs-search.png" }); }
    await p.close();
  }
}
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("file:///workspace/whip/.whip/report.html"); await p.screenshot({ path: "screenshots/report.png" });
await b.close();
