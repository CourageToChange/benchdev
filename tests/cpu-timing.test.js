import assert from "node:assert/strict";
import test from "node:test";

import {
  calibrateWorkUnit,
  measureFixedBudgetWorkload,
  warmUpWorkload,
} from "../src/workloads/cpu-timing.js";
import { evaluateValidity } from "../src/validity.js";

function checksum(actual = 7, expected = 7) {
  return [{ id: "test-kernel", actual, expected }];
}

function validityReadings(workloadChecksums) {
  const cadence = Array.from({ length: 20 }, (_, index) => index * 16.67);
  const hash = "a".repeat(64);

  return {
    visibilityStates: ["visible"],
    idleCadence: {
      beforeTimestamps: cadence,
      afterTimestamps: cadence,
    },
    webgl: {
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: "NVIDIA GeForce RTX 4060",
      contextLossEvents: [],
    },
    workloadChecksums,
    timer: {
      samples: [0, 1],
      shortestWorkUnitMs: 5,
    },
    parallelism: {
      reportedConcurrency: 8,
      measuredConcurrency: 8,
    },
    phaseEvents: [{ phaseId: "cpu", type: "completed" }],
    wasm: {
      actualSha256: hash,
      expectedSha256: hash,
    },
  };
}

test("fixed-budget timing discards warm-up and reads the clock once per measured work unit", () => {
  const timestamps = [100, 104, 108, 112];
  let clockReads = 0;
  let executions = 0;

  const result = measureFixedBudgetWorkload({
    runWorkUnit() {
      executions += 1;
      return checksum();
    },
    readNow() {
      const timestamp = timestamps[clockReads];
      clockReads += 1;
      return timestamp;
    },
    budgetMs: 10,
    warmupWorkUnits: 2,
  });

  assert.equal(result.workUnits, 3);
  assert.equal(result.completedWork, 3);
  assert.equal(executions, 5);
  assert.equal(clockReads, result.workUnits + 1);
  assert.equal(result.elapsedMs, 12);
  assert.equal(result.throughput, 250);
  assert.equal(result.throughputUnit, "work units/second");
  assert.equal(result.workloadChecksums.filter(({ stage }) => stage === "warmup").length, 2);
  assert.equal(result.workloadChecksums.filter(({ stage }) => stage === "measured").length, 3);
});

test("calibration scales once toward the band midpoint and discards its sample", () => {
  const timestamps = [20, 24];
  let calibrationRuns = 0;
  let requestedScale = null;
  const calibrated = calibrateWorkUnit({
    runCalibrationWorkUnit() {
      calibrationRuns += 1;
      return checksum(99, 99);
    },
    createScaledWorkUnit(scale) {
      requestedScale = scale;
      return Object.freeze({ marker: "fixed-after-calibration" });
    },
    readNow: () => timestamps.shift(),
  });

  assert.equal(calibrationRuns, 1);
  assert.equal(requestedScale, 7.5 / 4);
  assert.deepEqual(calibrated, { marker: "fixed-after-calibration" });
  assert.equal("workloadChecksums" in calibrated, false);
  assert.equal("calibrationDurationMs" in calibrated, false);
});

test("weighted calibrated units preserve protocol work in throughput", () => {
  const timestamps = [0, 7.5, 15];
  const result = measureFixedBudgetWorkload({
    runWorkUnit: () => checksum(),
    readNow: () => timestamps.shift(),
    budgetMs: 10,
    warmupWorkUnits: 0,
    workAmountPerUnit: 1.875,
  });

  assert.equal(result.workUnits, 2);
  assert.equal(result.completedWork, 3.75);
  assert.equal(result.throughput, 250);
});

test("checksum evidence from warm-up and measurement is retained for validity.js", () => {
  const timestamps = [0, 6];
  let execution = 0;
  const result = measureFixedBudgetWorkload({
    runWorkUnit() {
      execution += 1;
      return execution === 1 ? checksum(8, 7) : checksum();
    },
    readNow: () => timestamps.shift(),
    budgetMs: 5,
    warmupWorkUnits: 1,
  });

  assert.notEqual(
    result.workloadChecksums[0].actual,
    result.workloadChecksums[0].expected,
  );
  assert.equal(result.workloadChecksums[0].stage, "warmup");
  assert.equal(result.workloadChecksums[1].stage, "measured");
  assert.deepEqual(
    evaluateValidity(validityReadings(result.workloadChecksums)).reasons,
    ["workload-checksum-mismatch"],
  );
});

test("parallel workers can warm up before the barrier and measure without warming again", () => {
  let executions = 0;
  const runWorkUnit = () => {
    executions += 1;
    return checksum();
  };
  const warmupChecksums = warmUpWorkload({
    runWorkUnit,
    warmupWorkUnits: 2,
  });
  const timestamps = [0, 6];
  const measurement = measureFixedBudgetWorkload({
    runWorkUnit,
    readNow: () => timestamps.shift(),
    budgetMs: 5,
    warmupWorkUnits: 0,
  });

  assert.equal(executions, 3);
  assert.equal(warmupChecksums.length, 2);
  assert.equal(measurement.workUnits, 1);
  assert.equal(measurement.workloadChecksums.length, 1);
  assert.equal(measurement.workloadChecksums[0].stage, "measured");
});

test("invalid timing configuration cannot produce plausible throughput", () => {
  assert.throws(
    () => measureFixedBudgetWorkload({
      runWorkUnit: () => checksum(),
      readNow: () => 5,
      budgetMs: 0,
      warmupWorkUnits: 1,
    }),
    /budgetMs/,
  );
});
