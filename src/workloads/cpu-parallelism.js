export const CPU_PARALLELISM_POOL_SIZES = Object.freeze([1, 2, 4, 8]);
export const CPU_PARALLELISM_RAMP_BUDGET_MS = 5_000;
export const CPU_PARALLELISM_STEP_BUDGET_MS =
  CPU_PARALLELISM_RAMP_BUDGET_MS / CPU_PARALLELISM_POOL_SIZES.length;

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function assertReportedConcurrency(value) {
  if (value !== null && (!Number.isInteger(value) || value < 1)) {
    throw new TypeError("reportedConcurrency must be null or a positive integer");
  }
}

function assertEffectiveWorkerLimit(value) {
  if (value !== Number.POSITIVE_INFINITY
      && (!Number.isInteger(value) || value < 1)) {
    throw new TypeError("effectiveWorkerLimit must be a positive integer or Infinity");
  }
}

function assertWorkerHandle(handle) {
  if (handle === null
      || typeof handle !== "object"
      || typeof handle.prepare !== "function"
      || typeof handle.measure !== "function"
      || typeof handle.dispose !== "function") {
    throw new TypeError("A worker handle must provide prepare, measure and dispose methods");
  }
}

function copyChecksums(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must provide workloadChecksums`);
  }

  return value.map((checksum) => {
    if (checksum === null
        || typeof checksum !== "object"
        || typeof checksum.id !== "string"
        || checksum.id.length === 0
        || !("actual" in checksum)
        || !("expected" in checksum)) {
      throw new TypeError(`${name} returned an invalid checksum`);
    }

    return Object.freeze({ ...checksum });
  });
}

function copyWorkUnitConfiguration(value) {
  if (value === null
      || typeof value !== "object"
      || !Number.isSafeInteger(value.scaleTicks)
      || value.scaleTicks < 1
      || !Number.isSafeInteger(value.scaleDenominator)
      || value.scaleDenominator < 1
      || !Number.isSafeInteger(value.integerIterations)
      || value.integerIterations < 1
      || !Number.isSafeInteger(value.floatIterations)
      || value.floatIterations < 1
      || value.expectedChecksums === null
      || typeof value.expectedChecksums !== "object") {
    throw new TypeError("Preparation returned an invalid work-unit configuration");
  }

  return Object.freeze({
    ...value,
    expectedChecksums: Object.freeze({ ...value.expectedChecksums }),
  });
}

function copyMeasurement(measurement) {
  if (measurement === null || typeof measurement !== "object") {
    throw new TypeError("A worker measurement must be an object");
  }

  if (!Number.isInteger(measurement.workUnits) || measurement.workUnits < 1) {
    throw new TypeError("A worker measurement must contain at least one whole work unit");
  }

  assertPositiveFinite(measurement.completedWork, "completedWork");

  return Object.freeze({
    workUnits: measurement.workUnits,
    completedWork: measurement.completedWork,
    workloadChecksums: Object.freeze(copyChecksums(measurement.workloadChecksums, "Measurement")),
  });
}

async function disposePool(handles) {
  const results = await Promise.allSettled(handles.map((handle) => handle.dispose()));
  const errors = results
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => reason);

  if (errors.length > 0) {
    throw new AggregateError(errors, "The worker pool did not tear down cleanly");
  }
}

async function measurePoolStep({
  poolSize,
  workerFactory,
  readNow,
  warmupWorkUnits,
  effectiveWorkerLimit,
  workUnitConfiguration,
}) {
  const handles = [];
  let stepError = null;

  try {
    for (let workerIndex = 0; workerIndex < poolSize; workerIndex += 1) {
      const handle = workerFactory({ poolSize, workerIndex });
      assertWorkerHandle(handle);
      handles.push(handle);
    }

    // No measurement message is sent until every worker has completed warm-up.
    // This is the postMessage start barrier used by both the measured ramp and
    // the deliberately serialised positive control.
    const preparations = await Promise.all(handles.map((handle) => handle.prepare({
      warmupWorkUnits,
      workUnitConfiguration,
    })));
    const preparedConfiguration = copyWorkUnitConfiguration(
      preparations[0]?.workUnitConfiguration,
    );

    for (const preparation of preparations.slice(1)) {
      const candidate = copyWorkUnitConfiguration(preparation?.workUnitConfiguration);

      if (JSON.stringify(candidate) !== JSON.stringify(preparedConfiguration)) {
        throw new Error("Parallel workers did not use one fixed calibrated work unit");
      }
    }
    const workloadChecksums = preparations.flatMap((preparation) => (
      copyChecksums(preparation?.workloadChecksums, "Preparation")
    ));

    const activeWorkers = Math.min(effectiveWorkerLimit, poolSize);
    const waveCount = Math.ceil(poolSize / activeWorkers);
    const workerBudgetMs = CPU_PARALLELISM_STEP_BUDGET_MS / waveCount;
    const startedAt = readNow();
    const measurements = [];

    for (let offset = 0; offset < handles.length; offset += activeWorkers) {
      const wave = handles.slice(offset, offset + activeWorkers);
      const waveMeasurements = await Promise.all(wave.map((handle) => handle.measure({
        budgetMs: workerBudgetMs,
      })));
      measurements.push(...waveMeasurements.map(copyMeasurement));
    }

    const elapsedMs = readNow() - startedAt;
    assertPositiveFinite(elapsedMs, "windowElapsedMs");

    const workUnits = measurements.reduce(
      (total, measurement) => total + measurement.workUnits,
      0,
    );
    const completedWork = measurements.reduce(
      (total, measurement) => total + measurement.completedWork,
      0,
    );
    workloadChecksums.push(...measurements.flatMap(({ workloadChecksums: checksums }) => checksums));

    return Object.freeze({
      poolSize,
      effectiveWorkers: activeWorkers,
      workUnits,
      completedWork,
      windowElapsedMs: elapsedMs,
      aggregateThroughput: completedWork / (elapsedMs / 1_000),
      throughputUnit: "work units/second",
      workloadChecksums: Object.freeze(workloadChecksums),
      workUnitConfiguration: preparedConfiguration,
    });
  } catch (error) {
    stepError = error;
    throw error;
  } finally {
    try {
      await disposePool(handles);
    } catch (teardownError) {
      if (stepError === null) {
        throw teardownError;
      }

      throw new AggregateError(
        [stepError, teardownError],
        "The parallelism step and its teardown both failed",
      );
    }
  }
}

export async function measureCpuParallelismRamp({
  workerFactory,
  readNow,
  reportedConcurrency,
  warmupWorkUnits = 2,
  effectiveWorkerLimit = Number.POSITIVE_INFINITY,
}) {
  if (typeof workerFactory !== "function") {
    throw new TypeError("workerFactory must be a function");
  }

  if (typeof readNow !== "function") {
    throw new TypeError("readNow must be a function");
  }

  assertReportedConcurrency(reportedConcurrency);
  assertEffectiveWorkerLimit(effectiveWorkerLimit);

  if (!Number.isInteger(warmupWorkUnits) || warmupWorkUnits < 1) {
    throw new TypeError("warmupWorkUnits must be a positive integer");
  }

  const steps = [];
  let workUnitConfiguration = null;

  for (const poolSize of CPU_PARALLELISM_POOL_SIZES) {
    const step = await measurePoolStep({
      poolSize,
      workerFactory,
      readNow,
      warmupWorkUnits,
      effectiveWorkerLimit,
      workUnitConfiguration,
    });
    steps.push(step);

    if (workUnitConfiguration === null) {
      const firstPreparation = step.workUnitConfiguration;
      workUnitConfiguration = firstPreparation;
    }
  }

  let peak = steps[0];

  for (const step of steps.slice(1)) {
    if (step.aggregateThroughput > peak.aggregateThroughput) {
      peak = step;
    }
  }

  const workloadChecksums = steps.flatMap(({ workloadChecksums: checksums }) => checksums);
  const parallelism = Object.freeze({
    reportedConcurrency,
    measuredConcurrency: peak.poolSize,
  });

  return Object.freeze({
    steps: Object.freeze(steps),
    peakAggregateThroughput: peak.aggregateThroughput,
    peakPoolSize: peak.poolSize,
    measuredConcurrency: peak.poolSize,
    reportedConcurrency,
    parallelism,
    scalingFactor: peak.aggregateThroughput / steps[0].aggregateThroughput,
    throughputUnit: "work units/second",
    workloadChecksums: Object.freeze(workloadChecksums),
  });
}
