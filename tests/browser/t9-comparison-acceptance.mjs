#!/usr/bin/env node
/**
 * T9 acceptance: the named-device comparison table, asserted in a real browser.
 *
 * 🔴 WHY THIS EXISTS AS A SEPARATE HARNESS. The unit suite proves `createComparisonTableState`
 * sorts and filters correctly, and it cannot prove that any of it reaches the page. T9 shipped
 * with 95 green unit tests and its browser layer entirely unexercised, which is the trap
 * to avoid: a green suite is evidence only about what it can reach.
 *
 * It drives the real `index.html` through a real Quick run, because the comparison table only
 * exists on the result screen and the current row is built from the live result. That is the
 * path a person takes.
 *
 * ⚠️ It serves a SUBSTITUTE `corpus.json` holding three rows: one comparable, one at another
 * protocolVersion, one scored under other weights. The shipped corpus has a single row, so it
 * could never demonstrate that the two exclusions happen in the page rather than only in a unit
 * test.
 *
 * Set PLAYWRIGHT_MODULE to a playwright install. This repo ships zero dependencies and keeps to
 * that: playwright is a harness dependency.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TYPES = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html",
  ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css",
  ".woff2": "font/woff2",
};

const COMPARABLE = "Comparable device";
const OTHER_PROTOCOL = "Other protocol device";
const REWEIGHTED = "Reweighted device";

function detected(renderer) {
  return {
    browser: { name: "Example Browser", majorVersion: 1 },
    osFamily: "Example OS",
    reportedConcurrency: { value: 4, unit: "logical processors" },
    measuredParallelism: { value: 3, unit: "workers" },
    gpuRenderer: renderer,
    devicePixelRatio: { value: 2, unit: "ratio" },
  };
}

function entry(label, { protocolVersion, scoringVersion, score }) {
  return {
    kind: "scored",
    schemaVersion: 1,
    protocolVersion,
    scoringVersion,
    baselineVersion: 1,
    previewMode: "standard",
    capturedMonth: "2026-08",
    detected: detected(label + " renderer"),
    label: { value: label, claimed: true },
    score: { value: score, unit: "BenchDev points" },
    subScores: [
      { id: "cpuJsSingleThreadThroughput", value: score, unit: "BenchDev points" },
      { id: "cpuWasmSingleThreadThroughput", value: score, unit: "BenchDev points" },
      { id: "cpuParallelThroughput", value: score, unit: "BenchDev points" },
      { id: "gpuSustainedWorkRate", value: score, unit: "BenchDev points" },
    ],
  };
}

async function currentVersions() {
  const [result, scoring] = await Promise.all([
    import(pathToFileURL(join(ROOT, "src/result.js")).href),
    import(pathToFileURL(join(ROOT, "src/scoring.js")).href),
  ]);
  return {
    protocolVersion: result.BENCHMARK_PROTOCOL_VERSION,
    scoringVersion: scoring.SCORING_VERSION,
  };
}

function fixtureCorpus({ protocolVersion, scoringVersion }) {
  return {
    schemaVersion: 1,
    corpusVersion: 1,
    buildMonth: "2026-08",
    entries: [
      // Deliberately first in the file and highest scoring, so a table that echoed file order,
      // or failed to exclude them, would put them at the top where it cannot be missed.
      entry(REWEIGHTED, { protocolVersion, scoringVersion: scoringVersion + 1, score: 999 }),
      entry(OTHER_PROTOCOL, { protocolVersion: protocolVersion + 1, scoringVersion, score: 998 }),
      entry(COMPARABLE, { protocolVersion, scoringVersion, score: 42 }),
    ],
  };
}

function startServer(corpusBody) {
  const corpusRequests = { count: 0 };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      if (path === "/corpus.json") {
        corpusRequests.count += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(corpusBody);
        return;
      }
      const target = normalize(join(ROOT, decodeURIComponent(path)));
      if (!target.startsWith(ROOT)) {
        res.writeHead(403).end("no");
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({
    server, port: server.address().port, corpusRequests,
  })));
}

const failures = [];
function check(name, condition, detail) {
  const ok = Boolean(condition);
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + (detail ? " · " + detail : ""));
  if (!ok) failures.push(name);
}

async function main() {
  const versions = await currentVersions();
  const corpusBody = JSON.stringify(fixtureCorpus(versions));
  const { server, port, corpusRequests } = await startServer(corpusBody);

  const configured = process.env.PLAYWRIGHT_MODULE ?? "playwright";
  const spec = existsSync(configured) ? pathToFileURL(
    statSync(configured).isDirectory() ? join(configured, "index.js") : configured,
  ).href : configured;
  const loaded = await import(spec);
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  if (!chromium) throw new Error("could not resolve chromium from " + spec);

  const browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    args: ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"],
  });

  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("   [page error]", e.message));

    await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "load" });
    await page.getByRole("button", { name: "Run device benchmark" }).click();
    await page.getByRole("button", { name: /^Start the \d+-second test$/u }).click();

    // A Quick run is about 25 s. Wait for the table itself rather than sleeping a fixed time,
    // and give the run generous headroom: a slow machine finishing late is not a T9 failure.
    const table = page.locator("table.comparison-table");
    await table.waitFor({ state: "attached", timeout: 180000 }).catch(() => {});

    if (await table.count() === 0) {
      // 🔴 An unscored run has no result screen and therefore no table. That is NOT a pass, and
      // it is NOT a T9 failure either: it is a run that could not test T9. Say so and exit 2.
      const message = await page.locator("#screen").innerText().catch(() => "(no screen text)");
      console.log("\n  UNVERIFIED · the run produced no comparison table.");
      console.log("  Screen said:");
      console.log(message.split("\n").slice(0, 12).map((l) => "    " + l).join("\n"));
      process.exitCode = 2;
      return;
    }

    const rows = page.locator("table.comparison-table tbody tr");
    const rowCount = await rows.count();
    const bodyText = await table.innerText();
    const firstRowIsCurrent = await rows.first().evaluate(
      (node) => node.classList.contains("current-comparison-row"),
    );
    const currentRowCount = await page.locator("tr.current-comparison-row").count();
    const detectedCells = await page.locator("td.comparison-detected").count();

    check("corpus.json is requested exactly once", corpusRequests.count === 1,
      corpusRequests.count + " request(s)");
    check("the table holds the current run plus the one comparable device", rowCount === 2,
      rowCount + " row(s)");
    check("the current run is the first row, and the only current row",
      firstRowIsCurrent && currentRowCount === 1,
      "first=" + firstRowIsCurrent + " current rows=" + currentRowCount);
    check("the comparable corpus device is shown", bodyText.includes(COMPARABLE));
    check("a device at another protocolVersion is absent", !bodyText.includes(OTHER_PROTOCOL));
    check("a device scored under other weights is absent", !bodyText.includes(REWEIGHTED));
    check("every row separates the claimed label from the detected facts",
      detectedCells === rowCount, detectedCells + " detected cell(s)");
  } finally {
    await browser.close();
    server.close();
  }

  console.log("\n" + failures.length + " FAILED");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("harness error:", error?.stack ?? error);
  process.exitCode = 3;
});
