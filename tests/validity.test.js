import assert from "node:assert/strict";
import test from "node:test";

import { createInvalidRunResult } from "../src/result.js";
import {
  CONFIDENCE_NOTES,
  estimateEffectiveTimerClamp,
  evaluateValidity,
  INVALIDATION_CONDITIONS,
  isSoftwareRenderer,
  probeEffectiveTimerClamp,
  UNCHECKED_VALIDITY,
} from "../src/validity.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function cadence(intervalMs) {
  return Array.from({ length: 20 }, (_, index) => index * intervalMs);
}

function validReadings(overrides = {}) {
  const readings = {
    visibilityStates: ["visible", "visible"],
    idleCadence: {
      beforeTimestamps: cadence(16.67),
      afterTimestamps: cadence(16.67),
    },
    webgl: {
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: "NVIDIA GeForce RTX 4060",
      contextLossEvents: [],
    },
    workloadChecksums: [{ actual: "expected", expected: "expected" }],
    timer: {
      samples: [0, 1],
      shortestWorkUnitMs: 5,
    },
    parallelism: {
      reportedConcurrency: 8,
      measuredConcurrency: 8,
    },
    phaseEvents: [{ phaseId: "cpu", type: "completed" }],
    wasm: {
      actualSha256: HASH_A,
      expectedSha256: HASH_A,
    },
  };

  return {
    ...readings,
    ...overrides,
  };
}

const INVALIDATION_CASES = Object.freeze({
  "tab-backgrounded": () => validReadings({
    visibilityStates: ["visible", "hidden", "visible"],
  }),
  "display-regime-changed": () => validReadings({
    idleCadence: {
      beforeTimestamps: cadence(16.67),
      afterTimestamps: cadence(33.33),
    },
  }),
  "software-renderer-detected": () => validReadings({
    webgl: {
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: "ANGLE (Google, Vulkan 1.3.0 SwiftShader Device)",
      contextLossEvents: [],
    },
  }),
  "webgl-context-lost": () => validReadings({
    webgl: {
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: "NVIDIA GeForce RTX 4060",
      contextLossEvents: [{ teardownStarted: false }],
    },
  }),
  "workload-checksum-mismatch": () => validReadings({
    workloadChecksums: [{ actual: "wrong", expected: "expected" }],
  }),
  "timer-clamp-too-coarse": () => validReadings({
    timer: {
      samples: [0, 100],
      shortestWorkUnitMs: 5,
    },
  }),
  "parallelism-irreconcilable": () => validReadings({
    parallelism: {
      reportedConcurrency: 1,
      measuredConcurrency: 4,
    },
  }),
  "wasm-hash-mismatch": () => validReadings({
    wasm: {
      actualSha256: HASH_B,
      expectedSha256: HASH_A,
    },
  }),
});

const CONFIDENCE_CASES = Object.freeze({
  "timer-resolution-reduced": () => validReadings({
    timer: {
      samples: [0, 2],
      shortestWorkUnitMs: 5,
    },
  }),
  "reported-concurrency-differs": () => validReadings({
    parallelism: {
      reportedConcurrency: 2,
      measuredConcurrency: 8,
    },
  }),
});

test("the golden inventory has exactly one behaviour case for every invalidation condition", () => {
  assert.deepEqual(
    INVALIDATION_CONDITIONS.map(({ id }) => id).sort(),
    Object.keys(INVALIDATION_CASES).sort(),
  );

  for (const condition of INVALIDATION_CONDITIONS) {
    assert.equal(typeof condition.text, "string");
    assert.notEqual(condition.text.trim(), "");

    const report = evaluateValidity(INVALIDATION_CASES[condition.id]());
    assert.deepEqual(report.reasons, [condition.id]);
  }
});

test("the golden inventory has exactly one behaviour case for every confidence note", () => {
  assert.deepEqual(
    CONFIDENCE_NOTES.map(({ id }) => id).sort(),
    Object.keys(CONFIDENCE_CASES).sort(),
  );

  for (const note of CONFIDENCE_NOTES) {
    assert.equal(typeof note.text, "string");
    assert.notEqual(note.text.trim(), "");

    const report = evaluateValidity(CONFIDENCE_CASES[note.id]());
    assert.deepEqual(report.notes, [note.id]);
  }
});

test("a completed check with zero notes is distinct from a check that never ran", () => {
  const report = evaluateValidity(validReadings());

  assert.equal(report.status, "checked");
  assert.deepEqual(report.reasons, []);
  assert.deepEqual(report.notes, []);
  assert.equal(UNCHECKED_VALIDITY.status, "not-checked");
  assert.equal(UNCHECKED_VALIDITY.reasons, null);
  assert.equal(UNCHECKED_VALIDITY.notes, null);
  assert.notDeepEqual(report, UNCHECKED_VALIDITY);
});

test("a deliberate WebGL context loss during teardown does not invalidate the run", () => {
  const report = evaluateValidity(validReadings({
    webgl: {
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: "Apple GPU",
      contextLossEvents: [{ teardownStarted: true }],
    },
  }));

  assert.deepEqual(report.reasons, []);
});

test("software renderer classification covers the named failure families only", () => {
  for (const renderer of [
    "ANGLE (Google, Vulkan 1.3.0 SwiftShader Device)",
    "llvmpipe (LLVM 18.1.8, 256 bits)",
    "Microsoft Basic Render Driver",
  ]) {
    assert.equal(isSoftwareRenderer({
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: renderer,
    }), true, renderer);
  }

  assert.equal(isSoftwareRenderer({
    maskedRenderer: "WebKit WebGL",
    unmaskedRenderer: "NVIDIA GeForce RTX 4060",
  }), false);
  assert.equal(isSoftwareRenderer({
    maskedRenderer: "Apple GPU",
    unmaskedRenderer: null,
  }), false);
});

test("a known browser concurrency clamp is a note rather than a reason", () => {
  const report = evaluateValidity(CONFIDENCE_CASES["reported-concurrency-differs"]());

  assert.deepEqual(report.reasons, []);
  assert.deepEqual(report.notes, ["reported-concurrency-differs"]);
});

test("an unavailable reported concurrency does not invent a disagreement", () => {
  const report = evaluateValidity(validReadings({
    parallelism: {
      reportedConcurrency: null,
      measuredConcurrency: 4,
    },
  }));

  assert.deepEqual(report.reasons, []);
  assert.deepEqual(report.notes, []);
});

test("a reduced but usable timer clamp is a note while a 100 ms clamp is fatal", () => {
  const reduced = evaluateValidity(CONFIDENCE_CASES["timer-resolution-reduced"]());
  const tooCoarse = evaluateValidity(INVALIDATION_CASES["timer-clamp-too-coarse"]());

  assert.deepEqual(reduced.reasons, []);
  assert.deepEqual(reduced.notes, ["timer-resolution-reduced"]);
  assert.deepEqual(tooCoarse.reasons, ["timer-clamp-too-coarse"]);
  assert.deepEqual(tooCoarse.notes, []);
});

test("the effective timer probe samples until performance.now changes", () => {
  const readings = [12, 12, 12, 112, 212];
  let index = 0;
  const samples = probeEffectiveTimerClamp(() => readings[index++]);

  assert.deepEqual(samples, [12, 12, 12, 112]);
  assert.equal(estimateEffectiveTimerClamp([12, 112]), 100);
});

test("invalid reason ids pass directly into the existing RunResult contract", () => {
  const verdict = evaluateValidity(INVALIDATION_CASES["wasm-hash-mismatch"]());
  const result = createInvalidRunResult({
    protocolVersion: 1,
    baselineVersion: 1,
    previewMode: "standard",
    reasons: verdict.reasons,
  });

  assert.equal(result.kind, "invalid");
  assert.deepEqual(result.reasons, ["wasm-hash-mismatch"]);
  assert.equal("score" in result, false);
});
