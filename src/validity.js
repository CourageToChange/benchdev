export const IDLE_CADENCE_MINIMUM_CHANGE_MS = 2;
export const IDLE_CADENCE_MAXIMUM_RELATIVE_CHANGE = 0.2;
export const REDUCED_TIMER_RESOLUTION_MS = 1;
export const SUSTAINED_INVALIDATION_IDS = Object.freeze([
  "tab-backgrounded",
  "display-regime-changed",
]);

const SOFTWARE_RENDERER_PATTERN = /(?:swiftshader|llvmpipe|softpipe|lavapipe|software rasterizer|microsoft basic render|basic render driver|\bwarp\b)/i;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/i;

function freezeEntries(entries) {
  for (const entry of entries) {
    Object.freeze(entry);
  }

  return Object.freeze(entries);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function frameIntervals(timestamps) {
  const intervals = [];

  for (let index = 1; index < timestamps.length; index += 1) {
    intervals.push(timestamps[index] - timestamps[index - 1]);
  }

  return intervals;
}

function idleCadenceMedian(timestamps) {
  return median(frameIntervals(timestamps));
}

function effectiveTimerClamp(samples) {
  const positiveDeltas = [];

  for (let index = 1; index < samples.length; index += 1) {
    const delta = samples[index] - samples[index - 1];

    if (delta > 0) {
      positiveDeltas.push(delta);
    }
  }

  return positiveDeltas.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...positiveDeltas);
}

function selectedRenderer({ maskedRenderer, unmaskedRenderer }) {
  return unmaskedRenderer ?? maskedRenderer ?? "";
}

function tabWasBackgrounded({ visibilityStates }) {
  return visibilityStates.some((state) => state !== "visible");
}

function idleCadenceChanged({ idleCadence }) {
  const before = idleCadenceMedian(idleCadence.beforeTimestamps);
  const after = idleCadenceMedian(idleCadence.afterTimestamps);
  const allowedChange = Math.max(
    IDLE_CADENCE_MINIMUM_CHANGE_MS,
    before * IDLE_CADENCE_MAXIMUM_RELATIVE_CHANGE,
  );

  return Math.abs(after - before) > allowedChange;
}

export function isSoftwareRenderer(webgl) {
  if (webgl === null || typeof webgl !== "object" || Array.isArray(webgl)) {
    throw new TypeError("WebGL renderer readings must be an object");
  }

  const { maskedRenderer, unmaskedRenderer } = webgl;

  if (maskedRenderer !== null && maskedRenderer !== undefined
      && typeof maskedRenderer !== "string") {
    throw new TypeError("maskedRenderer must be a string or null");
  }

  if (unmaskedRenderer !== null && unmaskedRenderer !== undefined
      && typeof unmaskedRenderer !== "string") {
    throw new TypeError("unmaskedRenderer must be a string or null");
  }

  return SOFTWARE_RENDERER_PATTERN.test(selectedRenderer(webgl));
}

function softwareRendererWasDetected({ webgl }) {
  return isSoftwareRenderer(webgl);
}

function contextWasLostUnexpectedly({ webgl }) {
  return webgl.contextLossEvents.some(({ teardownStarted }) => teardownStarted !== true);
}

function workloadChecksumMismatched({ workloadChecksums }) {
  return workloadChecksums.some(({ actual, expected }) => !Object.is(actual, expected));
}

function timerClampIsTooCoarse({ timer }) {
  return effectiveTimerClamp(timer.samples) > timer.shortestWorkUnitMs;
}

function parallelismIsIrreconcilable({ parallelism }) {
  return parallelism.reportedConcurrency === 1 && parallelism.measuredConcurrency > 1;
}

function wasmHashMismatched({ wasm }) {
  return wasm.actualSha256.toLowerCase() !== wasm.expectedSha256.toLowerCase();
}

function timerResolutionWasReduced(readings) {
  const clamp = effectiveTimerClamp(readings.timer.samples);

  return clamp > REDUCED_TIMER_RESOLUTION_MS && !timerClampIsTooCoarse(readings);
}

function reportedConcurrencyDiffers(readings) {
  return readings.parallelism.reportedConcurrency !== null
    && readings.parallelism.reportedConcurrency !== readings.parallelism.measuredConcurrency
    && !parallelismIsIrreconcilable(readings);
}

export const INVALIDATION_CONDITIONS = freezeEntries([
  {
    id: "tab-backgrounded",
    text: "The tab was not in front for the whole measured window.",
    evaluate: tabWasBackgrounded,
  },
  {
    id: "display-regime-changed",
    text: "The display timing changed between the cadence checks.",
    evaluate: idleCadenceChanged,
  },
  {
    id: "software-renderer-detected",
    text: "No hardware GPU was detected.",
    evaluate: softwareRendererWasDetected,
  },
  {
    id: "webgl-context-lost",
    text: "The graphics context was lost before teardown.",
    evaluate: contextWasLostUnexpectedly,
  },
  {
    id: "workload-checksum-mismatch",
    text: "A workload result did not match its expected checksum.",
    evaluate: workloadChecksumMismatched,
  },
  {
    id: "timer-clamp-too-coarse",
    text: "The browser timer resolution was too coarse for this workload.",
    evaluate: timerClampIsTooCoarse,
  },
  {
    id: "parallelism-irreconcilable",
    text: "Measured parallelism could not be reconciled with the browser's reported processor count.",
    evaluate: parallelismIsIrreconcilable,
  },
  {
    id: "wasm-hash-mismatch",
    text: "The WASM kernel did not match its verified source build.",
    evaluate: wasmHashMismatched,
  },
]);

export const CONFIDENCE_NOTES = freezeEntries([
  {
    id: "timer-resolution-reduced",
    text: "Timer resolution was reduced by the browser.",
    evaluate: timerResolutionWasReduced,
  },
  {
    id: "reported-concurrency-differs",
    text: "BenchDev only tries 1, 2, 4 and 8 threads, so this can differ from the processor count the browser reports.",
    evaluate: reportedConcurrencyDiffers,
  },
]);

function assertFiniteTimestamps(value, name, allowEqual = false) {
  if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isFinite)) {
    throw new TypeError(`${name} must contain at least two finite timestamps`);
  }

  for (let index = 1; index < value.length; index += 1) {
    if (allowEqual ? value[index] < value[index - 1] : value[index] <= value[index - 1]) {
      throw new TypeError(`${name} timestamps must be monotonic`);
    }
  }
}

function assertReadings(readings) {
  if (readings === null || typeof readings !== "object" || Array.isArray(readings)) {
    throw new TypeError("Validity readings must be an object");
  }

  if (!Array.isArray(readings.visibilityStates) || readings.visibilityStates.length === 0
      || !readings.visibilityStates.every((state) => typeof state === "string" && state.length > 0)) {
    throw new TypeError("visibilityStates must contain at least one state");
  }

  if (readings.idleCadence === null || typeof readings.idleCadence !== "object") {
    throw new TypeError("idleCadence readings are required");
  }

  assertFiniteTimestamps(readings.idleCadence.beforeTimestamps, "before idle cadence");
  assertFiniteTimestamps(readings.idleCadence.afterTimestamps, "after idle cadence");

  if (readings.webgl === null || typeof readings.webgl !== "object"
      || !Array.isArray(readings.webgl.contextLossEvents)) {
    throw new TypeError("WebGL readings and context loss events are required");
  }

  if (!Array.isArray(readings.workloadChecksums) || readings.workloadChecksums.length === 0
      || readings.workloadChecksums.some((entry) => entry === null || typeof entry !== "object"
        || !("actual" in entry) || !("expected" in entry))) {
    throw new TypeError("At least one workload checksum pair is required");
  }

  if (readings.timer === null || typeof readings.timer !== "object") {
    throw new TypeError("Timer readings are required");
  }

  assertFiniteTimestamps(readings.timer.samples, "timer samples", true);

  if (!Number.isFinite(readings.timer.shortestWorkUnitMs)
      || readings.timer.shortestWorkUnitMs <= 0) {
    throw new TypeError("shortestWorkUnitMs must be a positive finite number");
  }

  const { reportedConcurrency, measuredConcurrency } = readings.parallelism ?? {};

  if ((reportedConcurrency !== null
        && (!Number.isInteger(reportedConcurrency) || reportedConcurrency < 1))
      || !Number.isInteger(measuredConcurrency) || measuredConcurrency < 1) {
    throw new TypeError("Concurrency must be null when unavailable or a positive integer");
  }

  if (readings.wasm === null || typeof readings.wasm !== "object"
      || !SHA_256_PATTERN.test(readings.wasm.actualSha256)
      || !SHA_256_PATTERN.test(readings.wasm.expectedSha256)) {
    throw new TypeError("WASM hashes must be SHA-256 hexadecimal strings");
  }
}

function resultDetails(definitions, ids) {
  const selected = new Set(ids);
  return definitions
    .filter(({ id }) => selected.has(id))
    .map(({ id, text }) => Object.freeze({ id, text }));
}

function checkedReport(definitions, readings) {
  const reasons = definitions
    .filter(({ evaluate }) => evaluate(readings))
    .map(({ id }) => id);

  return Object.freeze({
    status: "checked",
    reasons: Object.freeze(reasons),
    notes: Object.freeze([]),
    reasonDetails: Object.freeze(resultDetails(definitions, reasons)),
    noteDetails: Object.freeze([]),
  });
}

export const UNCHECKED_VALIDITY = Object.freeze({
  status: "not-checked",
  reasons: null,
  notes: null,
  reasonDetails: null,
  noteDetails: null,
});

export function evaluateValidity(readings) {
  assertReadings(readings);

  const reasons = INVALIDATION_CONDITIONS
    .filter(({ evaluate }) => evaluate(readings))
    .map(({ id }) => id);
  const notes = CONFIDENCE_NOTES
    .filter(({ evaluate }) => evaluate(readings))
    .map(({ id }) => id);

  return Object.freeze({
    status: "checked",
    reasons: Object.freeze(reasons),
    notes: Object.freeze(notes),
    reasonDetails: Object.freeze(resultDetails(INVALIDATION_CONDITIONS, reasons)),
    noteDetails: Object.freeze(resultDetails(CONFIDENCE_NOTES, notes)),
  });
}

export function evaluateSustainedValidity(readings) {
  if (readings === null || typeof readings !== "object" || Array.isArray(readings)) {
    throw new TypeError("Sustained validity readings must be an object");
  }

  if (!Array.isArray(readings.visibilityStates) || readings.visibilityStates.length === 0
      || !readings.visibilityStates.every((state) => (
        typeof state === "string" && state.length > 0
      ))) {
    throw new TypeError("visibilityStates must contain at least one state");
  }

  if (readings.idleCadence === null || typeof readings.idleCadence !== "object") {
    throw new TypeError("Sustained idle cadence readings are required");
  }

  assertFiniteTimestamps(readings.idleCadence.beforeTimestamps, "before idle cadence");
  assertFiniteTimestamps(readings.idleCadence.afterTimestamps, "after idle cadence");

  const definitions = INVALIDATION_CONDITIONS.filter(({ id }) => (
    SUSTAINED_INVALIDATION_IDS.includes(id)
  ));

  if (definitions.length !== SUSTAINED_INVALIDATION_IDS.length) {
    throw new Error("Every sustained invalidation must use the central validity inventory");
  }

  return checkedReport(definitions, readings);
}

export function estimateEffectiveTimerClamp(samples) {
  assertFiniteTimestamps(samples, "timer samples", true);
  return effectiveTimerClamp(samples);
}

export function probeEffectiveTimerClamp(readNow, maximumReads = 1_000_000) {
  if (typeof readNow !== "function") {
    throw new TypeError("readNow must be a function");
  }

  if (!Number.isInteger(maximumReads) || maximumReads < 2) {
    throw new TypeError("maximumReads must be an integer of at least two");
  }

  const first = readNow();
  const samples = [first];

  for (let readCount = 1; readCount < maximumReads; readCount += 1) {
    const current = readNow();
    samples.push(current);

    if (current !== first) {
      break;
    }
  }

  return Object.freeze(samples);
}
