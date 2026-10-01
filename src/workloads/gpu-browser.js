import { PREVIEW_MODES } from "../result.js";
import {
  estimateEffectiveTimerClamp,
  isSoftwareRenderer,
  probeEffectiveTimerClamp,
} from "../validity.js";
import { readPerformanceTimestamp, readWebGlRenderer } from "../validity-browser.js";
import {
  deriveGpuFeedbackChain,
  deriveGpuSceneParameters,
  deriveGpuWorkloadPlan,
  GPU_FEEDBACK_INITIAL_STATE,
  GPU_FRAGMENT_SHADER_SOURCE,
  GPU_BATCH_TIMED_UNITS,
  GPU_PREVIEW_SURFACE_PX,
  GPU_PROTOCOL_CAP_OUTCOME,
  GPU_RENDER_TARGET_PX,
  GPU_VERTEX_SHADER_SOURCE,
  GPU_WEBGL2_CONTEXT_ATTRIBUTES,
  gpuProtocolWorkPerTimedUnit,
  resolveGpuRamp,
  summariseGpuWorkUnits,
} from "./gpu.js";
import {
  GPU_PREVIEW_DRAWS_PER_WORK_UNIT,
  GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
} from "./gpu-preview.js";
import { createGpuWebGl2Adapter, createGpuWebGl2Context } from "./gpu-webgl2.js";

function freezeGpuReport(value) {
  for (const item of Object.values(value)) {
    if (item !== null && typeof item === "object") {
      Object.freeze(item);
    }
  }

  return Object.freeze(value);
}

function assertRunnerResources(resources) {
  if (typeof resources?.registerWebGlContext !== "function"
      || typeof resources?.registerTimer !== "function"
      || typeof resources?.registerDisposable !== "function"
      || resources.signal === null
      || typeof resources.signal !== "object") {
    throw new TypeError("The existing runner resource scope is required");
  }
}

function throwIfCancelled(signal) {
  if (signal.aborted) {
    throw new Error("The GPU workload was cancelled");
  }
}

async function yieldThroughRunner(resources) {
  await new Promise((resolve) => {
    let complete = false;
    let timerRegistration;
    let listenerRegistration;

    const finish = () => {
      if (complete) {
        return;
      }

      complete = true;
      resources.signal.removeEventListener("abort", finish);
      void timerRegistration?.dispose();
      void listenerRegistration?.dispose();
      resolve();
    };

    const timerId = setTimeout(finish, 0);
    timerRegistration = resources.registerTimer(timerId);
    resources.signal.addEventListener("abort", finish, { once: true });
    listenerRegistration = resources.registerDisposable(() => {
      resources.signal.removeEventListener("abort", finish);
    });
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function measureTimedRenderUnit({
  adapter,
  complexityLevel,
  firstWorkUnitIndex,
  initialFeedbackState,
  workUnitsPerTimedUnit,
  readNow,
}) {
  // Derive the independent CPU reference before timing starts. The measured interval therefore
  // contains only the GPU frames, their invariant preview draws and one final 1x1 readback.
  const expectedFeedbackState = deriveGpuFeedbackChain({
    initialState: initialFeedbackState,
    complexityLevel,
    firstFrameIndex: firstWorkUnitIndex,
    frameCount: workUnitsPerTimedUnit,
  });
  const startedAt = readNow();

  for (let offset = 0; offset < workUnitsPerTimedUnit; offset += 1) {
    adapter.renderFrame(deriveGpuSceneParameters({
      complexityLevel,
      workUnitIndex: firstWorkUnitIndex + offset,
    }));
  }

  adapter.completeTimedUnit(expectedFeedbackState);
  const finishedAt = readNow();
  const durationMs = finishedAt - startedAt;

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("The browser timer returned an invalid GPU timed-unit duration");
  }

  return Object.freeze({
    startedAt,
    finishedAt,
    durationMs,
    feedbackState: expectedFeedbackState,
  });
}

function measureTimedUnitSamples({
  adapter,
  complexityLevel,
  firstWorkUnitIndex,
  initialFeedbackState,
  workUnitsPerTimedUnit,
  sampleCount,
  readNow,
}) {
  const durationsMs = [];
  const timings = [];
  let nextWorkUnitIndex = firstWorkUnitIndex;
  let nextFeedbackState = initialFeedbackState;

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const measurement = measureTimedRenderUnit({
      adapter,
      complexityLevel,
      firstWorkUnitIndex: nextWorkUnitIndex,
      initialFeedbackState: nextFeedbackState,
      workUnitsPerTimedUnit,
      readNow,
    });
    durationsMs.push(measurement.durationMs);
    timings.push(Object.freeze({
      startedAt: measurement.startedAt,
      finishedAt: measurement.finishedAt,
      durationMs: measurement.durationMs,
    }));
    nextWorkUnitIndex += workUnitsPerTimedUnit;
    nextFeedbackState = measurement.feedbackState;
  }

  return Object.freeze({
    durationsMs: Object.freeze(durationsMs),
    timings: Object.freeze(timings),
    nextWorkUnitIndex,
    nextFeedbackState,
  });
}

export function detectPreviewMode() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches
    ? PREVIEW_MODES[1]
    : PREVIEW_MODES[0];
}

export async function measureGpuWorkload(resources, {
  previewCanvas,
  previewMode = detectPreviewMode(),
  readNow = readPerformanceTimestamp,
  timerSamples = null,
  yieldControl = yieldThroughRunner,
} = {}) {
  assertRunnerResources(resources);

  if (!PREVIEW_MODES.includes(previewMode)) {
    throw new TypeError("previewMode must use the existing RunResult enum");
  }

  if (typeof readNow !== "function" || typeof yieldControl !== "function") {
    throw new TypeError("GPU timing and yielding functions are required");
  }

  const effectiveTimerSamples = timerSamples ?? probeEffectiveTimerClamp(readNow);
  const effectiveTimerClampMs = estimateEffectiveTimerClamp(effectiveTimerSamples);
  const plan = deriveGpuWorkloadPlan({ previewMode, effectiveTimerClampMs });
  const gl = createGpuWebGl2Context(
    previewCanvas,
    plan.previewSurfacePx,
    plan.contextAttributes,
  );
  resources.registerWebGlContext(previewCanvas, gl);
  const renderer = Object.freeze(readWebGlRenderer(gl));

  if (isSoftwareRenderer(renderer)) {
    return freezeGpuReport({
      previewMode,
      renderer,
      renderTargetPx: plan.renderTargetPx,
      previewSurfacePx: plan.previewSurfacePx,
      previewDrawsPerWorkUnit: GPU_PREVIEW_DRAWS_PER_WORK_UNIT,
      measurementStatus: "software-renderer",
      gpuMeasurement: null,
    });
  }

  const adapter = createGpuWebGl2Adapter({
    gl,
    renderTargetPx: plan.renderTargetPx,
    previewSurfacePx: plan.previewSurfacePx,
    vertexShaderSource: GPU_VERTEX_SHADER_SOURCE,
    fragmentShaderSource: GPU_FRAGMENT_SHADER_SOURCE,
    previewFragmentShaderSource: GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
    initialFeedbackState: GPU_FEEDBACK_INITIAL_STATE,
  });
  const observations = [];
  let workUnitIndex = 0;
  let feedbackState = GPU_FEEDBACK_INITIAL_STATE;
  let rampDecision = null;

  for (const complexityLevel of plan.complexityLevels) {
    throwIfCancelled(resources.signal);

    for (const workUnitsPerTimedUnit of plan.workUnitsPerTimedUnitLevels) {
      const samples = measureTimedUnitSamples({
        adapter,
        complexityLevel,
        firstWorkUnitIndex: workUnitIndex,
        initialFeedbackState: feedbackState,
        workUnitsPerTimedUnit,
        sampleCount: plan.complexitySamplesPerLevel,
        readNow,
      });
      workUnitIndex = samples.nextWorkUnitIndex;
      feedbackState = samples.nextFeedbackState;

      // Small calibration batches may land on one clock tick. Keep doubling by protocol until
      // the median spans enough measured timer quanta, then judge GPU binding from the
      // synchronisation-amortised duration of one rendered work unit.
      if (median(samples.durationsMs) >= plan.minimumTimedUnitMs) {
        observations.push({
          complexityLevel,
          workUnitsPerTimedUnit,
          workUnitDurationsMs: samples.durationsMs.map((duration) => (
            duration / workUnitsPerTimedUnit
          )),
        });
        rampDecision = resolveGpuRamp(
          observations,
          plan.gpuBoundMinimumWorkUnitMs,
        );
        break;
      }
    }

    if (rampDecision?.kind === "selected") {
      break;
    }

    await yieldControl(resources);
  }

  rampDecision ??= resolveGpuRamp(observations, plan.gpuBoundMinimumWorkUnitMs);

  if (rampDecision.kind === GPU_PROTOCOL_CAP_OUTCOME) {
    return freezeGpuReport({
      previewMode,
      renderer,
      renderTargetPx: plan.renderTargetPx,
      previewSurfacePx: plan.previewSurfacePx,
      previewDrawsPerWorkUnit: GPU_PREVIEW_DRAWS_PER_WORK_UNIT,
      measurementStatus: rampDecision.kind,
      measurementDetail: rampDecision.detail,
      gpuMeasurement: null,
    });
  }

  const measuredDurationsMs = [];
  let measuredElapsedMs = 0;

  while (measuredElapsedMs < plan.measurementBudgetMs) {
    throwIfCancelled(resources.signal);
    const batch = measureTimedUnitSamples({
      adapter,
      complexityLevel: rampDecision.complexityLevel,
      firstWorkUnitIndex: workUnitIndex,
      initialFeedbackState: feedbackState,
      workUnitsPerTimedUnit: rampDecision.workUnitsPerTimedUnit,
      sampleCount: plan.batchTimedUnits,
      readNow,
    });
    workUnitIndex = batch.nextWorkUnitIndex;
    feedbackState = batch.nextFeedbackState;
    measuredDurationsMs.push(...batch.durationsMs);
    measuredElapsedMs += batch.durationsMs.reduce((sum, duration) => sum + duration, 0);
    await yieldControl(resources);
  }

  const gpuMeasurement = summariseGpuWorkUnits(measuredDurationsMs, rampDecision);

  // Calibration samples and per-unit timings deliberately do not leave this function. T4 reports
  // one sustained work rate at the selected GPU-bound level, plus its coefficient of variation.
  return freezeGpuReport({
    previewMode,
    renderer,
    renderTargetPx: plan.renderTargetPx,
    previewSurfacePx: plan.previewSurfacePx,
    previewDrawsPerWorkUnit: GPU_PREVIEW_DRAWS_PER_WORK_UNIT,
    measurementStatus: "measured",
    complexityLevel: rampDecision.complexityLevel,
    workUnitsPerTimedUnit: rampDecision.workUnitsPerTimedUnit,
    gpuMeasurement,
  });
}

export async function measureGpuSustainedLoad(resources, {
  previewCanvas,
  previewMode,
  configuration,
  durationMs,
  readNow = readPerformanceTimestamp,
  yieldControl = yieldThroughRunner,
} = {}) {
  assertRunnerResources(resources);

  if (!PREVIEW_MODES.includes(previewMode)) {
    throw new TypeError("previewMode must use the existing RunResult enum");
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new TypeError("durationMs must be a positive finite number");
  }

  if (typeof readNow !== "function" || typeof yieldControl !== "function") {
    throw new TypeError("GPU timing and yielding functions are required");
  }

  const completedWorkPerTimedUnit = gpuProtocolWorkPerTimedUnit(configuration ?? {});
  const gl = createGpuWebGl2Context(
    previewCanvas,
    GPU_PREVIEW_SURFACE_PX,
    GPU_WEBGL2_CONTEXT_ATTRIBUTES,
  );
  resources.registerWebGlContext(previewCanvas, gl);
  const renderer = Object.freeze(readWebGlRenderer(gl));

  if (isSoftwareRenderer(renderer)) {
    throw new Error("A hardware GPU is required for the sustained phase");
  }

  const adapter = createGpuWebGl2Adapter({
    gl,
    renderTargetPx: GPU_RENDER_TARGET_PX,
    previewSurfacePx: GPU_PREVIEW_SURFACE_PX,
    vertexShaderSource: GPU_VERTEX_SHADER_SOURCE,
    fragmentShaderSource: GPU_FRAGMENT_SHADER_SOURCE,
    previewFragmentShaderSource: GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
    initialFeedbackState: GPU_FEEDBACK_INITIAL_STATE,
  });
  const samples = [];
  let workUnitIndex = 0;
  let feedbackState = GPU_FEEDBACK_INITIAL_STATE;
  const phaseStartedAt = readNow();
  let phaseElapsedMs = 0;

  while (phaseElapsedMs < durationMs) {
    throwIfCancelled(resources.signal);
    const batch = measureTimedUnitSamples({
      adapter,
      complexityLevel: configuration.complexityLevel,
      firstWorkUnitIndex: workUnitIndex,
      initialFeedbackState: feedbackState,
      workUnitsPerTimedUnit: configuration.workUnitsPerTimedUnit,
      sampleCount: GPU_BATCH_TIMED_UNITS,
      readNow,
    });
    workUnitIndex = batch.nextWorkUnitIndex;
    feedbackState = batch.nextFeedbackState;

    for (const timing of batch.timings) {
      samples.push(Object.freeze({
        elapsedStartMs: timing.startedAt - phaseStartedAt,
        elapsedEndMs: timing.finishedAt - phaseStartedAt,
        completedWork: completedWorkPerTimedUnit,
      }));
    }

    await yieldControl(resources);
    phaseElapsedMs = readNow() - phaseStartedAt;
  }

  return freezeGpuReport({
    measurementStatus: "measured",
    previewMode,
    renderer,
    renderTargetPx: GPU_RENDER_TARGET_PX,
    previewSurfacePx: GPU_PREVIEW_SURFACE_PX,
    previewDrawsPerWorkUnit: GPU_PREVIEW_DRAWS_PER_WORK_UNIT,
    complexityLevel: configuration.complexityLevel,
    workUnitsPerTimedUnit: configuration.workUnitsPerTimedUnit,
    samples: Object.freeze(samples),
  });
}
