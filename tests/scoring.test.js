import assert from "node:assert/strict";
import test from "node:test";

import { BASELINES } from "../src/baselines.js";
import { calculateScore, SCORE_FACTORS } from "../src/scoring.js";

const UNIT = "work units/second";
const FACTOR_IDS = SCORE_FACTORS.map(({ id }) => id);

function measurement(value) {
  return value === null ? { value: null, unit: UNIT } : { value, unit: UNIT };
}

function baseline(values, protocolVersion = 5) {
  return {
    baselineVersion: 1,
    entries: [{
      id: "test-reference",
      protocolVersion,
      measurements: Object.fromEntries(
        FACTOR_IDS.map((id) => [id, measurement(values[id] ?? null)]),
      ),
    }],
  };
}

function device(values) {
  return Object.fromEntries(
    FACTOR_IDS.map((id) => [id, measurement(values[id] ?? null)]),
  );
}

test("an unbalanced device scores below a balanced one at equal arithmetic mean", () => {
  const reference = baseline({
    cpuJsSingleThreadThroughput: 100,
    cpuWasmSingleThreadThroughput: 100,
  });
  const balanced = calculateScore({
    baselineSet: reference,
    protocolVersion: 5,
    measurements: device({
      cpuJsSingleThreadThroughput: 100,
      cpuWasmSingleThreadThroughput: 100,
    }),
  });
  const unbalanced = calculateScore({
    baselineSet: reference,
    protocolVersion: 5,
    measurements: device({
      cpuJsSingleThreadThroughput: 50,
      cpuWasmSingleThreadThroughput: 150,
    }),
  });

  assert.equal((50 + 150) / 2, (100 + 100) / 2);
  assert.equal(balanced.score.value, 100);
  assert.equal(unbalanced.score.value, 87);
  assert.ok(unbalanced.score.value < balanced.score.value);
});

test("a missing sub-score changes the score label and never becomes zero", () => {
  const reference = baseline(Object.fromEntries(FACTOR_IDS.map((id) => [id, 100])));
  const complete = calculateScore({
    baselineSet: reference,
    protocolVersion: 5,
    measurements: device(Object.fromEntries(FACTOR_IDS.map((id) => [id, 100]))),
  });
  const cpuOnly = calculateScore({
    baselineSet: reference,
    protocolVersion: 5,
    measurements: device({
      cpuJsSingleThreadThroughput: 143,
      cpuWasmSingleThreadThroughput: 143,
      cpuParallelThroughput: 143,
    }),
  });
  const verySlowCpuOnly = calculateScore({
    baselineSet: reference,
    protocolVersion: 5,
    measurements: device({
      cpuJsSingleThreadThroughput: 0.1,
    }),
  });

  assert.equal(complete.score.label, "100 (CPU JS+CPU WASM+CPU parallel+GPU)");
  assert.equal(cpuOnly.score.label, "143 (CPU JS+CPU WASM+CPU parallel)");
  assert.notEqual(cpuOnly.score.label, complete.score.label);
  assert.equal(cpuOnly.score.value, 143);
  assert.equal(verySlowCpuOnly.score.value, 1);
  assert.deepEqual(cpuOnly.omittedSubScores, [
    { id: "gpuSustainedWorkRate", reason: "measurement-missing" },
  ]);
});

// ⚠️ THIS USED TO ASSERT AGAINST THE SHIPPED BASELINES, which had no parallel entry, so it was
// testing a temporary state of the data rather than a rule of the scoring. The moment that entry
// was measured the test failed, which told me nothing about the behaviour it was named for.
// It now builds a baseline set with a deliberate hole, so it tests the rule and survives the data.
test("a missing baseline omits the sub-score instead of fabricating a reference", () => {
  const holed = baseline({
    cpuJsSingleThreadThroughput: 100,
    cpuWasmSingleThreadThroughput: 100,
    gpuSustainedWorkRate: 100,
  });
  const scored = calculateScore({
    baselineSet: holed,
    protocolVersion: 5,
    measurements: device({
      cpuJsSingleThreadThroughput: 100,
      cpuWasmSingleThreadThroughput: 100,
      cpuParallelThroughput: 1_231,
      gpuSustainedWorkRate: 100,
    }),
  });

  assert.equal(scored.score.value, 100);
  assert.equal(scored.score.label, "100 (CPU JS+CPU WASM+GPU)");
  assert.deepEqual(scored.omittedSubScores, [
    { id: "cpuParallelThroughput", reason: "baseline-missing" },
  ]);
  // The absent factor's weight is renormalised across the rest, never substituted.
  assert.ok(!Object.keys(scored.effectiveWeights).includes("cpuParallelThroughput"));
});

test("the sustained ratio is returned beside the score and cannot move its value", () => {
  const reference = baseline({ cpuJsSingleThreadThroughput: 100 });
  const common = {
    baselineSet: reference,
    protocolVersion: 5,
    measurements: device({ cpuJsSingleThreadThroughput: 143 }),
  };
  const lowerRatio = calculateScore({ ...common, sustainedToPeakRatio: 0.55 });
  const higherRatio = calculateScore({ ...common, sustainedToPeakRatio: 0.99 });

  assert.equal(lowerRatio.score.value, 143);
  assert.equal(higherRatio.score.value, 143);

  // 🔴 THE LABEL IS WHAT A PERSON ACTUALLY READS, so it needs its own assertion. Found by
  // sabotage on 2026-08-28: folding the sustained ratio into the LABEL alone left all 74 tests
  // green, because this test only ever checked `score.value`. A score of 143 displayed as "79"
  // beside an unchanged value is precisely the failure the ticket forbids, and nothing saw it.
  assert.equal(lowerRatio.score.label, higherRatio.score.label);
  assert.match(lowerRatio.score.label, /^143 \(/);
  assert.deepEqual(lowerRatio.modifier, {
    id: "sustained-to-peak",
    value: 0.55,
    unit: "ratio",
  });
  assert.equal(higherRatio.modifier.value, 0.99);
});

// 🔴 REPLACED 2026-08-28, AND THE REASON IS THE FINDING. This test encoded a 22 to 25% spread
// in the parallel workload, measured by tests/browser/measure-baseline.js, and asserted the score
// would swing seven points if that number were ever baselined.
//
// Gate 4 (ARCH-08) spotted that the harness gives each workload its OWN runner, so its workers are
// terminated between workloads, while a real run keeps all four in one scope. Measured through the
// APPLICATION instead, across eleven runs, the same workload spreads **1.6 to 1.7%**. The variance
// was the harness. My settle experiment, and its confident conclusion that a settle does not fix
// it, was answering a question about my own measuring apparatus.
//
// What survives is the rule the old test was reaching for: run-to-run variation in one measurement
// must not move the score more than that variation justifies.
test("run-to-run variation moves the score roughly in proportion, not wildly", () => {
  const observed = [1_187, 1_220, 1_241, 1_233, 1_227, 1_236];
  const reference = baseline({
    cpuJsSingleThreadThroughput: 212.9,
    cpuWasmSingleThreadThroughput: 590.2,
    cpuParallelThroughput: 1_232.6,
    gpuSustainedWorkRate: 231_917,
  });
  const scores = observed.map((cpuParallelThroughput) => calculateScore({
    baselineSet: reference,
    protocolVersion: 5,
    measurements: device({
      cpuJsSingleThreadThroughput: 212.9,
      cpuWasmSingleThreadThroughput: 590.2,
      cpuParallelThroughput,
      gpuSustainedWorkRate: 231_917,
    }),
  }).score.value);

  const spread = Math.max(...scores) - Math.min(...scores);
  assert.ok(spread <= 3,
    `a 1.7% input spread moved the score by ${spread} points: ${scores.join(", ")}`);
});

test("scoring requires one baseline from the same benchmark protocol", () => {
  assert.throws(
    () => calculateScore({
      baselineSet: baseline({ cpuJsSingleThreadThroughput: 100 }, 4),
      protocolVersion: 5,
      measurements: device({ cpuJsSingleThreadThroughput: 100 }),
    }),
    /Exactly one baseline entry must match the benchmark protocol/,
  );
});
