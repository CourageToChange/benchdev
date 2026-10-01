// Measure this device's four protocol quantities, so a real baseline can be recorded.
//
// 🔴 THIS EXISTS BECAUSE `baselines.js` SHIPS `null` WITH `TODO: measure` ON EVERY NUMBER,
// deliberately: a fabricated baseline poisons every score derived from it. The only honest way
// to fill it in is to run the real workloads on a named device and write down what they returned,
// together with the browser and the date, because those are part of what the number MEANS.
//
// ⚠️ It reports the numbers and nothing else. It does not write `baselines.js`, because deciding
// that a given device is THE reference is a judgement, not a measurement.
import { createRunner } from "../../src/runner.js";
import { createRunStateMachine } from "../../src/run-state.js";
import { measureCpuJsSingleThread } from "../../src/workloads/cpu-browser.js";
import { measureCpuWasmSingleThread } from "../../src/workloads/cpu-wasm-browser.js";
import { measureCpuParallelism } from "../../src/workloads/cpu-parallel-browser.js";
import { measureGpuWorkload } from "../../src/workloads/gpu-browser.js";

async function runOnce(work) {
  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const started = runner.start(work);
  if (started.kind !== "started") throw new Error("the runner refused to start");
  const outcome = await started.completion;
  if (outcome.kind !== "completed") {
    // ⚠️ Say WHAT failed. A bare "failed" sends you looking in the wrong place: the payload key
    // differs per outcome kind, and the teardown errors are where a GPU fault actually surfaces.
    const detail = JSON.stringify({
      kind: outcome.kind,
      error: outcome.error?.message ?? outcome.error ?? null,
      reason: outcome.reason ?? null,
      teardownErrors: (outcome.teardownErrors ?? []).map((e) => e?.message ?? String(e)),
    });
    throw new Error(`workload did not complete: ${detail}`);
  }
  return outcome.value;
}

// 🔴 A CANVAS CAN ONLY EVER HOLD ONE WebGL CONTEXT, so every GPU run gets its own. Reusing one
// across the repeats fails the second run with "WEBGL_lose_context is required for deterministic
// teardown", because the first run's teardown already killed that context. This is written in
// harness.html for exactly the same reason and I still repeated it here.
const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function measureBaseline({ makeCanvas, repeats = 3, only = null, settleMs = 0 } = {}) {
  const samples = {
    cpuJsSingleThreadThroughput: [],
    cpuWasmSingleThreadThroughput: [],
    cpuParallelThroughput: [],
    cpuParallelPoolSize: [],
    gpuSustainedWorkRate: [],
  };

  for (let i = 0; i < repeats; i += 1) {
    if (!only || only === "cpu" || only === "js") {
      const cpu = await runOnce((resources) => measureCpuJsSingleThread(resources));
      samples.cpuJsSingleThreadThroughput.push(cpu.throughput);
    }

    if (!only || only === "cpu" || only === "wasm") {
      const wasm = await runOnce((resources) => measureCpuWasmSingleThread(resources));
      samples.cpuWasmSingleThreadThroughput.push(wasm.throughput);
    }

    if (!only || only === "parallel") {
      // ⏸️ An optional quiet interval before the parallel measurement. This exists to TEST a
      // hypothesis, not because a delay is assumed to help: measured alone the parallel workload
      // is stable at 1.9%, and measured in sequence it swings 22-25%. If a settle closes that gap
      // the cause is residual load from the previous workload; if it does not, the cause is
      // something else and a delay would be superstition.
      if (settleMs > 0) await idle(settleMs);
      const parallel = await runOnce((resources) => measureCpuParallelism(resources));
      samples.cpuParallelThroughput.push(parallel.peakAggregateThroughput);
      samples.cpuParallelPoolSize.push(parallel.peakPoolSize);
    }

    if (only && only !== "gpu") continue;
    const gpu = await runOnce((resources) => measureGpuWorkload(resources, {
      previewCanvas: makeCanvas(),
      previewMode: "standard",
    }));
    samples.gpuSustainedWorkRate.push({
      status: gpu.measurementStatus,
      rate: gpu.gpuMeasurement?.sustainedWorkRate ?? null,
      complexity: gpu.complexityLevel ?? null,
      cv: gpu.gpuMeasurement?.coefficientOfVariation ?? null,
    });
  }

  return {
    samples,
    environment: {
      userAgent: navigator.userAgent,
      reportedConcurrency: navigator.hardwareConcurrency ?? null,
      devicePixelRatio: window.devicePixelRatio,
      measuredAt: new Date().toISOString(),
    },
  };
}
