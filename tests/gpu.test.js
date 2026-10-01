import assert from "node:assert/strict";
import test from "node:test";

import { PREVIEW_MODES } from "../src/result.js";
import {
  coefficientOfVariation,
  deriveGpuFeedbackChain,
  deriveGpuFeedbackState,
  deriveGpuMinimumTimedUnitMs,
  deriveGpuSceneParameters,
  deriveGpuWorkloadPlan,
  frameMeanLuminanceDeltaBound,
  gpuFrameMeanLuminanceDeltaBound,
  GPU_COMPLEXITY_LEVELS,
  GPU_FEEDBACK_INITIAL_STATE,
  GPU_FRAGMENT_SHADER_SOURCE,
  GPU_MAX_FRAME_MEAN_LUMINANCE_DELTA,
  GPU_PROTOCOL_CAP_DETAIL,
  GPU_PROTOCOL_CAP_OUTCOME,
  GPU_SCENE_LUMINANCE,
  GPU_VERTEX_SHADER_SOURCE,
  GPU_WORK_UNITS_PER_TIMED_UNIT_LEVELS,
  resolveGpuRamp,
  selectGpuBoundComplexity,
  summariseGpuWorkUnits,
} from "../src/workloads/gpu.js";
import {
  GPU_PREVIEW_DRAWS_PER_WORK_UNIT,
  GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
} from "../src/workloads/gpu-preview.js";

function independentlyLineariseSrgb(channel) {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function independentlyDeriveFeedbackState({
  previousState,
  complexityLevel,
  frameIndex,
  pixelX = 0,
  pixelY = 0,
}) {
  let state = previousState >>> 0;
  state = (state ^ Math.imul(pixelX + 1, 0x9e37_79b1)) >>> 0;
  state = (state ^ Math.imul(pixelY + 1, 0x5f35_6495)) >>> 0;
  state = (state ^ Math.imul(frameIndex + 1, 0xe33d_c5a9)) >>> 0;

  for (let iteration = 0; iteration < complexityLevel; iteration += 1) {
    const countTerm = iteration + 1;
    state = (
      Math.imul((state ^ (state >>> 16)) >>> 0, 0x85eb_ca77)
      + Math.imul(countTerm, 0xc2b2_ae3d)
    ) >>> 0;
    state = (
      Math.imul((state ^ (state >>> 13)) >>> 0, 0x27d4_eb2f)
      + countTerm
      + 0x1656_67b1
    ) >>> 0;
  }

  return state;
}

function independentlyDeriveFeedbackChain({
  initialState,
  complexityLevel,
  firstFrameIndex,
  frameCount,
}) {
  let state = initialState;

  for (let offset = 0; offset < frameCount; offset += 1) {
    state = independentlyDeriveFeedbackState({
      previousState: state,
      complexityLevel,
      frameIndex: firstFrameIndex + offset,
    });
  }

  return state;
}

test("the render target and preview work are invariant across existing preview modes", () => {
  const plans = PREVIEW_MODES.map((previewMode) => deriveGpuWorkloadPlan({
    previewMode,
    effectiveTimerClampMs: 1,
  }));
  const protocolParts = plans.map(({ previewMode, ...protocol }) => protocol);

  assert.deepEqual(protocolParts[0], protocolParts[1]);

  for (const plan of plans) {
    assert.deepEqual(plan.renderTargetPx, { width: 1280, height: 720 });
    assert.deepEqual(plan.previewSurfacePx, { width: 320, height: 180 });
    assert.equal(plan.complexityLevels.at(-1), 32_768);
    assert.equal(plan.complexityLevels.at(-1) / 256, 128);
    assert.equal(plan.workUnitsPerTimedUnitLevels.at(-1), 128);
    assert.equal(plan.minimumTimedUnitMs, 20);
    assert.equal(GPU_PREVIEW_DRAWS_PER_WORK_UNIT, 1);
    assert.equal(
      plan.previewSurfacePx.width * plan.previewSurfacePx.height,
      (plan.renderTargetPx.width * plan.renderTargetPx.height) / 16,
    );
  }

  assert.equal(deriveGpuMinimumTimedUnitMs(0.1), 20);
  assert.equal(deriveGpuMinimumTimedUnitMs(2), 40);
});

test("scene parameters derive only protocol complexity and a deterministic bounded phase", () => {
  assert.deepEqual(deriveGpuSceneParameters({ complexityLevel: 32, workUnitIndex: 0 }), {
    complexityLevel: 32,
    frameIndex: 0,
    phaseRadians: 0,
  });
  assert.equal(
    deriveGpuSceneParameters({ complexityLevel: 32, workUnitIndex: 4096 }).phaseRadians,
    0,
  );
  assert.notEqual(
    deriveGpuSceneParameters({ complexityLevel: 32, workUnitIndex: 1 }).phaseRadians,
    0,
  );
  assert.throws(
    () => deriveGpuSceneParameters({ complexityLevel: 31, workUnitIndex: 0 }),
    /protocol levels/,
  );
});

test("the shader scene is fully procedural, serial and count-dependent", () => {
  assert.match(GPU_VERTEX_SHADER_SOURCE, /gl_VertexID/);
  assert.match(GPU_FRAGMENT_SHADER_SOURCE, /usampler2D u_previous_state/);
  assert.match(GPU_FRAGMENT_SHADER_SOURCE, /texelFetch\(u_previous_state/);
  assert.match(GPU_FRAGMENT_SHADER_SOURCE, /u_frame_index \+ 1u/);
  assert.match(GPU_FRAGMENT_SHADER_SOURCE, /iteration >= u_complexity/);
  assert.match(GPU_FRAGMENT_SHADER_SOURCE, /count_term/);
  assert.match(GPU_FRAGMENT_SHADER_SOURCE, /const int MAX_COMPLEXITY = 32768/);
  assert.doesNotMatch(GPU_VERTEX_SHADER_SOURCE, /sampler|texture\s*\(/i);
  assert.match(GPU_PREVIEW_FRAGMENT_SHADER_SOURCE, /usampler2D/);
  assert.match(GPU_PREVIEW_FRAGMENT_SHADER_SOURCE, /texture\s*\(/);
});

test("the GPU feedback checksum matches an independent CPU chain and changes with count", () => {
  const configuration = {
    initialState: GPU_FEEDBACK_INITIAL_STATE,
    complexityLevel: 32,
    firstFrameIndex: 19,
  };
  const fullCount = 128;
  const shortenedCount = Math.floor(fullCount / 10);
  const independentlyExpected = independentlyDeriveFeedbackChain({
    ...configuration,
    frameCount: fullCount,
  });
  const productionState = deriveGpuFeedbackChain({
    ...configuration,
    frameCount: fullCount,
  });

  assert.equal(productionState, independentlyExpected);
  assert.notEqual(productionState, deriveGpuFeedbackChain({
    ...configuration,
    frameCount: shortenedCount,
  }));
  assert.notEqual(productionState, deriveGpuFeedbackChain({
    ...configuration,
    complexityLevel: 4,
    frameCount: fullCount,
  }));
  assert.notEqual(
    deriveGpuFeedbackState({
      previousState: GPU_FEEDBACK_INITIAL_STATE,
      complexityLevel: 32,
      frameIndex: 19,
    }),
    deriveGpuFeedbackState({
      previousState: GPU_FEEDBACK_INITIAL_STATE ^ 1,
      complexityLevel: 32,
      frameIndex: 19,
    }),
    "the next frame stopped consuming the prior frame state",
  );
});

test("the scene bounds frame mean luminance by construction below the protocol cap", () => {
  const bound = frameMeanLuminanceDeltaBound(GPU_SCENE_LUMINANCE);
  const independentlyExpected = independentlyLineariseSrgb(
    GPU_SCENE_LUMINANCE.centreSrgb + GPU_SCENE_LUMINANCE.amplitudeSrgb,
  ) - independentlyLineariseSrgb(
    GPU_SCENE_LUMINANCE.centreSrgb - GPU_SCENE_LUMINANCE.amplitudeSrgb,
  );

  assert.ok(Math.abs(bound - independentlyExpected) < 1e-15);
  assert.ok(
    bound <= GPU_MAX_FRAME_MEAN_LUMINANCE_DELTA,
    `${bound} exceeds the ${GPU_MAX_FRAME_MEAN_LUMINANCE_DELTA} frame-mean cap`,
  );

  // The preview maps every possible accumulated uint state through sin(). Its output interval is
  // therefore closed regardless of prior frames, frame count, complexity or phase.
  assert.match(
    GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
    new RegExp(`CENTRE_SRGB = ${GPU_SCENE_LUMINANCE.centreSrgb}`),
  );
  assert.match(
    GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
    new RegExp(`AMPLITUDE_SRGB = ${GPU_SCENE_LUMINANCE.amplitudeSrgb}`),
  );
  assert.match(GPU_PREVIEW_FRAGMENT_SHADER_SOURCE, /sin\(/);

  for (const complexityLevel of GPU_COMPLEXITY_LEVELS) {
    for (const workUnitsPerTimedUnit of GPU_WORK_UNITS_PER_TIMED_UNIT_LEVELS) {
      assert.equal(gpuFrameMeanLuminanceDeltaBound({
        complexityLevel,
        workUnitsPerTimedUnit,
      }), bound);
    }
  }
});

test("the complexity ramp selects the first level whose median is GPU-bound", () => {
  const selected = selectGpuBoundComplexity([
    { complexityLevel: 4, workUnitDurationsMs: [4, 5, 80] },
    { complexityLevel: 8, workUnitDurationsMs: [18, 20, 22] },
    { complexityLevel: 16, workUnitDurationsMs: [30, 31, 32] },
  ], 20);

  assert.equal(selected, 8);
  assert.equal(selectGpuBoundComplexity([
    { complexityLevel: 256, workUnitDurationsMs: [17, 18, 19] },
  ], 20), null);

  assert.deepEqual(resolveGpuRamp([
    {
      complexityLevel: 16_384,
      workUnitsPerTimedUnit: 2,
      workUnitDurationsMs: [18, 19, 20],
    },
    {
      complexityLevel: 32_768,
      workUnitsPerTimedUnit: 1,
      workUnitDurationsMs: [20, 21, 22],
    },
  ], 20), {
    kind: "selected",
    complexityLevel: 32_768,
    workUnitsPerTimedUnit: 1,
  });

  assert.deepEqual(resolveGpuRamp([
    {
      complexityLevel: 32_768,
      workUnitsPerTimedUnit: 128,
      workUnitDurationsMs: [0.2, 0.3, 0.4],
    },
  ], 20), {
    kind: GPU_PROTOCOL_CAP_OUTCOME,
    detail: GPU_PROTOCOL_CAP_DETAIL,
  });
});

test("coefficient of variation and the one reported GPU quantity use completed work", () => {
  assert.equal(coefficientOfVariation([7, 7, 7]), 0);
  assert.ok(Math.abs(coefficientOfVariation([10, 20, 30]) - Math.sqrt(2 / 12)) < 1e-15);

  const baseConfiguration = { complexityLevel: 4, workUnitsPerTimedUnit: 1 };
  const summary = summariseGpuWorkUnits([20, 20, 40, 40], baseConfiguration);
  assert.deepEqual(Object.keys(summary), [
    "sustainedWorkRate",
    "sustainedWorkRateUnit",
    "coefficientOfVariation",
    "coefficientOfVariationUnit",
  ]);
  assert.equal(summary.sustainedWorkRate, 100 / 3);
  assert.equal(summary.sustainedWorkRateUnit, "work units/second");
  assert.equal(summary.coefficientOfVariation, 1 / 3);
  assert.equal(summary.coefficientOfVariationUnit, "ratio");
  assert.equal("workUnitDurationsMs" in summary, false);

  const higherComplexity = summariseGpuWorkUnits(
    [20, 20, 40, 40],
    { complexityLevel: 256, workUnitsPerTimedUnit: 4 },
  );
  assert.equal(higherComplexity.sustainedWorkRate, summary.sustainedWorkRate * 256);
  assert.equal(higherComplexity.coefficientOfVariation, summary.coefficientOfVariation);
});
