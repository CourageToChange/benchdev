import {
  CPU_SINGLE_THREAD_BUDGET_MS,
  CPU_WARMUP_WORK_UNITS,
} from "./cpu-timing.js";

export function measureCpuJsSingleThread({
  registerWorker,
  registerDisposable,
}, {
  budgetMs = CPU_SINGLE_THREAD_BUDGET_MS,
  warmupWorkUnits = CPU_WARMUP_WORK_UNITS,
  workUnitConfiguration = null,
  workerUrl = new URL("./cpu-worker.js", import.meta.url),
} = {}) {
  if (typeof registerWorker !== "function" || typeof registerDisposable !== "function") {
    throw new TypeError("The existing runner resource scope is required");
  }

  const worker = new Worker(workerUrl, { type: "module" });
  registerWorker(worker);

  return new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data?.type === "cpu-js-single-thread-complete") {
        resolve(data.measurement);
      } else if (data?.type === "cpu-js-single-thread-failed") {
        reject(new Error(data.message));
      }
    };
    const onError = (event) => reject(event.error ?? new Error(event.message));

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    registerDisposable(() => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    });

    worker.postMessage({
      type: "measure-js-single-thread",
      budgetMs,
      warmupWorkUnits,
      workUnitConfiguration,
    });
  });
}
