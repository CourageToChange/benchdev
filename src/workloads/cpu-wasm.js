const SHA_256_PATTERN = /^[0-9a-f]{64}$/i;

export const CPU_WASM_ITERATIONS = 1_250_000;
export const CPU_WASM_SEED = 0x6d2b_79f5;
export const CPU_WASM_EXPECTED_CHECKSUM = 2_602_556_586;
export const CPU_WASM_WORK_UNIT_SCALE_DENOMINATOR = 1_000;
const CPU_WASM_ITERATIONS_PER_SCALE_TICK =
  CPU_WASM_ITERATIONS / CPU_WASM_WORK_UNIT_SCALE_DENOMINATOR;

// SHA-256 of the committed cpu.wasm, verified BEFORE instantiation, because a .wasm that loads,
// runs and measures the PREVIOUS kernel is otherwise completely invisible. A mismatch stays data
// so validity.js can invalidate the run with the specific `wasm-hash-mismatch` reason.
// Built 2026-08-24 with WABT 1.0.39. Regenerate with the command in README.md and update BOTH
// artifact hashes and CPU_WASM_EXPECTED_CHECKSUM above.
export const CPU_WAT_SHA256 =
  "6c2bda22cab0a01ceb6953550a4acef0fddbe1ce9c137aaac763fe8f083e13fb";
export const CPU_WASM_SHA256 =
  "318dc99c40e693887c8aa66443a8e041338b3da7b5f602d08f3d94ccf0083fea";

function deriveExpectedChecksum(iterationCount) {
  let state = CPU_WASM_SEED >>> 0;

  for (let index = 0; index < iterationCount; index += 1) {
    const countTerm = (index + 1) >>> 0;
    state = Math.imul(state ^ countTerm, 0x85eb_ca6b) >>> 0;
    state = ((state << 13) | (state >>> 19)) >>> 0;
    state = (state + Math.imul(countTerm, 0xc2b2_ae35)) >>> 0;
  }

  return state;
}

function freezeWorkUnitConfiguration({ scaleTicks, iterationCount, expectedChecksum }) {
  return Object.freeze({
    scaleTicks,
    scaleDenominator: CPU_WASM_WORK_UNIT_SCALE_DENOMINATOR,
    workAmount: scaleTicks / CPU_WASM_WORK_UNIT_SCALE_DENOMINATOR,
    iterationCount,
    expectedChecksum,
  });
}

export const CPU_WASM_DEFAULT_WORK_UNIT_CONFIGURATION = freezeWorkUnitConfiguration({
  scaleTicks: CPU_WASM_WORK_UNIT_SCALE_DENOMINATOR,
  iterationCount: CPU_WASM_ITERATIONS,
  expectedChecksum: CPU_WASM_EXPECTED_CHECKSUM,
});

export function deriveCpuWasmWorkUnitConfiguration(scale) {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TypeError("CPU WASM work-unit scale must be a positive finite number");
  }

  const scaleTicks = Math.max(
    1,
    Math.round(scale * CPU_WASM_WORK_UNIT_SCALE_DENOMINATOR),
  );
  const iterationCount = CPU_WASM_ITERATIONS_PER_SCALE_TICK * scaleTicks;

  if (!Number.isSafeInteger(iterationCount) || iterationCount > 0xffff_ffff) {
    throw new RangeError("CPU WASM calibrated iteration count exceeds the i32 count domain");
  }

  return freezeWorkUnitConfiguration({
    scaleTicks,
    iterationCount,
    expectedChecksum: deriveExpectedChecksum(iterationCount),
  });
}

function copyAndValidateWorkUnitConfiguration(configuration) {
  if (configuration === CPU_WASM_DEFAULT_WORK_UNIT_CONFIGURATION) {
    return configuration;
  }

  const scaleTicks = configuration?.scaleTicks;
  const iterationCount = configuration?.iterationCount;
  const expectedChecksum = configuration?.expectedChecksum;

  if (!Number.isSafeInteger(scaleTicks) || scaleTicks < 1
      || configuration.scaleDenominator !== CPU_WASM_WORK_UNIT_SCALE_DENOMINATOR
      || iterationCount !== CPU_WASM_ITERATIONS_PER_SCALE_TICK * scaleTicks
      || iterationCount > 0xffff_ffff
      || expectedChecksum !== deriveExpectedChecksum(iterationCount)) {
    throw new TypeError("CPU WASM work-unit configuration is invalid");
  }

  return freezeWorkUnitConfiguration({ scaleTicks, iterationCount, expectedChecksum });
}

function assertBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("WASM bytes must be a Uint8Array");
  }
}

function assertSha256(value, name) {
  if (typeof value !== "string" || !SHA_256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a SHA-256 hexadecimal string`);
  }
}

export async function verifyThenInstantiateCpuWasm({
  bytes,
  expectedSha256,
  digestSha256,
  instantiate,
}) {
  assertBytes(bytes);
  assertSha256(expectedSha256, "expectedSha256");

  if (typeof digestSha256 !== "function") {
    throw new TypeError("digestSha256 must be a function");
  }

  if (typeof instantiate !== "function") {
    throw new TypeError("instantiate must be a function");
  }

  const actualSha256 = await digestSha256(bytes);
  assertSha256(actualSha256, "actualSha256");
  const wasm = Object.freeze({
    actualSha256: actualSha256.toLowerCase(),
    expectedSha256: expectedSha256.toLowerCase(),
  });

  if (wasm.actualSha256 !== wasm.expectedSha256) {
    return Object.freeze({
      kind: "hash-mismatch",
      wasm,
    });
  }

  const instantiated = await instantiate(bytes);
  const instance = instantiated?.instance ?? instantiated;

  if (instance === null
      || typeof instance !== "object"
      || typeof instance.exports?.run !== "function") {
    throw new TypeError("The verified WASM module must export run(count, seed)");
  }

  return Object.freeze({
    kind: "loaded",
    wasm,
    instance,
  });
}

export function createCpuWasmWorkUnit(
  run,
  configuration = CPU_WASM_DEFAULT_WORK_UNIT_CONFIGURATION,
) {
  if (typeof run !== "function") {
    throw new TypeError("The WASM run export must be a function");
  }

  const fixed = copyAndValidateWorkUnitConfiguration(configuration);

  return function runCpuWasmWorkUnit() {
    const actual = run(fixed.iterationCount, CPU_WASM_SEED) >>> 0;

    if (actual !== fixed.expectedChecksum) {
      throw new Error(
        `CPU WASM checksum mismatch: expected ${fixed.expectedChecksum}, received ${actual}`,
      );
    }

    return Object.freeze([
      Object.freeze({
        id: "cpu-wasm-integer-mix",
        actual,
        expected: fixed.expectedChecksum,
      }),
    ]);
  };
}
