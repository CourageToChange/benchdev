import assert from "node:assert/strict";
import test from "node:test";

import {
  CPU_JS_EXPECTED_CHECKSUMS,
  CPU_JS_FLOAT_ITERATIONS,
  CPU_JS_FLOAT_SEED,
  CPU_JS_INTEGER_ITERATIONS,
  CPU_JS_INTEGER_SEED,
  createCpuJsWorkUnit,
  deriveCpuJsWorkUnitConfiguration,
  runCpuJsWorkUnit,
  runFloatMixKernel,
  runIntegerMixKernel,
} from "../src/workloads/cpu-js.js";

const UINT32_MASK = 0xffff_ffffn;

// BigInt arithmetic is intentionally independent of the kernel's Math.imul
// implementation. Each operation is reduced to the i32 domain explicitly.
function referenceIntegerMix(iterationCount, seed) {
  let state = BigInt(seed);

  for (let index = 0; index < iterationCount; index += 1) {
    const countTerm = BigInt(index + 1);
    const multiplied = ((state ^ countTerm) * 0x85eb_ca6bn) & UINT32_MASK;
    state = ((multiplied << 13n) | (multiplied >> 19n)) & UINT32_MASK;
    state = (state + ((countTerm * 0xc2b2_ae35n) & UINT32_MASK)) & UINT32_MASK;
  }

  return Number(state);
}

// DataView gives this reference a different bit-conversion path from the
// kernel's shared typed-array buffer.
function referenceFloatMix(iterationCount, seed) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  let state = Math.fround((seed >>> 8) / 0x0100_0000);
  let checksum = seed >>> 0;

  for (let ordinal = 1; ordinal <= iterationCount; ordinal += 1) {
    const countTerm = ordinal >>> 0;
    const fraction = Math.fround(((countTerm & 1023) + 1) / 1_048_576);
    const multiplied = Math.fround(state * 1.0009765625);
    state = Math.fround(multiplied + fraction);
    state = Math.fround(state - Math.floor(state));
    view.setFloat32(0, state, true);
    checksum = Math.imul(checksum ^ view.getUint32(0, true) ^ countTerm, 0x27d4_eb2d) >>> 0;
  }

  return checksum;
}

test("the integer kernel checksum is independently derived and changes at one tenth the count", () => {
  const shortCount = CPU_JS_INTEGER_ITERATIONS / 10;
  const fullExpected = referenceIntegerMix(CPU_JS_INTEGER_ITERATIONS, CPU_JS_INTEGER_SEED);
  const shortExpected = referenceIntegerMix(shortCount, CPU_JS_INTEGER_SEED);

  assert.equal(runIntegerMixKernel(), fullExpected);
  assert.equal(runIntegerMixKernel(shortCount), shortExpected);
  assert.notEqual(shortExpected, fullExpected);
  assert.equal(CPU_JS_EXPECTED_CHECKSUMS["cpu-js-integer-mix"], fullExpected);
});

test("the float kernel checksum is independently derived and changes at one tenth the count", () => {
  const shortCount = CPU_JS_FLOAT_ITERATIONS / 10;
  const fullExpected = referenceFloatMix(CPU_JS_FLOAT_ITERATIONS, CPU_JS_FLOAT_SEED);
  const shortExpected = referenceFloatMix(shortCount, CPU_JS_FLOAT_SEED);

  assert.equal(runFloatMixKernel(), fullExpected);
  assert.equal(runFloatMixKernel(shortCount), shortExpected);
  assert.notEqual(shortExpected, fullExpected);
  assert.equal(CPU_JS_EXPECTED_CHECKSUMS["cpu-js-float-mix"], fullExpected);
});

test("the production work-unit harness exposes asserted expected checksum pairs", () => {
  const checksums = runCpuJsWorkUnit();

  assert.deepEqual(
    checksums.map(({ id }) => id),
    ["cpu-js-integer-mix", "cpu-js-float-mix"],
  );

  for (const { actual, expected } of checksums) {
    assert.equal(actual, expected);
  }
});

test("a calibrated count keeps independently derived count-dependent checksums", () => {
  const configuration = deriveCpuJsWorkUnitConfiguration(0.01);
  const workUnit = createCpuJsWorkUnit(configuration);
  const checksums = workUnit.runWorkUnit();
  const expected = {
    "cpu-js-integer-mix": referenceIntegerMix(
      configuration.integerIterations,
      CPU_JS_INTEGER_SEED,
    ),
    "cpu-js-float-mix": referenceFloatMix(
      configuration.floatIterations,
      CPU_JS_FLOAT_SEED,
    ),
  };

  for (const checksum of checksums) {
    assert.equal(checksum.expected, expected[checksum.id]);
    assert.equal(checksum.actual, expected[checksum.id]);
  }

  assert.notEqual(
    runIntegerMixKernel(configuration.integerIterations / 10),
    expected["cpu-js-integer-mix"],
  );
  assert.notEqual(
    runFloatMixKernel(configuration.floatIterations / 10),
    expected["cpu-js-float-mix"],
  );
});

test("kernel inputs reject counts or seeds outside their protocol domains", () => {
  assert.throws(() => runIntegerMixKernel(-1), /iterationCount/);
  assert.throws(() => runIntegerMixKernel(1.5), /iterationCount/);
  assert.throws(() => runFloatMixKernel(1, -1), /seed/);
  assert.throws(() => runFloatMixKernel(1, 0x1_0000_0000), /seed/);
});
