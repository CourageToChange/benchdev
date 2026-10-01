import {
  CPU_JS_DEFAULT_WORK_UNIT_CONFIGURATION,
  createCpuJsWorkUnit,
  deriveCpuJsWorkUnitConfiguration,
} from "./cpu-js.js";
import {
  calibrateWorkUnit,
  measureFixedBudgetWorkload,
  warmUpWorkload,
} from "./cpu-timing.js";
import {
  CPU_WASM_DEFAULT_WORK_UNIT_CONFIGURATION,
  CPU_WASM_SHA256,
  createCpuWasmWorkUnit,
  deriveCpuWasmWorkUnitConfiguration,
} from "./cpu-wasm.js";
import { loadCpuWasm } from "./cpu-wasm-browser.js";

let preparedCpuJsWorkUnit = null;

function prepareCpuJsWorkUnit({ warmupWorkUnits, workUnitConfiguration = null }) {
  const initial = createCpuJsWorkUnit(
    workUnitConfiguration ?? CPU_JS_DEFAULT_WORK_UNIT_CONFIGURATION,
  );
  const workloadChecksums = warmUpWorkload({
    runWorkUnit: initial.runWorkUnit,
    warmupWorkUnits,
  });

  preparedCpuJsWorkUnit = workUnitConfiguration === null
    ? calibrateWorkUnit({
      runCalibrationWorkUnit: initial.runWorkUnit,
      createScaledWorkUnit: (scale) => createCpuJsWorkUnit(
        deriveCpuJsWorkUnitConfiguration(scale),
      ),
      readNow: () => performance.now(),
    })
    : initial;

  return Object.freeze({
    workloadChecksums,
    workUnitConfiguration: preparedCpuJsWorkUnit.configuration,
  });
}

function measurePreparedCpuJsWorkUnit(budgetMs) {
  if (preparedCpuJsWorkUnit === null) {
    throw new Error("The CPU JS work unit must be prepared before measurement");
  }

  const measurement = measureFixedBudgetWorkload({
    runWorkUnit: preparedCpuJsWorkUnit.runWorkUnit,
    readNow: () => performance.now(),
    budgetMs,
    warmupWorkUnits: 0,
    workAmountPerUnit: preparedCpuJsWorkUnit.workAmountPerUnit,
  });

  return Object.freeze({
    ...measurement,
    workUnitConfiguration: preparedCpuJsWorkUnit.configuration,
  });
}

async function measureCpuWasmSingleThread({
  budgetMs,
  warmupWorkUnits,
  wasmUrl,
  workUnitConfiguration = null,
}) {
  const loaded = await loadCpuWasm(wasmUrl, CPU_WASM_SHA256);

  if (loaded.kind === "hash-mismatch") {
    return loaded;
  }

  const run = loaded.instance.exports.run;
  const initialConfiguration = workUnitConfiguration
    ?? CPU_WASM_DEFAULT_WORK_UNIT_CONFIGURATION;
  const initialRunWorkUnit = createCpuWasmWorkUnit(run, initialConfiguration);
  const workloadChecksums = warmUpWorkload({
    runWorkUnit: initialRunWorkUnit,
    warmupWorkUnits,
  });
  const prepared = workUnitConfiguration === null
    ? calibrateWorkUnit({
      runCalibrationWorkUnit: initialRunWorkUnit,
      createScaledWorkUnit: (scale) => {
        const configuration = deriveCpuWasmWorkUnitConfiguration(scale);

        return Object.freeze({
          configuration,
          runWorkUnit: createCpuWasmWorkUnit(run, configuration),
          workAmountPerUnit: configuration.workAmount,
        });
      },
      readNow: () => performance.now(),
    })
    : Object.freeze({
      configuration: initialConfiguration,
      runWorkUnit: initialRunWorkUnit,
      workAmountPerUnit: initialConfiguration.workAmount,
    });
  const measured = measureFixedBudgetWorkload({
    runWorkUnit: prepared.runWorkUnit,
    readNow: () => performance.now(),
    budgetMs,
    warmupWorkUnits: 0,
    workAmountPerUnit: prepared.workAmountPerUnit,
  });

  return Object.freeze({
    ...measured,
    wasm: loaded.wasm,
    workUnitConfiguration: prepared.configuration,
    workloadChecksums: Object.freeze([
      ...workloadChecksums,
      ...measured.workloadChecksums,
    ]),
  });
}

self.addEventListener("message", ({ data }) => {
  if (data?.type === "measure-wasm-single-thread") {
    void measureCpuWasmSingleThread(data).then(
      (measurement) => self.postMessage({
        type: "cpu-wasm-single-thread-complete",
        measurement,
      }),
      (error) => self.postMessage({
        type: "cpu-wasm-single-thread-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  if (data?.type === "prepare-cpu-parallelism") {
    try {
      const preparation = prepareCpuJsWorkUnit({
        warmupWorkUnits: data.warmupWorkUnits,
        workUnitConfiguration: data.workUnitConfiguration ?? null,
      });

      self.postMessage({
        type: "cpu-parallelism-ready",
        requestId: data.requestId,
        value: preparation,
      });
    } catch (error) {
      self.postMessage({
        type: "cpu-parallelism-failed",
        requestId: data.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (data?.type === "measure-cpu-parallelism") {
    try {
      const measurement = measurePreparedCpuJsWorkUnit(data.budgetMs);

      self.postMessage({
        type: "cpu-parallelism-complete",
        requestId: data.requestId,
        value: measurement,
      });
    } catch (error) {
      self.postMessage({
        type: "cpu-parallelism-failed",
        requestId: data.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (data?.type !== "measure-js-single-thread") {
    return;
  }

  try {
    const preparation = prepareCpuJsWorkUnit({
      warmupWorkUnits: data.warmupWorkUnits,
      workUnitConfiguration: data.workUnitConfiguration ?? null,
    });
    const measured = measurePreparedCpuJsWorkUnit(data.budgetMs);
    const measurement = Object.freeze({
      ...measured,
      workloadChecksums: Object.freeze([
        ...preparation.workloadChecksums,
        ...measured.workloadChecksums,
      ]),
    });

    self.postMessage({
      type: "cpu-js-single-thread-complete",
      measurement,
    });
  } catch (error) {
    self.postMessage({
      type: "cpu-js-single-thread-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
