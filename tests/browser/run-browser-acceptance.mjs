#!/usr/bin/env node
/**
 * Runs the T1-T5 browser acceptance assertions against a real browser.
 *
 * They are ES modules importing from src/, so file:// will not load them: a short-lived static
 * server is required, and it is torn down in a finally block rather than left running.
 *
 * 🔴 These saturate the GPU by design. Do not run them while someone is gaming: it wrecks their
 * frame rate AND returns a meaningless number, because the benchmark would be measuring a
 * contended GPU.
 *
 * 📌 A headless browser often reports a SOFTWARE renderer. That is not a problem here, it is a
 * free live test of T4's first acceptance criterion: a software renderer must SUPPRESS the GPU
 * sub-score rather than report a plausible low number for a broken driver.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TYPES = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html",
  ".json": "application/json", ".wasm": "application/wasm",
};

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname === "/" ? "/tests/browser/harness.html" : url.pathname;
      // Refuse anything that escapes the repo. This serves a source tree, briefly, but a
      // traversal bug in a test harness is still a traversal bug.
      const target = normalize(join(ROOT, decodeURIComponent(path)));
      if (!target.startsWith(ROOT)) {
        res.writeHead(403).end("no");
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        "content-type": TYPES[extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store",
      }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port }));
  });
}

async function main() {
  // Playwright is a HARNESS dependency, not a project dependency: this repo ships zero
  // dependencies and must keep doing so. Install it anywhere and point PLAYWRIGHT_MODULE at it.
  // ⚠️ On Windows a bare absolute path is NOT a valid ESM specifier: `import("C:/...")` fails
  // with ERR_UNSUPPORTED_ESM_URL_SCHEME because `c:` reads as a protocol. Convert any real
  // path to a file:// URL so PLAYWRIGHT_MODULE can be set to the obvious thing.
  const configured = process.env.PLAYWRIGHT_MODULE ?? "playwright";
  const spec = existsSync(configured) ? pathToFileURL(
    statSync(configured).isDirectory() ? join(configured, "index.js") : configured,
  ).href : configured;
  const loaded = await import(spec);
  // Playwright ships CommonJS, so a file: import puts its exports on `default`.
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  if (!chromium) throw new Error(`could not resolve chromium from ${spec}`);
  const { server, port } = await startServer();
  const headed = process.argv.includes("--headed");

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      // Ask for real hardware. Without these a headless run reports a software renderer, which
      // is a valid test of one criterion but cannot measure the others.
      "--use-angle=default",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-webgpu",
    ],
  });

  try {
    const page = await browser.newPage();
    page.on("console", (m) => console.log("   [page]", m.text()));
    page.on("pageerror", (e) => console.log("   [page error]", e.message));

    await page.goto(`http://127.0.0.1:${port}/tests/browser/harness.html`, {
      waitUntil: "domcontentloaded",
    });

    // `--baseline` measures this device instead of asserting acceptance criteria. It runs in the
    // same browser with the same GPU flags, because a baseline measured under different flags is
    // not comparable with a run measured under these.
    if (process.argv.includes("--baseline")) {
      const repeats = Number(process.argv[process.argv.indexOf("--baseline") + 1]) || 3;
      const onlyIndex = process.argv.indexOf("--only");
      const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
      const measured = await page.evaluate(async ({ n, only: o }) => {
        // eslint-disable-next-line no-undef
        return window.__measureBaseline(n, o);
      }, { n: repeats, only });
      console.log("\n=== BASELINE MEASUREMENT ===");
      console.log(JSON.stringify(measured, null, 2));
      await browser.close();
      server.close();
      return;
    }

    const report = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      return window.__runAcceptance();
    }, undefined);

    console.log("\n=== RESULTS ===");
    let failed = 0;
    let unverified = 0;
    for (const row of report.results) {
      const mark = row.status === "pass"
        ? "PASS"
        : row.status === "unverified" ? "UNVERIFIED" : "FAIL";
      if (row.status === "fail") failed += 1;
      if (row.status === "unverified") unverified += 1;
      console.log(`  ${mark}  ${row.name}`);
      if (row.detail) console.log(`        ${row.detail}`);
    }
    console.log("\n=== ENVIRONMENT (part of what the results mean) ===");
    for (const [k, v] of Object.entries(report.environment)) {
      console.log(`  ${k}: ${v}`);
    }
    const summary = [
      failed === 0 ? "0 FAILED" : `${failed} FAILED`,
      `${unverified} UNVERIFIED`,
    ].join(" · ");
    console.log(`\n${summary}`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
