export const CPU_JS_INTEGER_ITERATIONS = 1_250_000;
export const CPU_JS_FLOAT_ITERATIONS = 400_000;

export const CPU_JS_INTEGER_SEED = 0x6d2b_79f5;
export const CPU_JS_FLOAT_SEED = 0x243f_6a88;

// These constants are protocol data. Tests derive them with separate reference
// implementations so changing a kernel or its loop bound cannot bless itself.
export const CPU_JS_EXPECTED_CHECKSUMS = Object.freeze({
  "cpu-js-integer-mix": 2_602_556_586,
  "cpu-js-float-mix": 2_006_985_736,
});

export const CPU_JS_WORK_UNIT_SCALE_DENOMINATOR = 1_000;
const CPU_JS_INTEGER_ITERATIONS_PER_SCALE_TICK =
  CPU_JS_INTEGER_ITERATIONS / CPU_JS_WORK_UNIT_SCALE_DENOMINATOR;
const CPU_JS_FLOAT_ITERATIONS_PER_SCALE_TICK =
  CPU_JS_FLOAT_ITERATIONS / CPU_JS_WORK_UNIT_SCALE_DENOMINATOR;
const UINT32_MASK = 0xffff_ffffn;

function assertIterationCount(iterationCount) {
  if (!Number.isInteger(iterationCount) || iterationCount < 0) {
    throw new TypeError("iterationCount must be a non-negative integer");
  }
}

function assertUint32(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError("seed must be an unsigned 32-bit integer");
  }
}

export function runIntegerMixKernel(
  iterationCount = CPU_JS_INTEGER_ITERATIONS,
  seed = CPU_JS_INTEGER_SEED,
) {
  assertIterationCount(iterationCount);
  assertUint32(seed);

  let state = seed >>> 0;

  for (let index = 0; index < iterationCount; index += 1) {
    const countTerm = (index + 1) >>> 0;
    state = Math.imul(state ^ countTerm, 0x85eb_ca6b) >>> 0;
    state = ((state << 13) | (state >>> 19)) >>> 0;
    state = (state + Math.imul(countTerm, 0xc2b2_ae35)) >>> 0;
  }

  return state;
}

export function runFloatMixKernel(
  iterationCount = CPU_JS_FLOAT_ITERATIONS,
  seed = CPU_JS_FLOAT_SEED,
) {
  assertIterationCount(iterationCount);
  assertUint32(seed);

  const bits = new Uint32Array(1);
  const value = new Float32Array(bits.buffer);
  let state = Math.fround((seed >>> 8) * (1 / 0x0100_0000));
  let checksum = seed >>> 0;

  for (let index = 0; index < iterationCount; index += 1) {
    const countTerm = (index + 1) >>> 0;
    const increment = Math.fround(((countTerm & 1023) + 1) * (1 / 1_048_576));
    state = Math.fround(Math.fround(state * 1.0009765625) + increment);
    state = Math.fround(state - Math.floor(state));
    value[0] = state;
    checksum = Math.imul(checksum ^ bits[0] ^ countTerm, 0x27d4_eb2d) >>> 0;
  }

  return checksum;
}

function independentlyDeriveIntegerChecksum(iterationCount, seed) {
  let state = BigInt(seed);

  for (let index = 0; index < iterationCount; index += 1) {
    const countTerm = BigInt(index + 1);
    const multiplied = ((state ^ countTerm) * 0x85eb_ca6bn) & UINT32_MASK;
    state = ((multiplied << 13n) | (multiplied >> 19n)) & UINT32_MASK;
    state = (state + ((countTerm * 0xc2b2_ae35n) & UINT32_MASK)) & UINT32_MASK;
  }

  return Number(state);
}

function independentlyDeriveFloatChecksum(iterationCount, seed) {
  const view = new DataView(new ArrayBuffer(4));
  let state = Math.fround((seed >>> 8) / 0x0100_0000);
  let checksum = seed >>> 0;

  for (let ordinal = 1; ordinal <= iterationCount; ordinal += 1) {
    const countTerm = ordinal >>> 0;
    const fraction = Math.fround(((countTerm & 1023) + 1) / 1_048_576);
    state = Math.fround(Math.fround(state * 1.0009765625) + fraction);
    state = Math.fround(state - Math.floor(state));
    view.setFloat32(0, state, true);
    checksum = Math.imul(
      checksum ^ view.getUint32(0, true) ^ countTerm,
      0x27d4_eb2d,
    ) >>> 0;
  }

  return checksum;
}

function freezeWorkUnitConfiguration({
  scaleTicks,
  integerIterations,
  floatIterations,
  expectedChecksums,
}) {
  return Object.freeze({
    scaleTicks,
    scaleDenominator: CPU_JS_WORK_UNIT_SCALE_DENOMINATOR,
    workAmount: scaleTicks / CPU_JS_WORK_UNIT_SCALE_DENOMINATOR,
    integerIterations,
    floatIterations,
    expectedChecksums: Object.freeze({ ...expectedChecksums }),
  });
}

export const CPU_JS_DEFAULT_WORK_UNIT_CONFIGURATION = freezeWorkUnitConfiguration({
  scaleTicks: CPU_JS_WORK_UNIT_SCALE_DENOMINATOR,
  integerIterations: CPU_JS_INTEGER_ITERATIONS,
  floatIterations: CPU_JS_FLOAT_ITERATIONS,
  expectedChecksums: CPU_JS_EXPECTED_CHECKSUMS,
});

export function deriveCpuJsWorkUnitConfiguration(scale) {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TypeError("CPU JS work-unit scale must be a positive finite number");
  }

  const scaleTicks = Math.max(1, Math.round(scale * CPU_JS_WORK_UNIT_SCALE_DENOMINATOR));
  const integerIterations = CPU_JS_INTEGER_ITERATIONS_PER_SCALE_TICK * scaleTicks;
  const floatIterations = CPU_JS_FLOAT_ITERATIONS_PER_SCALE_TICK * scaleTicks;

  if (!Number.isSafeInteger(integerIterations) || !Number.isSafeInteger(floatIterations)) {
    throw new RangeError("CPU JS calibrated iteration count exceeds the safe integer range");
  }

  return freezeWorkUnitConfiguration({
    scaleTicks,
    integerIterations,
    floatIterations,
    expectedChecksums: {
      "cpu-js-integer-mix": independentlyDeriveIntegerChecksum(
        integerIterations,
        CPU_JS_INTEGER_SEED,
      ),
      "cpu-js-float-mix": independentlyDeriveFloatChecksum(
        floatIterations,
        CPU_JS_FLOAT_SEED,
      ),
    },
  });
}

function copyAndValidateWorkUnitConfiguration(configuration) {
  if (configuration === CPU_JS_DEFAULT_WORK_UNIT_CONFIGURATION) {
    return configuration;
  }

  const scaleTicks = configuration?.scaleTicks;
  const integerIterations = configuration?.integerIterations;
  const floatIterations = configuration?.floatIterations;
  const expectedChecksums = configuration?.expectedChecksums;

  if (!Number.isSafeInteger(scaleTicks) || scaleTicks < 1
      || configuration.scaleDenominator !== CPU_JS_WORK_UNIT_SCALE_DENOMINATOR
      || integerIterations !== CPU_JS_INTEGER_ITERATIONS_PER_SCALE_TICK * scaleTicks
      || floatIterations !== CPU_JS_FLOAT_ITERATIONS_PER_SCALE_TICK * scaleTicks
      || expectedChecksums === null
      || typeof expectedChecksums !== "object"
      || !Number.isInteger(expectedChecksums["cpu-js-integer-mix"])
      || !Number.isInteger(expectedChecksums["cpu-js-float-mix"])) {
    throw new TypeError("CPU JS work-unit configuration is invalid");
  }

  return freezeWorkUnitConfiguration({
    scaleTicks,
    integerIterations,
    floatIterations,
    expectedChecksums,
  });
}

export function createCpuJsWorkUnit(
  configuration = CPU_JS_DEFAULT_WORK_UNIT_CONFIGURATION,
) {
  const fixed = copyAndValidateWorkUnitConfiguration(configuration);
  const runWorkUnit = () => Object.freeze([
    Object.freeze({
      id: "cpu-js-integer-mix",
      actual: runIntegerMixKernel(fixed.integerIterations),
      expected: fixed.expectedChecksums["cpu-js-integer-mix"],
    }),
    Object.freeze({
      id: "cpu-js-float-mix",
      actual: runFloatMixKernel(fixed.floatIterations),
      expected: fixed.expectedChecksums["cpu-js-float-mix"],
    }),
  ]);

  return Object.freeze({
    configuration: fixed,
    runWorkUnit,
    workAmountPerUnit: fixed.workAmount,
  });
}

export function runCpuJsWorkUnit(configuration) {
  return createCpuJsWorkUnit(configuration).runWorkUnit();
}
