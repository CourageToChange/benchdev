export const GPU_RENDER_TARGET_PX = Object.freeze({ width: 1280, height: 720 });
export const GPU_PREVIEW_SURFACE_PX = Object.freeze({ width: 320, height: 180 });
export const GPU_PREVIEW_BLITS_PER_WORK_UNIT = 1;
export const GPU_WEBGL2_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: true,
  desynchronized: false,
  powerPreference: "high-performance",
});

export const GPU_COMPLEXITY_LEVELS = Object.freeze([
  4,
  8,
  16,
  32,
  64,
  128,
  256,
  512,
  1_024,
  2_048,
  4_096,
  8_192,
  16_384,
  32_768,
]);
export const GPU_WORK_UNITS_PER_TIMED_UNIT_LEVELS = Object.freeze([
  1,
  2,
  4,
  8,
  16,
  32,
  64,
  128,
]);
export const GPU_COMPLEXITY_SAMPLES_PER_LEVEL = 3;
export const GPU_BOUND_MINIMUM_WORK_UNIT_MS = 20;
export const GPU_MINIMUM_TIMER_QUANTA_PER_TIMED_UNIT = 20;
export const GPU_MEASUREMENT_BUDGET_MS = 5_000;
export const GPU_BATCH_TIMED_UNITS = 4;
export const GPU_PROTOCOL_CAP_OUTCOME = "faster-than-protocol-cap";
export const GPU_PROTOCOL_CAP_DETAIL = "This device is faster than this protocol can measure.";

// The preview shader writes greyscale sRGB values in this closed interval. Its procedural state
// may change arbitrarily between frames and still cannot escape the interval, so the luminance
// guarantee does not depend on animation timing, refresh rate or a runtime detector.
export const GPU_SCENE_LUMINANCE = Object.freeze({
  centreSrgb: 0.35,
  amplitudeSrgb: 0.008,
});
export const GPU_MAX_FRAME_MEAN_LUMINANCE_DELTA = 0.02;
export const GPU_PHASE_STEP_RADIANS = 0.173_205_080_756_887_73;
export const GPU_FEEDBACK_INITIAL_STATE = 0x6d2b_79f5;

const GPU_FEEDBACK_PIXEL_X_MULTIPLIER = 0x9e37_79b1;
const GPU_FEEDBACK_PIXEL_Y_MULTIPLIER = 0x5f35_6495;
const GPU_FEEDBACK_FRAME_MULTIPLIER = 0xe33d_c5a9;
const GPU_FEEDBACK_FIRST_MULTIPLIER = 0x85eb_ca77;
const GPU_FEEDBACK_COUNT_MULTIPLIER = 0xc2b2_ae3d;
const GPU_FEEDBACK_SECOND_MULTIPLIER = 0x27d4_eb2f;
const GPU_FEEDBACK_INCREMENT = 0x1656_67b1;

export const GPU_VERTEX_SHADER_SOURCE = `#version 300 es
const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

out vec2 v_position;

void main() {
  vec2 position = POSITIONS[gl_VertexID];
  v_position = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const GPU_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp int;

uniform highp usampler2D u_previous_state;
uniform int u_complexity;
uniform highp uint u_frame_index;
layout(location = 0) out highp uint fragment_state;

const int MAX_COMPLEXITY = ${GPU_COMPLEXITY_LEVELS.at(-1)};

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  uint state = texelFetch(u_previous_state, pixel, 0).r;
  state ^= (uint(pixel.x) + 1u) * ${GPU_FEEDBACK_PIXEL_X_MULTIPLIER}u;
  state ^= (uint(pixel.y) + 1u) * ${GPU_FEEDBACK_PIXEL_Y_MULTIPLIER}u;
  state ^= (u_frame_index + 1u) * ${GPU_FEEDBACK_FRAME_MULTIPLIER}u;

  for (int iteration = 0; iteration < MAX_COMPLEXITY; iteration += 1) {
    if (iteration >= u_complexity) {
      break;
    }

    uint count_term = uint(iteration + 1);
    state = (state ^ (state >> 16u)) * ${GPU_FEEDBACK_FIRST_MULTIPLIER}u
      + count_term * ${GPU_FEEDBACK_COUNT_MULTIPLIER}u;
    state = (state ^ (state >> 13u)) * ${GPU_FEEDBACK_SECOND_MULTIPLIER}u
      + count_term + ${GPU_FEEDBACK_INCREMENT}u;
  }

  fragment_state = state;
}
`;

function assertUint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function multiplyUint32(left, right) {
  return Math.imul(left, right) >>> 0;
}

// CPU reference for the one-pixel state read back after each timed unit. The shader implements
// the same unsigned 32-bit recurrence independently. Every iteration consumes the prior state,
// and both the loop count and frame index enter that state.
export function deriveGpuFeedbackState({
  previousState,
  complexityLevel,
  frameIndex,
  pixelX = 0,
  pixelY = 0,
}) {
  assertUint32(previousState, "previousState");

  if (!GPU_COMPLEXITY_LEVELS.includes(complexityLevel)) {
    throw new TypeError("complexityLevel must be one of the protocol levels");
  }

  for (const [value, name] of [
    [frameIndex, "frameIndex"],
    [pixelX, "pixelX"],
    [pixelY, "pixelY"],
  ]) {
    assertUint32(value, name);
  }

  let state = previousState >>> 0;
  state = (state ^ multiplyUint32(pixelX + 1, GPU_FEEDBACK_PIXEL_X_MULTIPLIER)) >>> 0;
  state = (state ^ multiplyUint32(pixelY + 1, GPU_FEEDBACK_PIXEL_Y_MULTIPLIER)) >>> 0;
  state = (state ^ multiplyUint32(frameIndex + 1, GPU_FEEDBACK_FRAME_MULTIPLIER)) >>> 0;

  for (let iteration = 0; iteration < complexityLevel; iteration += 1) {
    const countTerm = iteration + 1;
    state = (
      multiplyUint32((state ^ (state >>> 16)) >>> 0, GPU_FEEDBACK_FIRST_MULTIPLIER)
      + multiplyUint32(countTerm, GPU_FEEDBACK_COUNT_MULTIPLIER)
    ) >>> 0;
    state = (
      multiplyUint32((state ^ (state >>> 13)) >>> 0, GPU_FEEDBACK_SECOND_MULTIPLIER)
      + countTerm
      + GPU_FEEDBACK_INCREMENT
    ) >>> 0;
  }

  return state;
}

export function deriveGpuFeedbackChain({
  initialState = GPU_FEEDBACK_INITIAL_STATE,
  complexityLevel,
  firstFrameIndex,
  frameCount,
  pixelX = 0,
  pixelY = 0,
}) {
  assertUint32(initialState, "initialState");
  assertUint32(firstFrameIndex, "firstFrameIndex");

  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new TypeError("frameCount must be a positive integer");
  }

  if (firstFrameIndex + frameCount - 1 > 0xffff_ffff) {
    throw new RangeError("The feedback chain frame index exceeds uint32");
  }

  let state = initialState;

  for (let offset = 0; offset < frameCount; offset += 1) {
    state = deriveGpuFeedbackState({
      previousState: state,
      complexityLevel,
      frameIndex: firstFrameIndex + offset,
      pixelX,
      pixelY,
    });
  }

  return state;
}

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function assertUnitInterval(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a finite number from zero to one`);
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function deriveGpuMinimumTimedUnitMs(effectiveTimerClampMs) {
  assertPositiveFinite(effectiveTimerClampMs, "effectiveTimerClampMs");

  return Math.max(
    GPU_BOUND_MINIMUM_WORK_UNIT_MS,
    effectiveTimerClampMs * GPU_MINIMUM_TIMER_QUANTA_PER_TIMED_UNIT,
  );
}

export function deriveGpuWorkloadPlan({ previewMode, effectiveTimerClampMs }) {
  if (typeof previewMode !== "string" || previewMode.length === 0) {
    throw new TypeError("previewMode must be a non-empty string");
  }

  return Object.freeze({
    previewMode,
    renderTargetPx: GPU_RENDER_TARGET_PX,
    previewSurfacePx: GPU_PREVIEW_SURFACE_PX,
    previewBlitsPerWorkUnit: GPU_PREVIEW_BLITS_PER_WORK_UNIT,
    contextAttributes: GPU_WEBGL2_CONTEXT_ATTRIBUTES,
    complexityLevels: GPU_COMPLEXITY_LEVELS,
    workUnitsPerTimedUnitLevels: GPU_WORK_UNITS_PER_TIMED_UNIT_LEVELS,
    complexitySamplesPerLevel: GPU_COMPLEXITY_SAMPLES_PER_LEVEL,
    gpuBoundMinimumWorkUnitMs: GPU_BOUND_MINIMUM_WORK_UNIT_MS,
    minimumTimedUnitMs: deriveGpuMinimumTimedUnitMs(effectiveTimerClampMs),
    measurementBudgetMs: GPU_MEASUREMENT_BUDGET_MS,
    batchTimedUnits: GPU_BATCH_TIMED_UNITS,
  });
}

export function deriveGpuSceneParameters({ complexityLevel, workUnitIndex }) {
  if (!GPU_COMPLEXITY_LEVELS.includes(complexityLevel)) {
    throw new TypeError("complexityLevel must be one of the protocol levels");
  }

  if (!Number.isInteger(workUnitIndex) || workUnitIndex < 0) {
    throw new TypeError("workUnitIndex must be a non-negative integer");
  }

  return Object.freeze({
    complexityLevel,
    frameIndex: workUnitIndex,
    phaseRadians: (workUnitIndex % 4096) * GPU_PHASE_STEP_RADIANS,
  });
}

export function srgbChannelToRelativeLuminance(channel) {
  assertUnitInterval(channel, "sRGB channel");

  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

export function frameMeanLuminanceDeltaBound({ centreSrgb, amplitudeSrgb }) {
  assertUnitInterval(centreSrgb, "centreSrgb");
  assertUnitInterval(amplitudeSrgb, "amplitudeSrgb");

  const minimum = centreSrgb - amplitudeSrgb;
  const maximum = centreSrgb + amplitudeSrgb;

  if (minimum < 0 || maximum > 1) {
    throw new RangeError("The scene luminance interval must stay inside the sRGB gamut");
  }

  // The absolute difference between two frame means cannot exceed the maximum per-pixel
  // difference. Greyscale relative luminance is the linearised channel because the WCAG channel
  // weights sum to one.
  return srgbChannelToRelativeLuminance(maximum)
    - srgbChannelToRelativeLuminance(minimum);
}

export function gpuFrameMeanLuminanceDeltaBound({
  complexityLevel,
  workUnitsPerTimedUnit,
}) {
  if (!GPU_COMPLEXITY_LEVELS.includes(complexityLevel)) {
    throw new TypeError("complexityLevel must be one of the protocol levels");
  }

  if (!GPU_WORK_UNITS_PER_TIMED_UNIT_LEVELS.includes(workUnitsPerTimedUnit)) {
    throw new TypeError("workUnitsPerTimedUnit must be one of the protocol levels");
  }

  // Complexity, batching and feedback can change the integer state arbitrarily. The preview maps
  // every possible state through sin(), so none can change the closed output interval.
  return frameMeanLuminanceDeltaBound(GPU_SCENE_LUMINANCE);
}

export function selectGpuBoundComplexity(
  observations,
  minimumWorkUnitMs = GPU_BOUND_MINIMUM_WORK_UNIT_MS,
) {
  if (!Array.isArray(observations)) {
    throw new TypeError("observations must be an array");
  }

  assertPositiveFinite(minimumWorkUnitMs, "minimumWorkUnitMs");
  const byComplexity = new Map();

  for (const observation of observations) {
    if (observation === null || typeof observation !== "object"
        || !GPU_COMPLEXITY_LEVELS.includes(observation.complexityLevel)
        || !Array.isArray(observation.workUnitDurationsMs)
        || observation.workUnitDurationsMs.length === 0) {
      throw new TypeError("Each observation needs a protocol complexity and duration samples");
    }

    for (const duration of observation.workUnitDurationsMs) {
      assertPositiveFinite(duration, "workUnitDurationMs");
    }

    if (byComplexity.has(observation.complexityLevel)) {
      throw new TypeError("Each complexity level may appear only once");
    }

    byComplexity.set(observation.complexityLevel, observation.workUnitDurationsMs);
  }

  for (const complexityLevel of GPU_COMPLEXITY_LEVELS) {
    const durations = byComplexity.get(complexityLevel);

    // >= , not > . The constant is a MINIMUM, so a level whose median sits exactly on it
    // qualifies. This was once a strict >, which disagreed with its own boundary case (median
    // exactly 20 against a threshold of 20) and was never caught because the tests had not
    // run. Picking > would silently skip a complexity level
    // that is genuinely GPU-bound and measure the next one up instead.
    if (durations !== undefined && median(durations) >= minimumWorkUnitMs) {
      return complexityLevel;
    }
  }

  return null;
}

export function resolveGpuRamp(
  observations,
  minimumWorkUnitMs = GPU_BOUND_MINIMUM_WORK_UNIT_MS,
) {
  const complexityLevel = selectGpuBoundComplexity(observations, minimumWorkUnitMs);

  if (complexityLevel !== null) {
    const observation = observations.find((candidate) => (
      candidate.complexityLevel === complexityLevel
    ));

    if (!GPU_WORK_UNITS_PER_TIMED_UNIT_LEVELS.includes(
      observation.workUnitsPerTimedUnit,
    )) {
      throw new TypeError("The selected observation needs a protocol timed-unit size");
    }

    return Object.freeze({
      kind: "selected",
      complexityLevel,
      workUnitsPerTimedUnit: observation.workUnitsPerTimedUnit,
    });
  }

  return Object.freeze({
    kind: GPU_PROTOCOL_CAP_OUTCOME,
    detail: GPU_PROTOCOL_CAP_DETAIL,
  });
}

export function coefficientOfVariation(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("values must be a non-empty array");
  }

  for (const value of values) {
    assertPositiveFinite(value, "coefficient input");
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / values.length;

  return Math.sqrt(variance) / mean;
}

export function gpuProtocolWorkPerTimedUnit({
  complexityLevel,
  workUnitsPerTimedUnit,
}) {
  if (!GPU_COMPLEXITY_LEVELS.includes(complexityLevel)) {
    throw new TypeError("complexityLevel must be one of the protocol levels");
  }

  if (!GPU_WORK_UNITS_PER_TIMED_UNIT_LEVELS.includes(workUnitsPerTimedUnit)) {
    throw new TypeError("workUnitsPerTimedUnit must be one of the protocol levels");
  }

  return (complexityLevel / GPU_COMPLEXITY_LEVELS[0]) * workUnitsPerTimedUnit;
}

export function summariseGpuWorkUnits(workUnitDurationsMs, configuration) {
  if (!Array.isArray(workUnitDurationsMs) || workUnitDurationsMs.length === 0) {
    throw new TypeError("At least one GPU work-unit duration is required");
  }

  for (const duration of workUnitDurationsMs) {
    assertPositiveFinite(duration, "workUnitDurationMs");
  }

  const elapsedMs = workUnitDurationsMs.reduce((sum, duration) => sum + duration, 0);
  const workPerTimedUnit = gpuProtocolWorkPerTimedUnit(configuration);
  const completedWork = workUnitDurationsMs.length * workPerTimedUnit;
  const perUnitWorkRates = workUnitDurationsMs.map((duration) => (
    workPerTimedUnit * 1_000 / duration
  ));

  return Object.freeze({
    sustainedWorkRate: completedWork / (elapsedMs / 1_000),
    sustainedWorkRateUnit: "work units/second",
    coefficientOfVariation: coefficientOfVariation(perUnitWorkRates),
    coefficientOfVariationUnit: "ratio",
  });
}
