import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSustainedProtocol,
  summariseSustainedPhase,
  classifySustainedChange,
} from "../src/sustained.js";
import { evaluateSustainedValidity } from "../src/validity.js";

function cadence(intervalMs) {
  return Array.from({ length: 20 }, (_, index) => index * intervalMs);
}

function sustainedValidity(overrides = {}) {
  return evaluateSustainedValidity({
    visibilityStates: ["visible"],
    idleCadence: {
      beforeTimestamps: cadence(16.67),
      afterTimestamps: cadence(16.67),
    },
    ...overrides,
  });
}

function sustainedSamples({ openingWork = 100, closingWork = 80 } = {}) {
  const plan = deriveSustainedProtocol();
  const samples = [];

  for (let elapsedStartMs = 0;
    elapsedStartMs < plan.sustainedLoadDurationMs;
    elapsedStartMs += 1_000) {
    const inOpening = elapsedStartMs < plan.comparisonWindowMs;
    const inClosing = elapsedStartMs
      >= plan.sustainedLoadDurationMs - plan.comparisonWindowMs;
    samples.push({
      elapsedStartMs,
      elapsedEndMs: elapsedStartMs + 1_000,
      completedWork: inOpening ? openingWork : inClosing ? closingWork : 90,
    });
  }

  return samples;
}

test("a simulated visibility change invalidates the sustained phase with the existing reason", () => {
  const validity = sustainedValidity({
    visibilityStates: ["visible", "hidden", "visible"],
  });

  assert.deepEqual(validity.reasons, ["tab-backgrounded"]);
  assert.equal(validity.reasonDetails[0].text.length > 0, true);
  const result = summariseSustainedPhase({ validity });
  assert.deepEqual(result.reasons, ["tab-backgrounded"]);
  assert.equal("decline" in result, false);
});

test("a changed idle cadence invalidates the sustained phase with the existing reason", () => {
  const validity = sustainedValidity({
    idleCadence: {
      beforeTimestamps: cadence(16.67),
      afterTimestamps: cadence(33.33),
    },
  });

  assert.deepEqual(validity.reasons, ["display-regime-changed"]);
  assert.equal(validity.reasonDetails[0].text.length > 0, true);
  const result = summariseSustainedPhase({ validity });
  assert.deepEqual(result.reasons, ["display-regime-changed"]);
  assert.equal("decline" in result, false);
});

test("the recovery probe distinguishes recovery and labels only non-recovery unattributed", () => {
  const plan = deriveSustainedProtocol();
  const common = {
    validity: sustainedValidity(),
    samples: sustainedSamples(),
    preSustainedCpuThroughput: 100,
  };
  const notRecovered = summariseSustainedPhase({
    ...common,
    recoveryCpuThroughput: 80,
  });
  const recovered = summariseSustainedPhase({
    ...common,
    recoveryCpuThroughput: 95,
  });

  assert.deepEqual(plan, {
    sustainedLoadDurationMs: 40_000,
    comparisonWindowMs: 5_000,
    idleCadenceFrameCount: 20,
    recoveryIdleDurationMs: 5_000,
    recoveryProbeDurationMs: 3_000,
    recoveryMinimumRatio: 0.9,
    // ARCH-07: the noise floor is protocol, so it is enumerated here too. This assertion is a
    // deepEqual on purpose, so adding a boundary without deciding about it fails loudly.
    sustainedNoiseFloorRatio: 0.01,
  });
  assert.equal(notRecovered.kind, "measured");
  assert.equal(notRecovered.decline.openingWorkRate, 100);
  assert.equal(notRecovered.decline.closingWorkRate, 80);
  assert.ok(Math.abs(notRecovered.decline.declinePercent - 20) < 1e-12);
  assert.equal(notRecovered.recoveryProbe.status, "not-recovered");
  assert.equal(notRecovered.decline.attribution, "unattributed");
  assert.equal(recovered.recoveryProbe.status, "recovered");
  assert.equal("attribution" in recovered.decline, false);
});

// 🔴 GATE 3 CAUGHT THE VERDICT OVERSTATING THE MEASUREMENT. The threshold was a hard
// `sustainedToPeakRatio >= 1`, so ANY decline above zero read as "Slowed under load". It reported
// a slowdown from a 0.35% difference on a run whose own GPU coefficient of variation was 1.19%,
// which means the headline verdict would flip between "held steady" and "slowed" on identical
// hardware from one run to the next.
//
// On a product whose entire positioning is refusing to claim more than the data supports, that is
// the central promise failing in the three most prominent words on the screen.
test("a decline inside the measurement's own noise is not called a slowdown", () => {
  // The exact case Gate 3 measured: 0.35% decline against 1.19% run noise.
  assert.equal(classifySustainedChange(0.9965, 0.0119), "within-noise");

  // A real slowdown is still called one.
  assert.equal(classifySustainedChange(0.82, 0.0119), "slowed");

  // No decline at all is still "held steady", not "within noise".
  assert.equal(classifySustainedChange(1.0, 0.0119), "held-steady");
  assert.equal(classifySustainedChange(1.04, 0.0119), "held-steady");

  // ⚠️ A workload reporting an implausibly tidy coefficient must not let a real decline through,
  // so there is a floor. With no measured noise, 0.35% is inside it and 1.5% is not.
  assert.equal(classifySustainedChange(0.9965, null), "within-noise");
  assert.equal(classifySustainedChange(0.985, null), "slowed");
  assert.equal(classifySustainedChange(0.985, 0), "slowed");
});
