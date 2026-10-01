// BenchDev's performance baseline, committed BESIDE the ledger on purpose.
//
// 🔴 A NUMBER IN PERF.md THAT NOBODY CAN REPRODUCE IS AN ASSERTION, NOT EVIDENCE. Patchwork's
// headline wasm-vs-webgpu figures were produced by a harness built in a scratchpad, and no copy
// survives, so that verdict can never be re-checked when the library moves. This lives in the repo.
//
// 🔴 WARM THE TARGET AND DISCARD THE FIRST LOAD. A cold container is not a slow app: Bloom's first
// baseline read LCP 3432 ms and the true warm figure was 396 ms.
//
// 🔴 AND PRINT THE SAMPLE COUNT BESIDE EVERY NUMBER, exiting non-zero when it is zero. A "0" that
// means "nothing found" and a "0" that means "nothing measured" are indistinguishable in a report,
// and the second always reads as good news.
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.BENCH_ROOT ?? process.cwd();
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2",
                ".ico": "image/x-icon" };

const server = createServer(async (req, res) => {
  let rel = normalize(decodeURIComponent(req.url.split("?")[0]));
  while (rel.startsWith("/") || rel.startsWith("\\")) rel = rel.slice(1);
  try {
    const body = await readFile(join(ROOT, rel === "" ? "index.html" : rel));
    // 🔴 SERVE COMPRESSED, because any real server does and this one did not. Measuring an
    // uncompressed 182 KB of JS where a visitor receives 43 KB makes the harness itself the
    // bottleneck, and the resulting number describes my test server rather than the product. That
    // is the same class of error as the parallel-variance experiment that measured its own harness.
    const type = TYPES[extname(rel)] ?? "application/octet-stream";
    const compressible = /javascript|css|html|json|x-icon/.test(type);
    const accepts = /gzip/.test(req.headers["accept-encoding"] ?? "");
    if (compressible && accepts) {
      const gz = gzipSync(body);
      res.writeHead(200, { "content-type": type, "content-encoding": "gzip",
                           "content-length": gz.length });
      res.end(gz);
      return;
    }
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
const port = await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));

const cfg = process.env.PLAYWRIGHT_MODULE;
if (!cfg) { console.error("set PLAYWRIGHT_MODULE to a playwright install"); process.exit(2); }
const spec = existsSync(cfg)
  ? pathToFileURL(statSync(cfg).isDirectory() ? join(cfg, "index.js") : cfg).href
  : cfg;
const loaded = await import(spec);
const chromium = loaded.chromium ?? loaded.default?.chromium;

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=default", "--ignore-gpu-blocklist", "--use-gl=angle"],
});

async function measure(label, width, height, { throttle = 1 } = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    hasTouch: width < 500,
    isMobile: width < 500,
  });
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  // Warm: load once and throw the result away.
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  const m = await page.evaluate(() => new Promise((resolve) => {
    let lcp = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
    let cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
    setTimeout(() => {
      const nav = performance.getEntriesByType("navigation")[0] ?? {};
      const res = performance.getEntriesByType("resource");
      resolve({
        lcp: Math.round(lcp),
        cls: Number(cls.toFixed(4)),
        ttfb: Math.round(nav.responseStart ?? 0),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd ?? 0),
        transferredBytes: res.reduce((s, r) => s + (r.transferSize || 0), 0),
        requestCount: res.length,
      });
    }, 2500);
  }));
  await page.close();
  return { label, width, throttle, ...m };
}

const rows = [];
rows.push(await measure("desktop", 1440, 900));
rows.push(await measure("phone", 360, 740));
rows.push(await measure("phone 4x CPU", 360, 740, { throttle: 4 }));
await browser.close();
server.close();

if (rows.length === 0) { console.error("REFUSING: measured 0 pages"); process.exit(1); }
console.log(`samples: ${rows.length} page loads, each warmed and re-loaded\n`);
for (const r of rows) {
  if (r.requestCount === 0) {
    console.error(`REFUSING: ${r.label} recorded 0 resource requests, so it measured nothing.`);
    process.exit(1);
  }
  console.log(`${r.label.padEnd(14)} LCP ${String(r.lcp).padStart(5)} ms   CLS ${r.cls}   `
    + `TTFB ${String(r.ttfb).padStart(3)} ms   DCL ${String(r.domContentLoaded).padStart(4)} ms   `
    + `${(r.transferredBytes / 1024).toFixed(1)} KB over ${r.requestCount} requests`);
}
