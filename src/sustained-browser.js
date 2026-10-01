import {
  cancelIdleCadenceReading,
  observeVisibilityStates,
  requestIdleCadenceReading,
} from "./validity-browser.js";
import { evaluateSustainedValidity } from "./validity.js";
import {
  deriveSustainedProtocol,
  shouldRunRecoveryProbe,
  summariseSustainedPhase,
} from "./sustained.js";
import { measureCpuJsSingleThread } from "./workloads/cpu-browser.js";
import { measureGpuSustainedLoad } from "./workloads/gpu-browser.js";

function assertRunnerResources(resources) {
  if (typeof resources?.registerDisposable !== "function"
      || typeof resources?.registerTimer !== "function"
      || resources.signal === null
      || typeof resources.signal !== "object") {
    throw new TypeError("The existing runner resource scope is required");
  }
}

function cancellationError() {
  return new Error("The sustained phase was cancelled");
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
        requestId = null;
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

    const onAbort = () => finish(reject, cancellationError());
    const onFrame = (timestamp) => {
      requestId = null;
      timestamps.push(timestamp);

      if (timestamps.length === frameCount) {
        finish(resolve, Object.freeze(timestamps));
        return;
      }

      requestId = requestIdleCadenceReading(onFrame);
    };

    resources.signal.addEventListener("abort", onAbort, { once: true });
    registration = resources.registerDisposable(cleanup);
    requestId = requestIdleCadenceReading(onFrame);
  });
}

function waitForIdle(resources, durationMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timerRegistration;
    let listenerRegistration;

    const finish = (complete, value) => {
      if (settled) {
        return;
      }

      settled = true;
      resources.signal.removeEventListener("abort", onAbort);
      void timerRegistration.dispose();
      void listenerRegistration.dispose();
      complete(value);
    };
    const onAbort = () => finish(reject, cancellationError());
    const timerId = setTimeout(() => finish(resolve), durationMs);

    timerRegistration = resources.registerTimer(timerId);
    resources.signal.addEventListener("abort", onAbort, { once: true });
    listenerRegistration = resources.registerDisposable(() => {
      resources.signal.removeEventListener("abort", onAbort);
    });
  });
}

function freezeReport(report) {
  for (const value of Object.values(report)) {
    if (value !== null && typeof value === "object") {
      Object.freeze(value);
    }
  }

  return Object.freeze(report);
}

export async function measureSustainedAndRecovery(resources, {
  previewCanvas,
  previewMode,
  gpuConfiguration,
  preSustainedCpuMeasurement,
} = {}) {
  assertRunnerResources(resources);

  if (!Number.isFinite(preSustainedCpuMeasurement?.throughput)
      || preSustainedCpuMeasurement.throughput <= 0
      || preSustainedCpuMeasurement.workUnitConfiguration === null
      || typeof preSustainedCpuMeasurement.workUnitConfiguration !== "object") {
    throw new TypeError("The opening CPU measurement and its fixed work unit are required");
  }

  const protocol = deriveSustainedProtocol();
  const visibilityStates = [];
  const stopVisibilityObserver = observeVisibilityStates((state) => {
    visibilityStates.push(state);
  });
  const visibilityRegistration = resources.registerDisposable(stopVisibilityObserver);
  const beforeTimestamps = await collectIdleCadence(
    resources,
    protocol.idleCadenceFrameCount,
  );
  const gpuLoad = await measureGpuSustainedLoad(resources, {
    previewCanvas,
    previewMode,
    configuration: gpuConfiguration,
    durationMs: protocol.sustainedLoadDurationMs,
  });
  const afterTimestamps = await collectIdleCadence(
    resources,
    protocol.idleCadenceFrameCount,
  );

  await visibilityRegistration.dispose();
  const validity = evaluateSustainedValidity({
    visibilityStates,
    idleCadence: { beforeTimestamps, afterTimestamps },
  });

  if (!shouldRunRecoveryProbe(validity)) {
    return freezeReport({
      sustainedResult: summariseSustainedPhase({ validity }),
      validity,
      gpuLoad,
      recoveryMeasurement: null,
    });
  }

  await waitForIdle(resources, protocol.recoveryIdleDurationMs);
  const recoveryMeasurement = await measureCpuJsSingleThread(resources, {
    budgetMs: protocol.recoveryProbeDurationMs,
    workUnitConfiguration: preSustainedCpuMeasurement.workUnitConfiguration,
  });
  const sustainedResult = summariseSustainedPhase({
    validity,
    samples: gpuLoad.samples,
    preSustainedCpuThroughput: preSustainedCpuMeasurement.throughput,
    recoveryCpuThroughput: recoveryMeasurement.throughput,
  });

  return freezeReport({
    sustainedResult,
    validity,
    gpuLoad,
    recoveryMeasurement,
  });
}
