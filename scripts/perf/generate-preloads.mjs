// Regenerate index.html's <link rel="modulepreload"> list from the REAL import graph.
//
// 🔴 A HAND-WRITTEN PRELOAD LIST ROTS THE FIRST TIME SOMEONE ADDS AN IMPORT, and it rots silently:
// the page still works, it just quietly returns to a multi-wave waterfall on a slow link, which is
// invisible on localhost. So the list is generated, and `npm run check:preloads` fails if the file
// no longer matches the graph.
//
// Run after adding or removing a module:  node scripts/perf/generate-preloads.mjs
// Check without writing:                  node scripts/perf/generate-preloads.mjs --check
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ENTRY = "src/ui/app-browser.js";
const seen = new Set();
const order = [];

async function walk(path) {
  if (seen.has(path)) return;
  seen.add(path);
  order.push(path);
  let text;
  try { text = await readFile(path, "utf8"); } catch { return; }
  for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = normalize(join(dirname(path), m[1])).split(String.fromCharCode(92)).join("/");
    if (target.endsWith(".js") && existsSync(target)) await walk(target);
  }
}
await walk(ENTRY);

if (order.length < 2) {
  console.error(`REFUSING: walked ${order.length} modules from ${ENTRY}, which means the walk failed`);
  process.exit(1);
}

const links = order.slice(1).map((p) => `  <link rel="modulepreload" href="./${p}">`).join("\n");
const html = await readFile("index.html", "utf8");
const start = html.indexOf('  <link rel="modulepreload"');
const lastLink = html.lastIndexOf('  <link rel="modulepreload"');
const end = html.indexOf("\n", lastLink);

if (start === -1) {
  console.error("REFUSING: no modulepreload block found in index.html to replace");
  process.exit(1);
}

const updated = html.slice(0, start) + links + html.slice(end);
const current = html.slice(start, end);

if (process.argv.includes("--check")) {
  if (current !== links) {
    console.error(`index.html's preload list does not match the ${order.length - 1} imported`
      + " modules. Run: node scripts/perf/generate-preloads.mjs");
    process.exit(1);
  }
  console.log(`preload list matches the import graph (${order.length - 1} modules)`);
  process.exit(0);
}

await writeFile("index.html", updated, "utf8");
console.log(`wrote ${order.length - 1} modulepreload links from the real import graph`);
