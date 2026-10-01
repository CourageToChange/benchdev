import { BASELINES } from "./baselines.js";
import {
  BENCHMARK_PHASES,
  BENCHMARK_WORKLOAD_SEQUENCE,
} from "./benchmark-protocol.js";
import {
  BENCHMARK_PROTOCOL_VERSION,
  createInvalidRunResult,
  createScoredRunResult,
} from "./result.js";
import { createRunner } from "./runner.js";
import { createRunStateMachine } from "./run-state.js";
import { calculateScore } from "./scoring.js";
import {
  SUSTAINED_IDLE_CADENCE_FRAME_COUNT,
  SUSTAINED_LOAD_DURATION_MS,
} from "./sustained.js";
import { measureSustainedAndRecovery } from "./sustained-browser.js";
import {
  estimateEffectiveTimerClamp,
  evaluateValidity,
  probeEffectiveTimerClamp,
} from "./validity.js";
import {
  cancelIdleCadenceReading,
  observeVisibilityStates,
  requestIdleCadenceReading,
} from "./validity-browser.js";
import { measureCpuJsSingleThread } from "./workloads/cpu-browser.js";
import { measureCpuParallelism } from "./workloads/cpu-parallel-browser.js";
import { measureCpuWasmSingleThread } from "./workloads/cpu-wasm-browser.js";
import { measureGpuWorkload } from "./workloads/gpu-browser.js";

export { BENCHMARK_PHASES } from "./benchmark-protocol.js";

export const PHASE_NARRATION = Object.freeze({
  environment: "Checking timer precision, tab visibility and display cadence before measurement.",
  "cpu-single": "Running the processor test in JavaScript, then its integer part in WebAssembly.",
  "cpu-parallel": "Running the same work on 1, 2, 4 and then 8 threads. Some browsers report fewer threads than the device really has, so this counts instead of asking.",
  gpu: "Drawing the same 1280 by 720 scene at rising complexity, so window size cannot change the score.",
  // ⚠️ Derived, because this is the THIRD place a duration was typed out. The consent button
  // and the consent prose both went stale the moment a workload was added; this one is true
  // today and would go the same way. A number a person reads should come from the protocol.
  sustained: `Holding full load for ${Math.round(SUSTAINED_LOAD_DURATION_MS / 1000)} seconds. Many devices slow down. That is normal, and the change is measured.`,
  recovery: "Idling, then re-running the first test. A return toward the opening rate shows that the slowdown was reversible.",
  "final-check": "Checking every timing, workload checksum and measurement condition before showing a result.",
});

function assertRunLength(runLength) {
  if (!Object.hasOwn(BENCHMARK_PHASES, runLength)) {
    throw new TypeError("runLength must be quick or full");
  }
}

function collectIdleCadence(resources, frameCount) {
  return new Promise((resolve, reject) => {
    const timestamps = [];
    let requestId = null;
    let settled = false;
    let registration;

    const cleanup = () => {
      if (requestId !== null) {
        cancelIdleCadenceReading(requestId);
      }
      resources.signal.removeEventListener("abort", onAbort);
    };
    const finish = (complete, value) => {
      if (settled) {
        return;
      }

      settled = true;
      void registration.dispose();
      complete(value);
    };
    const onAbort = () => finish(reject, new Error("The cadence check was cancelled"));
    const onFrame = (timestamp) => {
      requestId = null;
      timestamps.push(timestamp);

      if (timestamps.length === frameCount) {
        finish(resolve, Object.freeze(timestamps));
      } else {
        requestId = requestIdleCadenceReading(onFrame);
      }
    };

    resources.signal.addEventListener("abort", onAbort, { once: true });
    registration = resources.registerDisposable(cleanup);
    requestId = requestIdleCadenceReading(onFrame);
  });
}

function phaseReporter(runLength, onPhase) {
  const phases = BENCHMARK_PHASES[runLength];

  return (id) => {
    const index = phases.findIndex((phase) => phase.id === id);

    if (index < 0) {
      throw new Error(`Unknown ${runLength} benchmark phase: ${id}`);
    }

    onPhase(Object.freeze({ id, index, phases, narration: PHASE_NARRATION[id] }));
  };
}

function measurement(id, value, unit) {
  return Object.freeze({ id, value, unit });
}

function averageUnitMs(cpuMeasurement) {
  return cpuMeasurement.elapsedMs / cpuMeasurement.workUnits;
}

function diagnosticSummary({
  result,
  validity,
  timerSamples,
  js,
  wasm,
  parallel,
  gpu,
  sustained,
}) {
  return Object.freeze({
    result,
    confidenceNotes: validity.noteDetails,
    validityReasons: validity.reasonDetails,
    environment: Object.freeze({
      effectiveTimerClampMs: estimateEffectiveTimerClamp(timerSamples),
      timerSampleCount: timerSamples.length,
      reportedConcurrency: parallel.reportedConcurrency,
      measuredConcurrency: parallel.measuredConcurrency,
      gpuRenderer: gpu.renderer,
    }),
    integrity: Object.freeze({
      jsChecksumCount: js.workloadChecksums.length,
      wasmChecksumCount: wasm.kind === "hash-mismatch" ? 0 : wasm.workloadChecksums.length,
      parallelChecksumCount: parallel.workloadChecksums.length,
      wasm: wasm.wasm,
    }),
    gpu: Object.freeze({
      measurementStatus: gpu.measurementStatus,
      renderTargetPx: gpu.renderTargetPx,
      previewSurfacePx: gpu.previewSurfacePx,
      previewDrawsPerWorkUnit: gpu.previewDrawsPerWorkUnit,
      coefficientOfVariation: gpu.gpuMeasurement?.coefficientOfVariation ?? null,
      coefficientOfVariationUnit: gpu.gpuMeasurement?.coefficientOfVariationUnit ?? null,
    }),
    sustained: sustained?.sustainedResult ?? null,
  });
}

async function executeBenchmark({
  resources,
  runner,
  runLength,
  previewCanvas,
  sustainedCanvas,
  previewMode,
  onPhase,
}) {
  assertRunLength(runLength);
  const reportPhase = phaseReporter(runLength, onPhase);
  const visibilityStates = [];
  const stopVisibilityObserver = observeVisibilityStates((state) => visibilityStates.push(state));
  const visibilityRegistration = resources.registerDisposable(stopVisibilityObserver);
  const readings = {
    timerSamples: null,
    beforeTimestamps: null,
    afterTimestamps: null,
    js: null,
    wasm: null,
    parallel: null,
    gpu: null,
    sustained: null,
  };
  const operations = {
    async environment() {
      readings.timerSamples = probeEffectiveTimerClamp(() => performance.now());
      readings.beforeTimestamps = await collectIdleCadence(
        resources,
        SUSTAINED_IDLE_CADENCE_FRAME_COUNT,
      );
    },
    async "cpu-js-single"() {
      readings.js = await measureCpuJsSingleThread(resources);
    },
    async "cpu-wasm-single"() {
      readings.wasm = await measureCpuWasmSingleThread(resources);
    },
    async "cpu-parallel"() {
      readings.parallel = await measureCpuParallelism(resources);
    },
    async gpu() {
      readings.gpu = await measureGpuWorkload(resources, {
        previewCanvas,
        previewMode,
        timerSamples: readings.timerSamples,
      });
    },
    async "sustained-and-recovery"() {
      const recoveryTimerId = setTimeout(
        () => reportPhase("recovery"),
        SUSTAINED_LOAD_DURATION_MS,
      );
      const recoveryTimerRegistration = resources.registerTimer(recoveryTimerId);
      readings.sustained = await measureSustainedAndRecovery(resources, {
        previewCanvas: sustainedCanvas,
        previewMode,
        gpuConfiguration: {
          complexityLevel: readings.gpu.complexityLevel,
          workUnitsPerTimedUnit: readings.gpu.workUnitsPerTimedUnit,
        },
        preSustainedCpuMeasurement: readings.js,
      });
      await recoveryTimerRegistration.dispose();
    },
    async "final-check"() {
      readings.afterTimestamps = await collectIdleCadence(
        resources,
        SUSTAINED_IDLE_CADENCE_FRAME_COUNT,
      );
      await visibilityRegistration.dispose();
    },
  };

  for (const step of BENCHMARK_WORKLOAD_SEQUENCE) {
    if (!step.runLengths.includes(runLength)) {
      continue;
    }

    if (step.requiresGpuMeasurement === true && readings.gpu.gpuMeasurement === null) {
      continue;
    }

    if (step.startPhase !== null) {
      reportPhase(step.startPhase);
    }

    await operations[step.id]();
  }

  const {
    timerSamples,
    beforeTimestamps,
    afterTimestamps,
    js,
    wasm,
    parallel,
    gpu,
    sustained,
  } = readings;

  const workloadChecksums = [
    ...js.workloadChecksums,
    ...(wasm.kind === "hash-mismatch" ? [] : wasm.workloadChecksums),
    ...parallel.workloadChecksums,
  ];
  const validity = evaluateValidity({
    visibilityStates,
    idleCadence: { beforeTimestamps, afterTimestamps },
    webgl: {
      ...gpu.renderer,
      contextLossEvents: runner.inspect().contextLossEvents,
    },
    workloadChecksums,
    timer: {
      samples: timerSamples,
      shortestWorkUnitMs: wasm.kind === "hash-mismatch"
        ? averageUnitMs(js)
        : Math.min(averageUnitMs(js), averageUnitMs(wasm)),
    },
    parallelism: parallel.parallelism,
    wasm: wasm.wasm,
  });
  const reasons = new Set(validity.reasons);

  for (const reason of sustained?.validity?.reasons ?? []) {
    reasons.add(reason);
  }

  const measurements = [
    measurement("cpuJsSingleThreadThroughput", js.throughput, js.throughputUnit),
    measurement("cpuParallelThroughput", parallel.peakAggregateThroughput, parallel.throughputUnit),
  ];

  if (wasm.kind !== "hash-mismatch") {
    measurements.splice(1, 0, measurement(
      "cpuWasmSingleThreadThroughput",
      wasm.throughput,
      wasm.throughputUnit,
    ));
  }

  if (gpu.gpuMeasurement !== null) {
    measurements.push(measurement(
      "gpuSustainedWorkRate",
      gpu.gpuMeasurement.sustainedWorkRate,
      gpu.gpuMeasurement.sustainedWorkRateUnit,
    ));
  }

  let result;
  let scoreDetails = null;

  if (reasons.size > 0) {
    result = createInvalidRunResult({
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      baselineVersion: BASELINES.baselineVersion,
      previewMode,
      reasons: [...reasons],
    });
  } else {
    const keyedMeasurements = Object.fromEntries(measurements.map(({ id, value, unit }) => (
      [id, { value, unit }]
    )));
    scoreDetails = calculateScore({
      baselineSet: BASELINES,
      measurements: keyedMeasurements,
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      sustainedToPeakRatio: sustained?.sustainedResult?.decline?.sustainedToPeakRatio ?? null,
    });
    result = createScoredRunResult({
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      baselineVersion: BASELINES.baselineVersion,
      previewMode,
      score: scoreDetails.score,
      subScores: scoreDetails.subScores,
      measurements,
    });
  }

  return Object.freeze({
    result,
    scoreDetails,
    validity,
    sustained: sustained?.sustainedResult ?? null,
    diagnostics: diagnosticSummary({
      result,
      validity,
      timerSamples,
      js,
      wasm,
      parallel,
      gpu,
      sustained,
    }),
  });
}

export function createBenchmarkController({ onPhase = () => {} } = {}) {
  if (typeof onPhase !== "function") {
    throw new TypeError("onPhase must be a function");
  }

  let runner = createRunner({ stateMachine: createRunStateMachine() });

  return Object.freeze({
    start({ runLength, previewCanvas, sustainedCanvas, previewMode }) {
      assertRunLength(runLength);
      runner = createRunner({ stateMachine: createRunStateMachine() });
      return runner.start((resources) => executeBenchmark({
        resources,
        runner,
        runLength,
        previewCanvas,
        sustainedCanvas,
        previewMode,
        onPhase,
      }));
    },
    cancel() {
      return runner.cancel();
    },
    inspect() {
      return runner.inspect();
    },
  });
}
