import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_PROTOCOL_VERSION,
  createInvalidRunResult,
  createScoredRunResult,
  validateRunResult,
} from "../src/result.js";

test("the sustained and recovery protocol bumps the benchmark protocol", () => {
  assert.equal(BENCHMARK_PROTOCOL_VERSION, 5);
});

test("an invalid RunResult structurally has no score field", () => {
  const result = createInvalidRunResult({
    protocolVersion: 1,
    baselineVersion: 1,
    previewMode: "standard",
    reasons: ["tab-hidden"],
    score: { value: 0, unit: "BenchDev points" },
  });

  assert.equal(Object.hasOwn(result, "score"), false);
  assert.equal("score" in result, false);
  assert.equal(validateRunResult(result), true);
});

test("the validator rejects an invalid-shaped object carrying a score", () => {
  assert.equal(validateRunResult({
    kind: "invalid",
    schemaVersion: 1,
    protocolVersion: 1,
    baselineVersion: 1,
    previewMode: "standard",
    reasons: ["tab-hidden"],
    score: null,
  }), false);
});

test("a scored result carries units and is deeply frozen", () => {
  const result = createScoredRunResult({
    protocolVersion: 1,
    baselineVersion: 1,
    previewMode: "reduced-motion",
    score: { value: 100, unit: "BenchDev points" },
    subScores: [{ id: "cpu", value: 100, unit: "BenchDev points" }],
    measurements: [{ id: "cpu-js", value: 42, unit: "work units/second" }],
  });

  assert.equal(validateRunResult(result), true);
  assert.equal(result.measurements[0].unit, "work units/second");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.measurements[0]), true);
});
