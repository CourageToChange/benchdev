import {
  readPerformanceTimestamp,
  readReportedConcurrency,
} from "../validity-browser.js";
import { measureCpuParallelismRamp } from "./cpu-parallelism.js";
import { CPU_WARMUP_WORK_UNITS } from "./cpu-timing.js";

function createWorkerHandle({ registerWorker, registerDisposable }, workerUrl) {
  const worker = new Worker(workerUrl, { type: "module" });
  const workerRegistration = registerWorker(worker);

  if (workerRegistration.kind !== "registered") {
    throw new Error("The worker pool was created after teardown started");
  }

  const pending = new Map();

  const onMessage = ({ data }) => {
    const request = pending.get(data?.requestId);

    if (request === undefined) {
      return;
    }

    if (data.type === request.completeType) {
      pending.delete(data.requestId);
      request.resolve(data.value);
    } else if (data.type === "cpu-parallelism-failed") {
      pending.delete(data.requestId);
      request.reject(new Error(data.message));
    }
  };
  const onError = (event) => {
    const error = event.error ?? new Error(event.message);

    for (const request of pending.values()) {
      request.reject(error);
    }

    pending.clear();
  };

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  const listenerRegistration = registerDisposable(() => {
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
  });
  let nextRequestId = 1;

  function request(type, completeType, payload) {
    const requestId = nextRequestId;
    nextRequestId += 1;

    return new Promise((resolve, reject) => {
      pending.set(requestId, { completeType, resolve, reject });
      worker.postMessage({ type, requestId, ...payload });
    });
  }

  return Object.freeze({
    prepare({ warmupWorkUnits, workUnitConfiguration }) {
      return request(
        "prepare-cpu-parallelism",
        "cpu-parallelism-ready",
        { warmupWorkUnits, workUnitConfiguration },
      );
    },
    measure({ budgetMs }) {
      return request(
        "measure-cpu-parallelism",
        "cpu-parallelism-complete",
        { budgetMs },
      );
    },
    async dispose() {
      await listenerRegistration.dispose();
      await workerRegistration.dispose();
    },
  });
}

export function measureCpuParallelism(resources, {
  reportedConcurrency = readReportedConcurrency(),
  warmupWorkUnits = CPU_WARMUP_WORK_UNITS,
  effectiveWorkerLimit = Number.POSITIVE_INFINITY,
  workerUrl = new URL("./cpu-worker.js", import.meta.url),
} = {}) {
  if (typeof resources?.registerWorker !== "function"
      || typeof resources?.registerDisposable !== "function") {
    throw new TypeError("The existing runner resource scope is required");
  }

  return measureCpuParallelismRamp({
    workerFactory: () => createWorkerHandle(resources, workerUrl),
    readNow: readPerformanceTimestamp,
    reportedConcurrency,
    warmupWorkUnits,
    effectiveWorkerLimit,
  });
}
