export const CPU_SINGLE_THREAD_BUDGET_MS = 5_000;
export const CPU_WARMUP_WORK_UNITS = 2;
export const CPU_WORK_UNIT_MINIMUM_MS = 5;
export const CPU_WORK_UNIT_MAXIMUM_MS = 10;

export const CPU_WORK_UNIT_TARGET_MS =
  (CPU_WORK_UNIT_MINIMUM_MS + CPU_WORK_UNIT_MAXIMUM_MS) / 2;

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function assertChecksumPairs(checksums) {
  if (!Array.isArray(checksums) || checksums.length === 0) {
    throw new TypeError("A work unit must return at least one checksum pair");
  }

  for (const checksum of checksums) {
    if (checksum === null
        || typeof checksum !== "object"
        || typeof checksum.id !== "string"
        || checksum.id.length === 0
        || !("actual" in checksum)
        || !("expected" in checksum)) {
      throw new TypeError("Each work unit checksum needs an id, actual and expected value");
    }
  }
}

function copyChecksums(checksums, stage, workUnit) {
  assertChecksumPairs(checksums);

  return checksums.map(({ id, actual, expected }) => Object.freeze({
    id,
    actual,
    expected,
    stage,
    workUnit,
  }));
}

export function warmUpWorkload({
  runWorkUnit,
  warmupWorkUnits = CPU_WARMUP_WORK_UNITS,
}) {
  if (typeof runWorkUnit !== "function") {
    throw new TypeError("runWorkUnit must be a function");
  }

  if (!Number.isInteger(warmupWorkUnits) || warmupWorkUnits < 0) {
    throw new TypeError("warmupWorkUnits must be a non-negative integer");
  }

  const workloadChecksums = [];

  for (let index = 0; index < warmupWorkUnits; index += 1) {
    workloadChecksums.push(...copyChecksums(runWorkUnit(), "warmup", index + 1));
  }

  return Object.freeze(workloadChecksums);
}

export function calibrateWorkUnit({
  runCalibrationWorkUnit,
  createScaledWorkUnit,
  readNow,
  targetMs = CPU_WORK_UNIT_TARGET_MS,
}) {
  if (typeof runCalibrationWorkUnit !== "function"
      || typeof createScaledWorkUnit !== "function"
      || typeof readNow !== "function") {
    throw new TypeError("Calibration requires work-unit and timing functions");
  }

  assertPositiveFinite(targetMs, "targetMs");
  const startedAt = readNow();
  runCalibrationWorkUnit();
  const calibrationDurationMs = readNow() - startedAt;
  assertPositiveFinite(calibrationDurationMs, "calibrationDurationMs");

  // The returned fixed unit is all that escapes calibration. The timing and checksum sample
  // above are deliberately discarded and cannot enter the measured window or validity evidence.
  return createScaledWorkUnit(targetMs / calibrationDurationMs);
}

export function measureFixedBudgetWorkload({
  runWorkUnit,
  readNow,
  budgetMs = CPU_SINGLE_THREAD_BUDGET_MS,
  warmupWorkUnits = CPU_WARMUP_WORK_UNITS,
  workAmountPerUnit = 1,
}) {
  if (typeof runWorkUnit !== "function") {
    throw new TypeError("runWorkUnit must be a function");
  }

  if (typeof readNow !== "function") {
    throw new TypeError("readNow must be a function");
  }

  assertPositiveFinite(budgetMs, "budgetMs");
  assertPositiveFinite(workAmountPerUnit, "workAmountPerUnit");

  const workloadChecksums = [...warmUpWorkload({ runWorkUnit, warmupWorkUnits })];

  const startedAt = readNow();
  let finishedAt = startedAt;
  let workUnits = 0;

  do {
    const checksums = runWorkUnit();
    workUnits += 1;
    workloadChecksums.push(...copyChecksums(checksums, "measured", workUnits));

    // The measured clock is read exactly once after each complete unit.
    finishedAt = readNow();
  } while (finishedAt - startedAt < budgetMs);

  const elapsedMs = finishedAt - startedAt;
  const completedWork = workUnits * workAmountPerUnit;

  assertPositiveFinite(elapsedMs, "elapsedMs");

  return Object.freeze({
    workUnits,
    completedWork,
    elapsedMs,
    throughput: completedWork / (elapsedMs / 1_000),
    throughputUnit: "work units/second",
    workloadChecksums: Object.freeze(workloadChecksums),
  });
}
