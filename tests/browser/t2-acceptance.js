import { createRunStateMachine } from "../../src/run-state.js";
import { createRunner } from "../../src/runner.js";
import { estimateEffectiveTimerClamp } from "../../src/validity.js";
import { measureCpuJsSingleThread } from "../../src/workloads/cpu-browser.js";
import { measureCpuWasmSingleThread } from "../../src/workloads/cpu-wasm-browser.js";
import {
  CPU_JS_FLOAT_ITERATIONS,
  CPU_JS_FLOAT_SEED,
  CPU_JS_INTEGER_ITERATIONS,
  CPU_JS_INTEGER_SEED,
  runFloatMixKernel,
  runIntegerMixKernel,
} from "../../src/workloads/cpu-js.js";
import {
  CPU_WASM_ITERATIONS,
  CPU_WASM_SEED,
  CPU_WASM_SHA256,
} from "../../src/workloads/cpu-wasm.js";
import {
  CPU_WORK_UNIT_MAXIMUM_MS,
  CPU_WORK_UNIT_MINIMUM_MS,
} from "../../src/workloads/cpu-timing.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const UINT32_MASK = 0xffff_ffffn;

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

// The caller supplies the samples already captured by T2b. This acceptance
// check deliberately does not probe performance.now() resolution again.
export async function runT2BrowserAcceptance({ timerSamples }) {
  const timerClampMs = estimateEffectiveTimerClamp(timerSamples);
  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const started = runner.start((resources) => measureCpuJsSingleThread(resources));
  assert(started.kind === "started", "The CPU run did not use the existing runner lifecycle");

  const outcome = await started.completion;
  assert(outcome.kind === "completed", "The CPU workload did not complete");
  const measurement = outcome.value;
  const configuration = measurement.workUnitConfiguration;
  const independentlyExpected = {
    "cpu-js-integer-mix": independentlyDeriveIntegerChecksum(
      configuration.integerIterations,
      CPU_JS_INTEGER_SEED,
    ),
    "cpu-js-float-mix": independentlyDeriveFloatChecksum(
      configuration.floatIterations,
      CPU_JS_FLOAT_SEED,
    ),
  };
  const warmupExpected = {
    "cpu-js-integer-mix": independentlyDeriveIntegerChecksum(
      CPU_JS_INTEGER_ITERATIONS,
      CPU_JS_INTEGER_SEED,
    ),
    "cpu-js-float-mix": independentlyDeriveFloatChecksum(
      CPU_JS_FLOAT_ITERATIONS,
      CPU_JS_FLOAT_SEED,
    ),
  };

  for (const checksum of measurement.workloadChecksums) {
    const expected = checksum.stage === "measured"
      ? independentlyExpected[checksum.id]
      : warmupExpected[checksum.id];
    assert(
      Object.is(checksum.actual, expected),
      `${checksum.id} returned a checksum mismatch during ${checksum.stage}`,
    );
  }

  const averageWorkUnitMs = measurement.elapsedMs / measurement.workUnits;
  assert(
    averageWorkUnitMs >= CPU_WORK_UNIT_MINIMUM_MS
      && averageWorkUnitMs <= CPU_WORK_UNIT_MAXIMUM_MS,
    `The JS work unit averaged ${averageWorkUnitMs} ms instead of 5 to 10 ms`,
  );
  assert(
    timerClampMs <= CPU_WORK_UNIT_MINIMUM_MS,
    "The T2b timer clamp is too coarse for the CPU work unit",
  );

  assert(
    runIntegerMixKernel(configuration.integerIterations / 10)
      !== runIntegerMixKernel(configuration.integerIterations),
    "The browser engine produced a count-independent integer checksum",
  );
  assert(
    runFloatMixKernel(configuration.floatIterations / 10)
      !== runFloatMixKernel(configuration.floatIterations),
    "The browser engine produced a count-independent float checksum",
  );

  const wasmRunner = createRunner({ stateMachine: createRunStateMachine() });
  const wasmStarted = wasmRunner.start(
    (resources) => measureCpuWasmSingleThread(resources),
  );
  assert(wasmStarted.kind === "started", "The WASM run did not use the runner lifecycle");

  const wasmOutcome = await wasmStarted.completion;
  assert(
    wasmOutcome.kind === "completed",
    `The WASM workload did not complete: ${wasmOutcome.error?.message ?? wasmOutcome.kind}`,
  );
  const wasmMeasurement = wasmOutcome.value;
  const wasmConfiguration = wasmMeasurement.workUnitConfiguration;
  const wasmWarmupExpected = independentlyDeriveIntegerChecksum(
    CPU_WASM_ITERATIONS,
    CPU_WASM_SEED,
  );
  const wasmMeasuredExpected = independentlyDeriveIntegerChecksum(
    wasmConfiguration.iterationCount,
    CPU_WASM_SEED,
  );

  assert(
    wasmMeasurement.wasm.actualSha256 === CPU_WASM_SHA256
      && wasmMeasurement.wasm.expectedSha256 === CPU_WASM_SHA256,
    "The browser did not measure the pinned WASM binary",
  );

  for (const checksum of wasmMeasurement.workloadChecksums) {
    const expected = checksum.stage === "measured"
      ? wasmMeasuredExpected
      : wasmWarmupExpected;
    assert(
      checksum.actual === expected && checksum.expected === expected,
      `The WASM kernel returned a checksum mismatch during ${checksum.stage}`,
    );
  }

  const wasmAverageWorkUnitMs = wasmMeasurement.elapsedMs / wasmMeasurement.workUnits;
  assert(
    wasmAverageWorkUnitMs >= CPU_WORK_UNIT_MINIMUM_MS
      && wasmAverageWorkUnitMs <= CPU_WORK_UNIT_MAXIMUM_MS,
    `The WASM work unit averaged ${wasmAverageWorkUnitMs} ms instead of 5 to 10 ms`,
  );
  assert(
    independentlyDeriveIntegerChecksum(
      wasmConfiguration.iterationCount / 10,
      CPU_WASM_SEED,
    ) !== wasmMeasuredExpected,
    "The browser WASM measurement used a count-independent checksum",
  );

  const wrongHashRunner = createRunner({ stateMachine: createRunStateMachine() });
  const wrongHashStarted = wrongHashRunner.start(
    (resources) => measureCpuWasmSingleThread(resources, {
      wasmUrl: new URL("../../src/workloads/cpu.wat", import.meta.url),
    }),
  );
  const wrongHashOutcome = await wrongHashStarted.completion;
  // ⚠️ UPDATED 2026-09-02 FOR ARCH-03, and the failure it produced was worth having. This used
  // to require `kind === "failed"` with a thrown "SHA-256 mismatch" message, which was the OLD
  // contract: the loader threw, and the person was shown the generic "the run stopped" while a
  // perfectly good `wasm-hash-mismatch` reason and its copy sat unreachable in the code.
  //
  // ARCH-03 made the mismatch travel as DATA so the real reason reaches the screen, and this
  // assertion still demanded the throw. It caught the change, which is exactly what a browser check
  // is for, because the unit suite cannot see this path at all: 87 tests were green while this was
  // red. 🔴 The product moved and the check did not, so the check was asserting a contract that
  // no longer existed.
  //
  // What must remain true is unchanged and is the point: a binary whose hash does not match is
  // NEVER measured. Only the reporting shape changed.
  assert(
    wrongHashOutcome.kind === "completed",
    "The wrong-hash run should complete with evidence rather than throwing, per ARCH-03",
  );
  assert(
    wrongHashOutcome.value?.kind === "hash-mismatch",
    `A wrong WASM SHA-256 produced ${wrongHashOutcome.value?.kind ?? "no result"} `
      + "instead of a hash-mismatch result",
  );
  assert(
    wrongHashOutcome.value?.wasm?.actualSha256 !== wrongHashOutcome.value?.wasm?.expectedSha256,
    "The hash-mismatch result carried two matching hashes, so it proves nothing",
  );
  assert(
    wrongHashOutcome.value?.throughput === undefined,
    "A hash mismatch must not carry a throughput: the kernel must never have been measured",
  );

  return Object.freeze({
    jsThroughput: measurement.throughput,
    wasmThroughput: wasmMeasurement.throughput,
    throughputUnit: measurement.throughputUnit,
    jsAverageWorkUnitMs: averageWorkUnitMs,
    wasmAverageWorkUnitMs,
    timerClampMs,
    jsWorkUnitConfiguration: configuration,
    wasmWorkUnitConfiguration: wasmConfiguration,
  });
}
