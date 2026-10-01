import assert from "node:assert/strict";
import test from "node:test";

import {
  CPU_PARALLELISM_POOL_SIZES,
  CPU_PARALLELISM_STEP_BUDGET_MS,
  measureCpuParallelismRamp,
} from "../src/workloads/cpu-parallelism.js";
import { evaluateValidity } from "../src/validity.js";

const HASH = "a".repeat(64);
const WORK_UNIT_CONFIGURATION = Object.freeze({
  scaleTicks: 1_000,
  scaleDenominator: 1_000,
  workAmount: 1,
  integerIterations: 1_250_000,
  floatIterations: 400_000,
  expectedChecksums: Object.freeze({ integer: 7, float: 7 }),
});

function clock(stepElapsedMs = 1_000) {
  let timestamp = 0;
  let start = true;

  return () => {
    if (start) {
      start = false;
      return timestamp;
    }

    timestamp += stepElapsedMs;
    start = true;
    return timestamp;
  };
}

function checksum(stage) {
  return [{
    id: "cpu-js-test",
    actual: 7,
    expected: 7,
    stage,
    workUnit: 1,
  }];
}

function validityReadings(parallelism, workloadChecksums) {
  const cadence = Array.from({ length: 20 }, (_, index) => index * 16.67);

  return {
    visibilityStates: ["visible"],
    idleCadence: {
      beforeTimestamps: cadence,
      afterTimestamps: cadence,
    },
    webgl: {
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: "Example GPU",
      contextLossEvents: [],
    },
    workloadChecksums,
    timer: { samples: [0, 1], shortestWorkUnitMs: 5 },
    parallelism,
    phaseEvents: [{ phaseId: "cpu-parallelism", type: "completed" }],
    wasm: { actualSha256: HASH, expectedSha256: HASH },
  };
}

function fabricatedFactory({ unitsByPool, onCreate = () => {} }) {
  const handles = [];

  return {
    handles,
    create({ poolSize, workerIndex }) {
      onCreate({ poolSize, workerIndex, handles });
      const handle = {
        poolSize,
        workerIndex,
        prepared: false,
        disposed: false,
        async prepare({ workUnitConfiguration }) {
          handle.prepared = true;
          return {
            workloadChecksums: checksum("warmup"),
            workUnitConfiguration: workUnitConfiguration ?? WORK_UNIT_CONFIGURATION,
          };
        },
        async measure() {
          assert.equal(handle.prepared, true);
          return {
            workUnits: unitsByPool[poolSize],
            completedWork: unitsByPool[poolSize],
            workloadChecksums: checksum("measured"),
          };
        },
        async dispose() {
          handle.disposed = true;
        },
      };
      handles.push(handle);
      return handle;
    },
  };
}

test("the fixed 1/2/4/8 ramp aggregates worker units and selects peak throughput", async () => {
  const factory = fabricatedFactory({
    unitsByPool: { 1: 10, 2: 9, 4: 6, 8: 2 },
  });
  const result = await measureCpuParallelismRamp({
    workerFactory: factory.create,
    readNow: clock(),
    reportedConcurrency: 2,
  });

  assert.deepEqual(CPU_PARALLELISM_POOL_SIZES, [1, 2, 4, 8]);
  assert.deepEqual(
    result.steps.map(({ poolSize, workUnits, aggregateThroughput }) => ({
      poolSize,
      workUnits,
      aggregateThroughput,
    })),
    [
      { poolSize: 1, workUnits: 10, aggregateThroughput: 10 },
      { poolSize: 2, workUnits: 18, aggregateThroughput: 18 },
      { poolSize: 4, workUnits: 24, aggregateThroughput: 24 },
      { poolSize: 8, workUnits: 16, aggregateThroughput: 16 },
    ],
  );
  assert.equal(result.peakAggregateThroughput, 24);
  assert.equal(result.peakPoolSize, 4);
  assert.equal(result.measuredConcurrency, 4);
  assert.equal(result.scalingFactor, 2.4);
  assert.equal(result.throughputUnit, "work units/second");
});

test("all workers cross the readiness barrier before a measurement starts", async () => {
  const blockedPreparations = [];
  let measureCalls = 0;

  const run = measureCpuParallelismRamp({
    workerFactory({ poolSize }) {
      return {
        prepare({ workUnitConfiguration }) {
          if (poolSize !== 2) {
            return Promise.resolve({
              workloadChecksums: checksum("warmup"),
              workUnitConfiguration: workUnitConfiguration ?? WORK_UNIT_CONFIGURATION,
            });
          }

          return new Promise((resolve) => blockedPreparations.push(resolve));
        },
        async measure() {
          measureCalls += 1;
          return {
            workUnits: 1,
            completedWork: 1,
            workloadChecksums: checksum("measured"),
          };
        },
        async dispose() {},
      };
    },
    readNow: clock(),
    reportedConcurrency: 4,
  });

  while (blockedPreparations.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(measureCalls, 1, "the pool-of-1 step should have completed first");
  blockedPreparations[0]({
    workloadChecksums: checksum("warmup"),
    workUnitConfiguration: WORK_UNIT_CONFIGURATION,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeFullBarrier = measureCalls;
  blockedPreparations[1]({
    workloadChecksums: checksum("warmup"),
    workUnitConfiguration: WORK_UNIT_CONFIGURATION,
  });

  await run;
  assert.equal(
    callsBeforeFullBarrier,
    1,
    "one ready worker must not release the pool-of-2 barrier",
  );
  assert.equal(measureCalls, 15);
});

test("each pool is disposed through its handles before the next ramp step", async () => {
  let previousPool = [];
  let currentPoolSize = null;
  const factory = fabricatedFactory({
    unitsByPool: { 1: 1, 2: 1, 4: 1, 8: 1 },
    onCreate({ poolSize, handles }) {
      if (poolSize !== currentPoolSize) {
        assert.equal(previousPool.every(({ disposed }) => disposed), true);
        previousPool = handles.filter((handle) => handle.poolSize === currentPoolSize);
        assert.equal(previousPool.every(({ disposed }) => disposed), true);
        currentPoolSize = poolSize;
      }
    },
  });

  await measureCpuParallelismRamp({
    workerFactory: factory.create,
    readNow: clock(),
    reportedConcurrency: null,
  });

  assert.equal(factory.handles.length, 15);
  assert.equal(factory.handles.every(({ disposed }) => disposed), true);
});

test("the deliberately serialised control uses the same ramp with one effective worker", async () => {
  let activeMeasurements = 0;
  let maximumActiveMeasurements = 0;

  const result = await measureCpuParallelismRamp({
    workerFactory() {
      return {
        async prepare({ workUnitConfiguration }) {
          return {
            workloadChecksums: checksum("warmup"),
            workUnitConfiguration: workUnitConfiguration ?? WORK_UNIT_CONFIGURATION,
          };
        },
        async measure({ budgetMs }) {
          activeMeasurements += 1;
          maximumActiveMeasurements = Math.max(maximumActiveMeasurements, activeMeasurements);
          await Promise.resolve();
          activeMeasurements -= 1;
          return {
            workUnits: budgetMs / 156.25,
            completedWork: budgetMs / 156.25,
            workloadChecksums: checksum("measured"),
          };
        },
        async dispose() {},
      };
    },
    readNow: clock(CPU_PARALLELISM_STEP_BUDGET_MS),
    reportedConcurrency: 8,
    effectiveWorkerLimit: 1,
  });

  assert.equal(maximumActiveMeasurements, 1);
  assert.deepEqual(result.steps.map(({ effectiveWorkers }) => effectiveWorkers), [1, 1, 1, 1]);
  assert.deepEqual(result.steps.map(({ aggregateThroughput }) => aggregateThroughput), [6.4, 6.4, 6.4, 6.4]);
  assert.equal(result.scalingFactor, 1);
});

test("reported and measured concurrency flow into validity's existing divergence note", async () => {
  const factory = fabricatedFactory({
    unitsByPool: { 1: 10, 2: 10, 4: 8, 8: 3 },
  });
  const result = await measureCpuParallelismRamp({
    workerFactory: factory.create,
    readNow: clock(),
    reportedConcurrency: 2,
  });
  const validity = evaluateValidity(validityReadings(
    result.parallelism,
    result.workloadChecksums,
  ));

  assert.deepEqual(result.parallelism, {
    reportedConcurrency: 2,
    measuredConcurrency: 4,
  });
  assert.deepEqual(validity.reasons, []);
  assert.deepEqual(validity.notes, ["reported-concurrency-differs"]);
});

test("a failed step still disposes every worker in its pool", async () => {
  const handles = [];

  await assert.rejects(
    measureCpuParallelismRamp({
      workerFactory() {
        const handle = {
          async prepare({ workUnitConfiguration }) {
            return {
              workloadChecksums: checksum("warmup"),
              workUnitConfiguration: workUnitConfiguration ?? WORK_UNIT_CONFIGURATION,
            };
          },
          async measure() {
            throw new Error("worker failed");
          },
          async dispose() {
            handle.disposed = true;
          },
          disposed: false,
        };
        handles.push(handle);
        return handle;
      },
      readNow: clock(),
      reportedConcurrency: 4,
    }),
    /worker failed/,
  );

  assert.equal(handles.length, 1);
  assert.equal(handles.every(({ disposed }) => disposed), true);
});
