export const SUSTAINED_LOAD_DURATION_MS = 40_000;
export const SUSTAINED_COMPARISON_WINDOW_MS = 5_000;
export const SUSTAINED_IDLE_CADENCE_FRAME_COUNT = 20;
export const RECOVERY_IDLE_DURATION_MS = 5_000;
export const RECOVERY_PROBE_DURATION_MS = 3_000;
export const RECOVERY_MINIMUM_RATIO = 0.9;

// 🔴 A DECLINE SMALLER THAN THE MEASUREMENT'S OWN NOISE IS NOT A DECLINE. The first version
// of the verdict used `ratio >= 1`, a hard boundary with no band, so ANY decline above zero read as
// "slowed under load". Gate 3 caught it reporting a slowdown from **0.35%** on a run whose own GPU
// coefficient of variation was **1.19%**, which means the verdict would flip between "held steady"
// and "slowed" on identical hardware, run to run.
//
// On a product whose entire positioning is refusing to claim more than the data supports, that is
// the central promise failing in the headline. So the boundary is the run's OWN measured noise,
// with a floor for the case where the workload reports an implausibly tidy coefficient.
export const SUSTAINED_NOISE_FLOOR_RATIO = 0.01;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function freezeRecord(value) {
  for (const item of Object.values(value)) {
    if (item !== null && typeof item === "object") {
      freezeRecord(item);
    }
  }

  return Object.freeze(value);
}

function assertValidity(validity) {
  if (!isRecord(validity)
      || validity.status !== "checked"
      || !Array.isArray(validity.reasons)
      || !Array.isArray(validity.reasonDetails)) {
    throw new TypeError("A checked sustained validity report is required");
  }

  if (!validity.reasons.every((reason) => typeof reason === "string" && reason.length > 0)) {
    throw new TypeError("Sustained validity reasons must be non-empty strings");
  }

  const detailIds = validity.reasonDetails.map((detail) => detail?.id);

  if (validity.reasonDetails.some((detail) => !isRecord(detail)
      || typeof detail.id !== "string"
      || detail.id.length === 0
      || typeof detail.text !== "string"
      || detail.text.length === 0)
      || validity.reasons.some((reason) => !detailIds.includes(reason))) {
    throw new TypeError("Every sustained validity reason needs matching detail");
  }
}

function copyInvalidResult(validity) {
  return freezeRecord({
    kind: "invalid",
    reasons: [...validity.reasons],
    reasonDetails: validity.reasonDetails.map(({ id, text }) => ({ id, text })),
  });
}

function assertSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("Sustained samples must be a non-empty array");
  }

  let priorEndMs = 0;

  for (const sample of samples) {
    if (!isRecord(sample)) {
      throw new TypeError("Each sustained sample must be an object");
    }

    const { elapsedStartMs, elapsedEndMs, completedWork } = sample;
    if (!Number.isFinite(elapsedStartMs)
        || !Number.isFinite(elapsedEndMs)
        || elapsedStartMs < priorEndMs
        || elapsedEndMs <= elapsedStartMs) {
      throw new TypeError("Sustained sample intervals must be positive and ordered");
    }

    assertPositiveFinite(completedWork, "completedWork");
    priorEndMs = elapsedEndMs;
  }
}

function workRate(samples) {
  const completedWork = samples.reduce((sum, sample) => sum + sample.completedWork, 0);
  const elapsedMs = samples.reduce(
    (sum, sample) => sum + sample.elapsedEndMs - sample.elapsedStartMs,
    0,
  );

  assertPositiveFinite(elapsedMs, "sample elapsed time");
  return completedWork / (elapsedMs / 1_000);
}

// The noise band is measured from the OPENING window only. Using the whole run would fold the
// decline itself into the band, which would make a large decline excuse itself.
function withinWindowVariation(samples) {
  const rates = samples
    .map((sample) => {
      const seconds = (sample.elapsedEndMs - sample.elapsedStartMs) / 1_000;
      return seconds > 0 ? sample.completedWork / seconds : null;
    })
    .filter((rate) => Number.isFinite(rate) && rate > 0);

  if (rates.length < 2) return null;
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  if (!(mean > 0)) return null;
  const variance = rates.reduce((sum, rate) => sum + ((rate - mean) ** 2), 0) / rates.length;
  return Math.sqrt(variance) / mean;
}

function selectComparisonWindows(samples) {
  const closingWindowStartsAtMs =
    SUSTAINED_LOAD_DURATION_MS - SUSTAINED_COMPARISON_WINDOW_MS;
  const opening = samples.filter(({ elapsedEndMs }) => (
    elapsedEndMs <= SUSTAINED_COMPARISON_WINDOW_MS
  ));
  const closing = samples.filter(({ elapsedStartMs, elapsedEndMs }) => (
    elapsedStartMs >= closingWindowStartsAtMs
      && elapsedEndMs <= SUSTAINED_LOAD_DURATION_MS
  ));

  if (opening.length === 0 || closing.length === 0) {
    throw new RangeError("Sustained samples must cover both comparison windows");
  }

  return { opening, closing };
}

export function deriveSustainedProtocol() {
  return Object.freeze({
    sustainedLoadDurationMs: SUSTAINED_LOAD_DURATION_MS,
    comparisonWindowMs: SUSTAINED_COMPARISON_WINDOW_MS,
    idleCadenceFrameCount: SUSTAINED_IDLE_CADENCE_FRAME_COUNT,
    recoveryIdleDurationMs: RECOVERY_IDLE_DURATION_MS,
    recoveryProbeDurationMs: RECOVERY_PROBE_DURATION_MS,
    recoveryMinimumRatio: RECOVERY_MINIMUM_RATIO,
    // ARCH-07, Gate 4: this function exists to enumerate the sustained protocol, and the noise
    // floor is a boundary of exactly the kind the T5 record made explicit so that browser or
    // presentation code could not pick a more convenient one. It belongs here.
    sustainedNoiseFloorRatio: SUSTAINED_NOISE_FLOOR_RATIO,
  });
}

export function shouldRunRecoveryProbe(validity) {
  assertValidity(validity);
  return validity.reasons.length === 0;
}

export function classifySustainedChange(sustainedToPeakRatio, measurementNoiseRatio) {
  const band = Math.max(
    SUSTAINED_NOISE_FLOOR_RATIO,
    Number.isFinite(measurementNoiseRatio) && measurementNoiseRatio > 0 ? measurementNoiseRatio : 0,
  );
  if (sustainedToPeakRatio >= 1) return "held-steady";
  if (1 - sustainedToPeakRatio <= band) return "within-noise";
  return "slowed";
}

export function summariseSustainedPhase({
  validity,
  samples,
  preSustainedCpuThroughput,
  recoveryCpuThroughput,
  measurementNoiseRatio = null,
}) {
  assertValidity(validity);

  if (!shouldRunRecoveryProbe(validity)) {
    return copyInvalidResult(validity);
  }

  assertSamples(samples);
  assertPositiveFinite(preSustainedCpuThroughput, "preSustainedCpuThroughput");
  assertPositiveFinite(recoveryCpuThroughput, "recoveryCpuThroughput");

  const { opening, closing } = selectComparisonWindows(samples);
  const openingWorkRate = workRate(opening);
  const closingWorkRate = workRate(closing);
  const sustainedToPeakRatio = closingWorkRate / openingWorkRate;
  const declinePercent = Math.max(0, 1 - sustainedToPeakRatio) * 100;
  const recoveryRatio = recoveryCpuThroughput / preSustainedCpuThroughput;
  const recovered = recoveryRatio >= RECOVERY_MINIMUM_RATIO;
  // Prefer a caller-supplied band, else measure this run's own within-window variation.
  const noiseRatio = Number.isFinite(measurementNoiseRatio) && measurementNoiseRatio > 0
    ? measurementNoiseRatio
    : withinWindowVariation(opening);
  const change = classifySustainedChange(sustainedToPeakRatio, noiseRatio);
  const decline = {
    openingWorkRate,
    closingWorkRate,
    workRateUnit: "work units/second",
    sustainedToPeakRatio,
    ratioUnit: "ratio",
    declinePercent,
    declineUnit: "percent",
    change,
    measurementNoiseRatio: noiseRatio,
    noiseRatioUnit: "ratio",
  };

  if (!recovered) {
    decline.attribution = "unattributed";
  }

  return freezeRecord({
    kind: "measured",
    decline,
    recoveryProbe: {
      status: recovered ? "recovered" : "not-recovered",
      preSustainedCpuThroughput,
      recoveryCpuThroughput,
      throughputUnit: "work units/second",
      recoveryRatio,
      ratioUnit: "ratio",
      minimumRecoveryRatio: RECOVERY_MINIMUM_RATIO,
    },
  });
}
