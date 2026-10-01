// ARCH-08, Gate 4: the recorded baselines were measured by a harness that gives each workload its
// OWN runner, so its workers are terminated before the next begins. A production run puts all four
// in ONE runner scope, so the JS worker and the WASM worker (the latter holding an instantiated
// module) are still resident during the parallel ramp and the GPU phase.
//
// So the reference numbers were taken on a machine with zero resident workers and every user number
// is taken with two. This measures through the REAL APP instead, reading the raw values out of the
// diagnostic JSON the product itself produces. No harness, no special path.
import { join } from "node:path"; import { existsSync, statSync } from "node:fs"; import { pathToFileURL } from "node:url";
const cfg = process.env.PLAYWRIGHT_MODULE;
const spec = existsSync(cfg) ? pathToFileURL(statSync(cfg).isDirectory() ? join(cfg, "index.js") : cfg).href : cfg;
const loaded = await import(spec);
const chromium = loaded.chromium ?? loaded.default?.chromium;

const runs = Number(process.argv[2] ?? 5);
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=default", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle"],
});
const rows = [];
for (let i = 0; i < runs; i += 1) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:8791/index.html", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /run device benchmark/i }).click();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: /^Start the/i }).click();
  await page.waitForFunction(
    () => ["result", "unscored"].includes(document.querySelector("#screen")?.dataset.screen),
    null, { timeout: 180000 });
  const row = await page.evaluate(() => {
    const pre = [...document.querySelectorAll("pre,code,textarea")]
      .map((n) => n.textContent).find((t) => t && t.trim().startsWith("{"));
    const raw = {};
    for (const tr of document.querySelectorAll("table tbody tr")) {
      const cells = [...tr.children].map((c) => c.innerText.trim());
      if (cells.length === 2) raw[cells[0]] = cells[1];
    }
    return { screen: document.querySelector("#screen").dataset.screen, json: pre ?? null, raw };
  });
  rows.push(row);
  await page.close();
  process.stdout.write(`run ${i + 1}/${runs}: ${row.screen}\n`);
}
await browser.close();

const numbers = {};
for (const r of rows) {
  if (!r.json) continue;
  let d; try { d = JSON.parse(r.json); } catch { continue; }
  const list = d?.result?.measurements ?? d?.measurements ?? [];
  for (const m of list) {
    if (typeof m?.value === "number") (numbers[m.id] ??= []).push(m.value);
  }
}
console.log("\n=== raw measurements, through the PRODUCTION path ===");
if (Object.keys(numbers).length === 0) {
  console.log("no diagnostic JSON found on the page; raw table instead:");
  console.log(JSON.stringify(rows.map((r) => r.raw), null, 1).slice(0, 1200));
} else {
  for (const [id, vals] of Object.entries(numbers)) {
    const tail = vals.slice(1);
    const med = [...tail].sort((a, b) => a - b)[Math.floor(tail.length / 2)];
    const spread = tail.length > 1 ? ((Math.max(...tail) - Math.min(...tail)) / med * 100) : 0;
    console.log(`${id.padEnd(32)} median(2..n)=${med?.toFixed(1)}  spread=${spread.toFixed(2)}%  raw=${vals.map((v) => v.toFixed(1)).join(", ")}`);
  }
}
