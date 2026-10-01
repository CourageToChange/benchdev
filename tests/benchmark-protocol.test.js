import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_PHASES,
  BENCHMARK_WORKLOAD_SEQUENCE,
} from "../src/benchmark-protocol.js";

test("the protocol pins workload composition and order", () => {
  assert.deepEqual(
    BENCHMARK_WORKLOAD_SEQUENCE.map(({ id }) => id),
    [
      "environment",
      "cpu-js-single",
      "cpu-wasm-single",
      "cpu-parallel",
      "gpu",
      "sustained-and-recovery",
      "final-check",
    ],
  );
  assert.deepEqual(
    BENCHMARK_PHASES.full.map(({ id }) => id),
    [
      "environment",
      "cpu-single",
      "cpu-parallel",
      "gpu",
      "sustained",
      "recovery",
      "final-check",
    ],
  );
  assert.deepEqual(
    BENCHMARK_PHASES.quick.map(({ id }) => id),
    ["environment", "cpu-single", "cpu-parallel", "gpu", "final-check"],
  );
  assert.equal(
    BENCHMARK_WORKLOAD_SEQUENCE.find(({ id }) => id === "sustained-and-recovery")
      .requiresGpuMeasurement,
    true,
  );
});
