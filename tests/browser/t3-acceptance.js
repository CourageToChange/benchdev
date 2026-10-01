import { createRunStateMachine } from "../../src/run-state.js";
import { createRunner } from "../../src/runner.js";
import { measureCpuParallelism } from "../../src/workloads/cpu-parallel-browser.js";

const PARALLEL_MINIMUM_SCALING = 1.5;
const SERIAL_CONTROL_MINIMUM_SCALING = 0.8;
const SERIAL_CONTROL_MAXIMUM_SCALING = 1.2;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runRamp(runner, effectiveWorkerLimit) {
  const started = runner.start((resources) => measureCpuParallelism(resources, {
    effectiveWorkerLimit,
  }));
  assert(started.kind === "started", "The ramp did not use the existing runner lifecycle");

  const outcome = await started.completion;
  assert(outcome.kind === "completed", "The parallelism ramp did not complete");
  return outcome.value;
}

// This file carries real-browser acceptance assertions for a future Playwright
// invocation. It is intentionally not reported green by the bare Node suite.
export async function runT3BrowserAcceptance() {
  const reportedConcurrency = navigator.hardwareConcurrency ?? null;
  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const parallel = await runRamp(runner, Number.POSITIVE_INFINITY);
  const serialControl = await runRamp(runner, 1);

  assert(
    serialControl.scalingFactor >= SERIAL_CONTROL_MINIMUM_SCALING
      && serialControl.scalingFactor <= SERIAL_CONTROL_MAXIMUM_SCALING,
    `The serialised control scaled ${serialControl.scalingFactor}x instead of approximately 1.0x`,
  );

  if (reportedConcurrency !== null && reportedConcurrency >= 4) {
    assert(
      parallel.scalingFactor >= PARALLEL_MINIMUM_SCALING,
      `The parallel ramp scaled ${parallel.scalingFactor}x instead of at least 1.5x`,
    );
  }

  assert(
    parallel.reportedConcurrency === reportedConcurrency,
    "The ramp did not retain the browser-reported concurrency fact",
  );
  assert(
    parallel.measuredConcurrency === parallel.peakPoolSize,
    "Measured concurrency was not the pool size with peak aggregate throughput",
  );

  return Object.freeze({ parallel, serialControl });
}
