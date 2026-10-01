// UX-07 / WCAG 2.3.1, second method. The first one drew the WebGL canvas into a 2D canvas and got
// blank pixels 90% of the time, because the drawing buffer is cleared after compositing. It said so
// and refused to report a pass, which is the only reason this is being done properly.
//
// This captures COMPOSITED SCREENSHOTS of the preview region, which is literally what a viewer
// sees, then decodes each one back inside the page to read its pixels. Slower, and it cannot come
// back blank without that being real.
import { join } from "node:path"; import { existsSync, statSync } from "node:fs"; import { pathToFileURL } from "node:url";
const cfg = process.env.PLAYWRIGHT_MODULE;
const spec = existsSync(cfg) ? pathToFileURL(statSync(cfg).isDirectory() ? join(cfg, "index.js") : cfg).href : cfg;
const { chromium } = (await import(spec)).default ?? (await import(spec));

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=default", "--ignore-gpu-blocklist", "--use-gl=angle"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:8791/index.html", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /run device benchmark/i }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /^Start the/i }).click();

// Wait for the canvas, then sample it as fast as screenshots allow.
await page.waitForSelector("canvas", { timeout: 60000 });
const canvas = page.locator("canvas").first();

const shots = [];
const started = Date.now();
while (Date.now() - started < 20000) {
  try { shots.push(await canvas.screenshot({ type: "png" })); } catch { /* element gone */ break; }
}
console.log(`captured ${shots.length} composited frames over ${((Date.now() - started) / 1000).toFixed(1)}s`
  + `  (~${(shots.length / ((Date.now() - started) / 1000)).toFixed(0)} Hz)`);

const lums = [];
for (const buf of shots) {
  const b64 = buf.toString("base64");
  lums.push(await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 48; c.height = 27;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const { data: px } = ctx.getImageData(0, 0, c.width, c.height);
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    let sum = 0, maxCh = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += 0.2126 * f(px[i]) + 0.7152 * f(px[i + 1]) + 0.0722 * f(px[i + 2]);
      maxCh = Math.max(maxCh, px[i], px[i + 1], px[i + 2]);
    }
    return { mean: sum / (px.length / 4), maxCh };
  }, b64));
}
await browser.close();

const real = lums.filter((l) => l.maxCh > 8).length;
console.log(`frames with real content: ${real} of ${lums.length}`);
if (real < lums.length * 0.8) { console.log("🔴 PROBE INVALID: too many blank captures."); process.exit(1); }

const means = lums.map((l) => l.mean);
let maxDelta = 0, flashes = 0;
for (let i = 1; i < means.length; i += 1) {
  const d = Math.abs(means[i] - means[i - 1]);
  maxDelta = Math.max(maxDelta, d);
  if (d >= 0.10 && Math.min(means[i], means[i - 1]) < 0.80) flashes += 1;
}
const seconds = 20;
console.log(`mean luminance     : min ${Math.min(...means).toFixed(4)}  max ${Math.max(...means).toFixed(4)}`);
console.log(`largest frame delta: ${maxDelta.toFixed(4)}   (WCAG flash threshold 0.10)`);
console.log(`qualifying flashes : ${flashes} over ~${seconds}s  = ${(flashes / seconds).toFixed(2)}/s  (limit 3/s)`);
console.log(flashes / seconds > 3 ? "🔴 FAILS WCAG 2.3.1" : "✅ PASSES WCAG 2.3.1 general flash threshold");
