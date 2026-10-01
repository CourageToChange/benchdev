import assert from "node:assert/strict";
import test from "node:test";

import {
  CPU_WASM_DEFAULT_WORK_UNIT_CONFIGURATION,
  CPU_WASM_EXPECTED_CHECKSUM,
  CPU_WASM_ITERATIONS,
  CPU_WASM_SEED,
  createCpuWasmWorkUnit,
  deriveCpuWasmWorkUnitConfiguration,
  verifyThenInstantiateCpuWasm,
} from "../src/workloads/cpu-wasm.js";
import { loadCpuWasm } from "../src/workloads/cpu-wasm-browser.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const UINT32_MASK = 0xffff_ffffn;

function referenceWasmMix(iterationCount, seed) {
  let state = BigInt(seed);

  for (let ordinal = 1; ordinal <= iterationCount; ordinal += 1) {
    const countTerm = BigInt(ordinal);
    const multiplied = ((state ^ countTerm) * 0x85eb_ca6bn) & UINT32_MASK;
    state = ((multiplied << 13n) | (multiplied >> 19n)) & UINT32_MASK;
    state = (state + ((countTerm * 0xc2b2_ae35n) & UINT32_MASK)) & UINT32_MASK;
  }

  return Number(state);
}

test("a WASM hash mismatch remains structured data and prevents instantiation", async () => {
  let instantiations = 0;
  const result = await verifyThenInstantiateCpuWasm({
    bytes: new Uint8Array([0, 97, 115, 109]),
    expectedSha256: HASH_A,
    digestSha256: async () => HASH_B,
    instantiate: async () => {
      instantiations += 1;
      return { exports: { run() {} } };
    },
  });

  assert.equal(result.kind, "hash-mismatch");
  assert.deepEqual(result.wasm, {
    actualSha256: HASH_B,
    expectedSha256: HASH_A,
  });
  assert.equal(instantiations, 0);
});

test("the browser loader returns a hash mismatch instead of throwing it", async () => {
  const result = await loadCpuWasm(
    "data:application/wasm;base64,AGFzbQEAAAA=",
    HASH_A,
  );

  assert.equal(result.kind, "hash-mismatch");
  assert.equal(result.wasm.expectedSha256, HASH_A);
  assert.match(result.wasm.actualSha256, /^[0-9a-f]{64}$/);
});

test("matching WASM bytes instantiate once and expose the existing hash reading shape", async () => {
  const instance = { exports: { run() {} } };
  let instantiations = 0;
  const result = await verifyThenInstantiateCpuWasm({
    bytes: new Uint8Array([0, 97, 115, 109]),
    expectedSha256: HASH_A.toUpperCase(),
    digestSha256: async () => HASH_A,
    instantiate: async () => {
      instantiations += 1;
      return { instance };
    },
  });

  assert.equal(result.kind, "loaded");
  assert.equal(result.instance, instance);
  assert.deepEqual(result.wasm, {
    actualSha256: HASH_A,
    expectedSha256: HASH_A,
  });
  assert.equal(instantiations, 1);
});

test("a verified module without the protocol export is rejected", async () => {
  await assert.rejects(
    verifyThenInstantiateCpuWasm({
      bytes: new Uint8Array([0, 97, 115, 109]),
      expectedSha256: HASH_A,
      digestSha256: async () => HASH_A,
      instantiate: async () => ({ exports: {} }),
    }),
    /export run/,
  );
});

test("the WASM work-unit contract carries an independently derived count-dependent checksum", () => {
  const shortCount = CPU_WASM_ITERATIONS / 10;
  const fullExpected = referenceWasmMix(CPU_WASM_ITERATIONS, CPU_WASM_SEED);
  const shortExpected = referenceWasmMix(shortCount, CPU_WASM_SEED);
  const calls = [];
  const run = (count, seed) => {
    calls.push({ count, seed });
    return fullExpected | 0;
  };

  const [checksum] = createCpuWasmWorkUnit(run)();

  assert.deepEqual(calls, [{ count: CPU_WASM_ITERATIONS, seed: CPU_WASM_SEED }]);
  assert.equal(checksum.actual, fullExpected);
  assert.equal(checksum.expected, fullExpected);
  assert.equal(CPU_WASM_EXPECTED_CHECKSUM, fullExpected);
  assert.notEqual(shortExpected, fullExpected);
  assert.throws(
    createCpuWasmWorkUnit((count, seed) => referenceWasmMix(count / 10, seed)),
    /CPU WASM checksum mismatch/,
  );
});

test("a calibrated WASM unit preserves independently derived protocol work", () => {
  const configuration = deriveCpuWasmWorkUnitConfiguration(0.01);
  const expected = referenceWasmMix(configuration.iterationCount, CPU_WASM_SEED);
  const calls = [];
  const runWorkUnit = createCpuWasmWorkUnit((count, seed) => {
    calls.push({ count, seed });
    return referenceWasmMix(count, seed) | 0;
  }, configuration);

  const [checksum] = runWorkUnit();

  assert.deepEqual(calls, [{
    count: CPU_WASM_ITERATIONS / 100,
    seed: CPU_WASM_SEED,
  }]);
  assert.equal(configuration.workAmount, 0.01);
  assert.equal(checksum.actual, expected);
  assert.equal(checksum.expected, expected);
  assert.notEqual(
    referenceWasmMix(configuration.iterationCount / 10, CPU_WASM_SEED),
    expected,
  );
  assert.deepEqual(CPU_WASM_DEFAULT_WORK_UNIT_CONFIGURATION, {
    scaleTicks: 1_000,
    scaleDenominator: 1_000,
    workAmount: 1,
    iterationCount: CPU_WASM_ITERATIONS,
    expectedChecksum: CPU_WASM_EXPECTED_CHECKSUM,
  });
});
