import assert from "node:assert/strict";
import test from "node:test";

import {
  browserIdentity,
  copyForReason,
  createConsentSession,
  formatElapsed,
  formatScore,
  referenceLandmark,
  RUN_LENGTHS,
  RUN_STOPPED_COPY,
  scoreAxisPosition,
  screenForState,
  UNSCORED_REASON_COPY,
} from "../src/ui/model.js";
import { BASELINES } from "../src/baselines.js";
import { BENCHMARK_PROTOCOL_VERSION } from "../src/result.js";
import { INVALIDATION_CONDITIONS } from "../src/validity.js";
import { CPU_SINGLE_THREAD_BUDGET_MS } from "../src/workloads/cpu-timing.js";
import { CPU_PARALLELISM_RAMP_BUDGET_MS } from "../src/workloads/cpu-parallelism.js";
import { GPU_MEASUREMENT_BUDGET_MS } from "../src/workloads/gpu.js";
import {
  SUSTAINED_LOAD_DURATION_MS,
  RECOVERY_IDLE_DURATION_MS,
  RECOVERY_PROBE_DURATION_MS,
} from "../src/sustained.js";

test("every UI state and terminal outcome maps to one of the five screens", () => {
  assert.deepEqual(
    ["idle", "consent", "running", "result", "unscored"].map(screenForState),
    ["idle", "consent", "running", "result", "unscored"],
  );
  assert.equal(screenForState("scored"), "result");
  assert.equal(screenForState("invalid"), "unscored");
  assert.equal(screenForState("failed"), "unscored");
  assert.throws(() => screenForState("error"), /Unknown UI state/);
});

test("consent is remembered per page session and independently per run length", () => {
  const session = createConsentSession();

  assert.equal(session.requestRun(), "consent");
  assert.equal(session.grantConsent(), "running");
  session.back();
  assert.equal(session.requestRun(), "running");

  session.select("full");
  assert.equal(session.requestRun(), "consent");
  assert.equal(session.wasConsented("quick"), true);
  assert.equal(session.wasConsented("full"), false);
  session.grantConsent();

  session.select("quick");
  assert.equal(session.requestRun(), "running");
});

test("every central validity reason has complete neutral unscored copy", () => {
  assert.deepEqual(
    Object.keys(UNSCORED_REASON_COPY).sort(),
    INVALIDATION_CONDITIONS.map(({ id }) => id).sort(),
  );

  for (const { id } of INVALIDATION_CONDITIONS) {
    const copy = copyForReason(id);
    assert.equal(typeof copy.headline, "string");
    assert.equal(typeof copy.mechanism, "string");
    assert.equal(typeof copy.action, "string");
    assert.equal([copy.headline, copy.mechanism, copy.action].every((text) => text.length > 0), true);
    assert.equal(/\b(?:failed|please|sorry|unfortunately|invalid)\b/i.test(Object.values(copy).join(" ")), false);
    assert.equal(/\byou\b/i.test(Object.values(copy).join(" ")), false);
    assert.equal(/[—–]/.test(Object.values(copy).join(" ")), false);
  }

  const stoppedText = Object.values(RUN_STOPPED_COPY).join(" ");
  assert.equal(/\b(?:you|failed|please|sorry|unfortunately|invalid)\b/i.test(stoppedText), false);
});

test("score formatting preserves one through four digits and the axis remains bounded", () => {
  assert.equal(formatScore(1), "1");
  assert.equal(formatScore(100.4), "100");
  assert.equal(formatScore(9999), "9999");
  assert.equal(scoreAxisPosition(100), 50);
  assert.equal(scoreAxisPosition(50) < 50, true);
  assert.equal(scoreAxisPosition(200) > 50, true);
  assert.equal(scoreAxisPosition(9999) <= 96, true);
});

test("elapsed time and named reference labels are deterministic", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(68_999), "01:08");
  assert.match(
    referenceLandmark(BASELINES, BENCHMARK_PROTOCOL_VERSION),
    /^100 = Desktop: AMD Ryzen 7 5800X3D.*2026-08$/,
  );
});

test("browser identity retains only a name and major version", () => {
  assert.deepEqual(
    browserIdentity({ userAgent: "Mozilla/5.0 Version/18.6 Safari/605.1.15" }),
    { name: "Safari", version: "18" },
  );
  assert.deepEqual(
    browserIdentity({
      userAgentData: {
        brands: [
          { brand: "Not A Brand", version: "99" },
          { brand: "Chromium", version: "149.0.1" },
          { brand: "Google Chrome", version: "149.0.2" },
        ],
      },
    }),
    { name: "Google Chrome", version: "149" },
  );
});

// 🔴 NOTHING GUARDED THE ADVERTISED RUN LENGTH, WHICH IS WHY IT DRIFTED. "20 seconds" was
// written when the CPU phase held one single-thread workload. Wiring the WASM kernel added a second
// five-second budget, nothing recomputed the label, and the consent screen promised 20 seconds for
// a run measured at 23.6 s in a real browser. All 80 tests passed straight through that.
//
// ⚠️ MY FIRST VERSION OF THIS GUARD WAS CIRCULAR AND I CAUGHT IT BY SABOTAGE. It asserted the
// advertised length was at least the sum of the measurement budgets, and the sum is exactly 20 s,
// so re-typing the old wrong number passed. A guard derived from the same formula as the value it
// checks cannot fail.
//
// So it is anchored to WALL-CLOCK TIME MEASURED IN A REAL BROWSER instead. Those numbers come from
// outside the code and the code cannot argue with them. The consent screen exists so someone can
// agree to a known thermal cost; being 18% short is that screen failing at its only job.
const MEASURED_WALL_CLOCK_SECONDS = Object.freeze({
  // Reference device, 2026-08-28, headless Chromium: Quick timed 23.5, 23.5, 23.6 and 23.8;
  // Full timed 72.5. Re-measure with tests/browser and update these if the protocol changes.
  quick: 23.8,
  full: 72.5,
});

test("the advertised run length covers what the person actually waits", () => {
  for (const [id, measured] of Object.entries(MEASURED_WALL_CLOCK_SECONDS)) {
    const advertised = RUN_LENGTHS[id].seconds;
    assert.ok(
      advertised >= measured,
      `${id} advertises ${advertised}s but a real browser took ${measured}s`,
    );
    assert.ok(
      advertised <= measured + 15,
      `${id} advertises ${advertised}s against a measured ${measured}s, which over-promises`,
    );
    assert.match(RUN_LENGTHS[id].durationLabel, /^about \d+ seconds$/);
  }
});

test("the advertised run length is derived, not typed", () => {
  // Every measurement budget in the protocol has to be inside the advertised number, so adding a
  // workload cannot silently leave the label behind. This is the check that was missing.
  const quickBudget = (CPU_SINGLE_THREAD_BUDGET_MS * 2)
    + CPU_PARALLELISM_RAMP_BUDGET_MS
    + GPU_MEASUREMENT_BUDGET_MS;
  const fullBudget = quickBudget
    + SUSTAINED_LOAD_DURATION_MS
    + RECOVERY_IDLE_DURATION_MS
    + RECOVERY_PROBE_DURATION_MS;
  assert.ok(RUN_LENGTHS.quick.seconds > quickBudget / 1000,
    "quick must allow for real overhead beyond its measurement budgets");
  assert.ok(RUN_LENGTHS.full.seconds > fullBudget / 1000,
    "full must allow for real overhead beyond its measurement budgets");
});

// 🔴 THE SAME LIE APPEARED IN THREE PLACES AND I FIXED THEM ONE AT A TIME. The consent button, the
// consent prose beside it, and the sustained-phase narration each had a duration typed into them.
// Fixing the button left the prose next to it still saying the old number, on the same screen.
//
// So this reads the source and refuses a literal duration inside a user-facing string. It is a
// crude check and it is the one that would have caught all three at once.
test("no user-facing string hardcodes a duration", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  // ⚠️ DOCUMENTS COUNT TOO, and leaving them out let a FOURTH stale duration survive. The
  // README still said "about 20 seconds" after the code was fixed, in the surface a reader sees
  // first. This project already learned that exact lesson once as UX-03, where PLAN and RESEARCH
  // were corrected and the README was never swept.
  const roots = ["src", "src/ui", "."];
  // Every duration a document may legitimately quote: the two advertised run lengths and the
  // sustained phase. Anything else in an "about N seconds" phrase has drifted.
  const allowedDurations = new Set([
    RUN_LENGTHS.quick.seconds,
    RUN_LENGTHS.full.seconds,
    Math.round(SUSTAINED_LOAD_DURATION_MS / 1000),
  ]);
  const offenders = [];

  for (const dir of roots) {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".js") && !name.endsWith(".md")) continue;
      if (name === "USER-GUIDE.md") continue; // prose for people, where a spelled duration is the point
      const text = await readFile(join(dir, name), "utf8");
      text.split("\n").forEach((line, n) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;               // comments may cite the history
        // ⚠️ DOCUMENTS ARE DIFFERENT FROM CODE. A README cannot interpolate, and stating the
        // run length in prose is exactly what it is for, so "no duration here" is the wrong rule
        // and my first version of this failed on the CORRECT value. What matters is whether a
        // document DISAGREES with the protocol, so only run-length phrasings are checked, against
        // the live numbers.
        if (name.endsWith(".md")) {
          for (const [, spoken] of line.matchAll(/about\s+\*{0,2}(\d+)\s*seconds?/gi)) {
            if (!allowedDurations.has(Number(spoken))) {
              offenders.push(`${dir}/${name}:${n + 1}  says "about ${spoken} seconds"`);
            }
          }
          return;
        }

        const strings = line.match(/(["'`])(?:\.|(?!).)*/g) ?? [];

        for (const lit of strings) {
          // A template literal interpolating the value is exactly the fix, so allow it.
          if (lit.startsWith("`") && lit.includes("${")) continue;
          if (/\b\d+\s*(seconds?|minutes?)\b/i.test(lit)) {
            offenders.push(`${dir}/${name}:${n + 1}  ${lit.slice(0, 70)}`);
          }
        }
      });
    }
  }

  assert.deepEqual(offenders, [],
    `a duration is typed into user-facing copy instead of derived:\n  ${offenders.join("\n  ")}`);
});
