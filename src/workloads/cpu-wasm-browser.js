import { verifyThenInstantiateCpuWasm } from "./cpu-wasm.js";
import {
  CPU_SINGLE_THREAD_BUDGET_MS,
  CPU_WARMUP_WORK_UNITS,
} from "./cpu-timing.js";

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function digestSha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function instantiate(bytes) {
  return WebAssembly.instantiate(bytes, {});
}

export async function loadCpuWasm(url, expectedSha256) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Unable to load the WASM kernel: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  return verifyThenInstantiateCpuWasm({
    bytes,
    expectedSha256,
    digestSha256,
    instantiate,
  });
}

export function measureCpuWasmSingleThread({
  registerWorker,
  registerDisposable,
}, {
  budgetMs = CPU_SINGLE_THREAD_BUDGET_MS,
  warmupWorkUnits = CPU_WARMUP_WORK_UNITS,
  workUnitConfiguration = null,
  workerUrl = new URL("./cpu-worker.js", import.meta.url),
  wasmUrl = new URL("./cpu.wasm", import.meta.url),
} = {}) {
  if (typeof registerWorker !== "function" || typeof registerDisposable !== "function") {
    throw new TypeError("The existing runner resource scope is required");
  }

  const worker = new Worker(workerUrl, { type: "module" });
  registerWorker(worker);

  return new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data?.type === "cpu-wasm-single-thread-complete") {
        resolve(data.measurement);
      } else if (data?.type === "cpu-wasm-single-thread-failed") {
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
      type: "measure-wasm-single-thread",
      budgetMs,
      warmupWorkUnits,
      workUnitConfiguration,
      wasmUrl: String(wasmUrl),
    });
  });
}
