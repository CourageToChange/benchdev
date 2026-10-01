// 🔴 ARCH-01, Gate 4: THE SCORE HAD NO VERSION OF ITS OWN. A later change to the factors,
// weights or aggregation cannot just bump `protocolVersion`. Follow that path and
// `referenceLandmark(BASELINES, 6)`
// matches zero entries and throws during module evaluation, so `renderIdle()` never runs and the
// visitor gets a bare heading over an empty div, with no error and no message.
//
// The instrument was wrong, not the intent. `protocolVersion` is the key that SELECTS the baseline,
// so it identifies the MEASUREMENT. Versioning a scoring change with it breaks the lookup that the
// scoring depends on. The principle that makes all four of the no-bump decisions consistent:
// **version what is stored, not what can be recomputed.** Raw measurements are stored, so they get
// `protocolVersion`. Derived scores are stored, so they get this. A verdict word is recomputable
// from stored raw quantities, so it needs nothing.
//
// ⚠️ Bump this whenever `SCORE_FACTORS`, a weight, or the aggregation rule changes. The corpus
// partitions on `protocolVersion` alone, so without this two rows scored under different weights
// would sit in one table, which is the exact silent comparability failure the named-device comparison exists to prevent.
export const SCORING_VERSION = 1;

export const SCORE_UNIT = "BenchDev points";

export const SCORE_FACTORS = deepFreeze([
  {
    id: "cpuJsSingleThreadThroughput",
    compositionLabel: "CPU JS",
    weight: 15,
  },
  {
    id: "cpuWasmSingleThreadThroughput",
    compositionLabel: "CPU WASM",
    weight: 15,
  },
  {
    id: "cpuParallelThroughput",
    compositionLabel: "CPU parallel",
    weight: 30,
  },
  {
    id: "gpuSustainedWorkRate",
    compositionLabel: "GPU",
    weight: 40,
  },
]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }

  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function readOptionalMeasurement(value, name) {
  if (value === null || value === undefined || value.value === null) {
    return null;
  }

  if (!isRecord(value)
      || !Number.isFinite(value.value)
      || value.value <= 0
      || typeof value.unit !== "string"
      || value.unit.trim().length === 0) {
    throw new TypeError(`${name} must be missing or a positive measurement with a unit`);
  }

  return value;
}

function selectBaseline(baselineSet, protocolVersion) {
  if (!isRecord(baselineSet) || !Array.isArray(baselineSet.entries)) {
    throw new TypeError("baselineSet must contain baseline entries");
  }

  assertPositiveInteger(baselineSet.baselineVersion, "baselineSet.baselineVersion");
  const matches = baselineSet.entries.filter((entry) => (
    isRecord(entry) && entry.protocolVersion === protocolVersion
  ));

  if (matches.length !== 1) {
    throw new RangeError("Exactly one baseline entry must match the benchmark protocol");
  }

  const [baseline] = matches;

  if (typeof baseline.id !== "string"
      || baseline.id.length === 0
      || !isRecord(baseline.measurements)) {
    throw new TypeError("The matching baseline entry is malformed");
  }

  return baseline;
}

function createSustainedModifier(sustainedToPeakRatio) {
  if (sustainedToPeakRatio === null || sustainedToPeakRatio === undefined) {
    return null;
  }

  if (!Number.isFinite(sustainedToPeakRatio) || sustainedToPeakRatio <= 0) {
    throw new TypeError("sustainedToPeakRatio must be missing or a positive finite number");
  }

  return {
    id: "sustained-to-peak",
    value: sustainedToPeakRatio,
    unit: "ratio",
  };
}

export function calculateScore({
  baselineSet,
  measurements,
  protocolVersion,
  sustainedToPeakRatio = null,
}) {
  assertPositiveInteger(protocolVersion, "protocolVersion");

  if (!isRecord(measurements)) {
    throw new TypeError("measurements must be keyed by measurement id");
  }

  const baseline = selectBaseline(baselineSet, protocolVersion);
  const present = [];
  const omittedSubScores = [];

  for (const factor of SCORE_FACTORS) {
    const measured = readOptionalMeasurement(
      measurements[factor.id],
      `measurements.${factor.id}`,
    );
    const reference = readOptionalMeasurement(
      baseline.measurements[factor.id],
      `baseline.measurements.${factor.id}`,
    );

    if (reference === null) {
      omittedSubScores.push({ id: factor.id, reason: "baseline-missing" });
      continue;
    }

    if (measured === null) {
      omittedSubScores.push({ id: factor.id, reason: "measurement-missing" });
      continue;
    }

    if (measured.unit !== reference.unit) {
      throw new TypeError(`${factor.id} measurement and baseline units must match`);
    }

    present.push({
      factor,
      value: (measured.value / reference.value) * 100,
    });
  }

  if (present.length === 0) {
    throw new RangeError("At least one measured sub-score needs a measured baseline");
  }

  const presentWeight = present.reduce((sum, { factor }) => sum + factor.weight, 0);
  const weightedLogSum = present.reduce(
    (sum, { factor, value }) => sum + factor.weight * Math.log(value),
    0,
  );
  const scoreValue = Math.max(1, Math.round(Math.exp(weightedLogSum / presentWeight)));
  const compositionLabel = present
    .map(({ factor }) => factor.compositionLabel)
    .join("+");

  return deepFreeze({
    // ARCH-01: carried on the result so a stored score always says which rule produced it.
    scoringVersion: SCORING_VERSION,
    // Renormalising over the sub-scores that are present is the scoring rule. With all four
    // measured the weights are 15/15/30/40; `effectiveWeights` reports what actually applied,
    // so two differently composed scores can be told apart.
    effectiveWeights: Object.freeze(Object.fromEntries(
      present.map(({ factor }) => [factor.id, factor.weight / presentWeight]),
    )),
    score: {
      value: scoreValue,
      unit: SCORE_UNIT,
      label: `${scoreValue} (${compositionLabel})`,
    },
    composition: {
      label: compositionLabel,
      subScoreIds: present.map(({ factor }) => factor.id),
    },
    subScores: present.map(({ factor, value }) => ({
      id: factor.id,
      value,
      unit: SCORE_UNIT,
    })),
    omittedSubScores,
    modifier: createSustainedModifier(sustainedToPeakRatio),
    baseline: {
      id: baseline.id,
      baselineVersion: baselineSet.baselineVersion,
      protocolVersion: baseline.protocolVersion,
    },
  });
}
