import { createRunStateMachine } from "../../src/run-state.js";
import { createRunner } from "../../src/runner.js";
import { measureSustainedAndRecovery } from "../../src/sustained-browser.js";
import { isSoftwareRenderer } from "../../src/validity.js";
import { measureCpuJsSingleThread } from "../../src/workloads/cpu-browser.js";
import { measureGpuWorkload } from "../../src/workloads/gpu-browser.js";
import { GPU_PROTOCOL_CAP_OUTCOME } from "../../src/workloads/gpu.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runT5BrowserAcceptance({
  calibrationCanvas,
  sustainedCanvas,
  previewMode,
  timerSamples,
}) {
  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const started = runner.start(async (resources) => {
    const preSustainedCpuMeasurement = await measureCpuJsSingleThread(resources);
    const gpuCalibration = await measureGpuWorkload(resources, {
      previewCanvas: calibrationCanvas,
      previewMode,
      timerSamples,
    });

    if (isSoftwareRenderer(gpuCalibration.renderer)) {
      return Object.freeze({
        acceptanceStatus: "unverified",
        detail: "A hardware GPU is unavailable for the sustained acceptance run",
      });
    }

    if (gpuCalibration.measurementStatus === GPU_PROTOCOL_CAP_OUTCOME) {
      return Object.freeze({
        acceptanceStatus: "unverified",
        detail: "The GPU-bound protocol level could not be selected on this device",
      });
    }

    return measureSustainedAndRecovery(resources, {
      previewCanvas: sustainedCanvas,
      previewMode,
      gpuConfiguration: {
        complexityLevel: gpuCalibration.complexityLevel,
        workUnitsPerTimedUnit: gpuCalibration.workUnitsPerTimedUnit,
      },
      preSustainedCpuMeasurement,
    });
  });
  assert(started.kind === "started", "The sustained run did not use the runner lifecycle");

  const outcome = await started.completion;
  assert(outcome.kind === "completed", "The sustained run did not complete");
  const report = outcome.value;

  if (report.acceptanceStatus === "unverified") {
    return report;
  }

  assert(report.validity.status === "checked", "Sustained validity was not checked");
  assert(report.validity.reasons.length === 0, "The sustained run invalidated unexpectedly");
  assert(report.sustainedResult.kind === "measured", "No sustained measurement was reported");
  assert(
    ["recovered", "not-recovered"].includes(report.sustainedResult.recoveryProbe.status),
    "The recovery probe did not report a defined status",
  );

  if (report.sustainedResult.recoveryProbe.status === "not-recovered") {
    assert(
      report.sustainedResult.decline.attribution === "unattributed",
      "A non-recovering probe did not label the decline unattributed",
    );
  } else {
    assert(
      !("attribution" in report.sustainedResult.decline),
      "A recovering probe retained an unattributed label",
    );
  }

  return report;
}
