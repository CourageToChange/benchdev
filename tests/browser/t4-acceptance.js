import {
  BENCHMARK_PROTOCOL_VERSION,
  createInvalidRunResult,
} from "../../src/result.js";
import { createRunStateMachine } from "../../src/run-state.js";
import { createRunner } from "../../src/runner.js";
import {
  evaluateValidity,
  isSoftwareRenderer,
} from "../../src/validity.js";
import { measureGpuWorkload } from "../../src/workloads/gpu-browser.js";
import {
  frameMeanLuminanceDeltaBound,
  GPU_MAX_FRAME_MEAN_LUMINANCE_DELTA,
  GPU_PREVIEW_SURFACE_PX,
  GPU_PROTOCOL_CAP_DETAIL,
  GPU_PROTOCOL_CAP_OUTCOME,
  GPU_RENDER_TARGET_PX,
  GPU_SCENE_LUMINANCE,
  srgbChannelToRelativeLuminance,
} from "../../src/workloads/gpu.js";

const HASH = "a".repeat(64);
const CAPTURE_MINIMUM_FRAME_COUNT = 60;
const CAPTURE_QUANTISATION_TOLERANCE = 0.004;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function classifyContextLossCapability(loseContext) {
  if (loseContext === null || typeof loseContext?.loseContext !== "function") {
    return Object.freeze({
      acceptanceStatus: "unverified",
      detail: "WEBGL_lose_context is unavailable in this browser environment",
    });
  }

  return Object.freeze({ acceptanceStatus: "available", loseContext });
}

function cadence(intervalMs) {
  return Array.from({ length: 20 }, (_, index) => index * intervalMs);
}

function validityReadings(renderer, contextLossEvents) {
  return {
    visibilityStates: ["visible"],
    idleCadence: {
      beforeTimestamps: cadence(16.67),
      afterTimestamps: cadence(16.67),
    },
    webgl: {
      ...renderer,
      contextLossEvents,
    },
    workloadChecksums: [{ actual: 1, expected: 1 }],
    timer: { samples: [0, 1], shortestWorkUnitMs: 20 },
    parallelism: { reportedConcurrency: 4, measuredConcurrency: 4 },
    phaseEvents: [{ phaseId: "gpu", type: "completed" }],
    wasm: { actualSha256: HASH, expectedSha256: HASH },
  };
}

function meanRelativeLuminance(rgba) {
  let total = 0;

  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = srgbChannelToRelativeLuminance(rgba[offset] / 255);
    const green = srgbChannelToRelativeLuminance(rgba[offset + 1] / 255);
    const blue = srgbChannelToRelativeLuminance(rgba[offset + 2] / 255);
    total += red * 0.2126 + green * 0.7152 + blue * 0.0722;
  }

  return total / (rgba.length / 4);
}

// The caller must supply every decoded frame from the compositor recording described in
// T4-RECORDED-CAPTURE.md. This intentionally does not accept a screenshot chosen by eye.
export function assertRecordedGpuCapture({
  source,
  width,
  height,
  frames,
}) {
  assert(source === "recorded-compositor-capture", "A recorded compositor capture is required");
  assert(width === GPU_PREVIEW_SURFACE_PX.width, "The capture width changed the preview protocol");
  assert(height === GPU_PREVIEW_SURFACE_PX.height, "The capture height changed the preview protocol");
  assert(Array.isArray(frames), "Decoded capture frames are required");
  assert(
    frames.length >= CAPTURE_MINIMUM_FRAME_COUNT,
    `The recording needs at least ${CAPTURE_MINIMUM_FRAME_COUNT} consecutive decoded frames`,
  );

  const expectedBytes = width * height * 4;
  const means = frames.map((frame, index) => {
    assert(frame.frameIndex === index, "The decoded recording omitted or reordered a frame");
    assert(Number.isFinite(frame.timestampMs), "Every recorded frame needs a timestamp");
    assert(frame.rgba instanceof Uint8Array, "Every recorded frame needs RGBA bytes");
    assert(frame.rgba.length === expectedBytes, "A recorded frame has the wrong dimensions");

    if (index > 0) {
      assert(
        frame.timestampMs > frames[index - 1].timestampMs,
        "Recorded frame timestamps must increase",
      );
    }

    return meanRelativeLuminance(frame.rgba);
  });

  let maximumObservedDelta = 0;

  for (let index = 1; index < means.length; index += 1) {
    maximumObservedDelta = Math.max(
      maximumObservedDelta,
      Math.abs(means[index] - means[index - 1]),
    );
  }

  const constructionBound = frameMeanLuminanceDeltaBound(GPU_SCENE_LUMINANCE);
  assert(
    maximumObservedDelta <= constructionBound + CAPTURE_QUANTISATION_TOLERANCE,
    `Recorded frame-mean luminance delta ${maximumObservedDelta} exceeded the shader bound`,
  );
  assert(
    maximumObservedDelta <= GPU_MAX_FRAME_MEAN_LUMINANCE_DELTA,
    `Recorded frame-mean luminance delta ${maximumObservedDelta} exceeded the protocol cap`,
  );

  return Object.freeze({
    frameCount: frames.length,
    maximumObservedDelta,
    constructionBound,
  });
}

// Run this once in a hardware-backed browser and once with its documented software-renderer
// switch. The software run must return no measurement and validity.js must own the reason.
export async function runT4BrowserAcceptance({ previewCanvas, previewMode, timerSamples }) {
  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const started = runner.start((resources) => measureGpuWorkload(resources, {
    previewCanvas,
    previewMode,
    timerSamples,
  }));
  assert(started.kind === "started", "The GPU workload did not use the existing runner lifecycle");

  const outcome = await started.completion;
  assert(outcome.kind === "completed", "The GPU workload did not complete");
  const report = outcome.value;
  const contextLossEvents = runner.inspect().contextLossEvents;
  const validity = evaluateValidity(validityReadings(report.renderer, contextLossEvents));

  assert(report.previewMode === previewMode, "The existing RunResult previewMode was not populated");
  assert(
    previewCanvas.width === GPU_PREVIEW_SURFACE_PX.width
      && previewCanvas.height === GPU_PREVIEW_SURFACE_PX.height,
    "The visible preview did not retain its fixed small size",
  );
  assert(
    report.renderTargetPx.width === GPU_RENDER_TARGET_PX.width
      && report.renderTargetPx.height === GPU_RENDER_TARGET_PX.height,
    "The measured render target was not 1280 by 720",
  );
  assert(report.previewDrawsPerWorkUnit === 1, "Preview cadence was not one draw per work unit");

  if (isSoftwareRenderer(report.renderer)) {
    assert(report.gpuMeasurement === null, "A software renderer produced a GPU measurement");
    assert(
      validity.reasons.includes("software-renderer-detected"),
      "validity.js did not classify the software renderer",
    );
    const result = createInvalidRunResult({
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      baselineVersion: 1,
      previewMode: report.previewMode,
      reasons: validity.reasons,
    });
    assert("score" in result === false, "A software renderer left a score-shaped result");
  } else {
    if (report.measurementStatus === GPU_PROTOCOL_CAP_OUTCOME) {
      assert(report.gpuMeasurement === null, "The protocol-cap outcome retained a measurement");
      assert(
        report.measurementDetail === GPU_PROTOCOL_CAP_DETAIL,
        "The protocol-cap outcome was not reported honestly",
      );
    } else {
      assert(report.measurementStatus === "measured", "The GPU outcome was not defined");
      assert(report.gpuMeasurement !== null, "A hardware renderer suppressed its GPU measurement");
      assert(
        Number.isFinite(report.gpuMeasurement.sustainedWorkRate)
          && report.gpuMeasurement.sustainedWorkRate > 0,
        "The hardware GPU work rate was not positive",
      );
      assert(
        Number.isFinite(report.gpuMeasurement.coefficientOfVariation)
          && report.gpuMeasurement.coefficientOfVariation >= 0,
        "The GPU coefficient of variation was not reported",
      );
    }
    assert(validity.reasons.length === 0, "A hardware renderer was invalidated unexpectedly");
  }

  return Object.freeze({ report, validity });
}

// This uses WEBGL_lose_context before runner teardown. The runner records the event-time teardown
// flag, and the existing validity contract turns that fact into the loud invalid RunResult shape.
export async function runT4ContextLossAcceptance({ previewCanvas, previewMode, timerSamples }) {
  const gl = previewCanvas.getContext("webgl2");

  if (gl === null) {
    return Object.freeze({
      acceptanceStatus: "unverified",
      detail: "WebGL2 is unavailable in this browser environment",
    });
  }

  const capability = classifyContextLossCapability(gl.getExtension("WEBGL_lose_context"));

  if (capability.acceptanceStatus === "unverified") {
    return capability;
  }

  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const started = runner.start((resources) => measureGpuWorkload(resources, {
    previewCanvas,
    previewMode,
    timerSamples,
  }));
  assert(started.kind === "started", "The context-loss run did not start");

  await new Promise((resolve) => setTimeout(resolve, 0));
  capability.loseContext.loseContext();

  const outcome = await started.completion;
  assert(outcome.kind === "failed", "Unexpected context loss did not fail loudly");
  const contextLossEvents = runner.inspect().contextLossEvents;
  const renderer = {
    maskedRenderer: "WebKit WebGL",
    unmaskedRenderer: "Hardware acceptance renderer",
  };
  const validity = evaluateValidity(validityReadings(renderer, contextLossEvents));
  assert(
    validity.reasons.includes("webgl-context-lost"),
    "Unexpected context loss did not reach the existing validity contract",
  );
  const result = createInvalidRunResult({
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    baselineVersion: 1,
    previewMode,
    reasons: validity.reasons,
  });
  assert(result.kind === "invalid" && !("score" in result), "Context loss retained a score");

  return Object.freeze({ outcome, contextLossEvents, result });
}
