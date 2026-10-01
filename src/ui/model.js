import { CPU_SINGLE_THREAD_BUDGET_MS } from "../workloads/cpu-timing.js";
import { CPU_PARALLELISM_RAMP_BUDGET_MS } from "../workloads/cpu-parallelism.js";
import { GPU_MEASUREMENT_BUDGET_MS } from "../workloads/gpu.js";
import {
  SUSTAINED_LOAD_DURATION_MS,
  RECOVERY_IDLE_DURATION_MS,
  RECOVERY_PROBE_DURATION_MS,
} from "../sustained.js";

// The consent screen exists so someone can agree to a known thermal cost, so the number on it has
// to be true. It is DERIVED from the protocol's own budgets rather than typed.
//
// 🔴 IT WAS TYPED, AND IT DRIFTED WITHIN A DAY. "20 seconds" was written when the CPU phase held
// one single-thread workload. Wiring up the WASM kernel added a second five-second budget and
// nothing recomputed the label, so the screen promised 20 seconds for a run measured at 23.6 s.
// A hardcoded duration beside a protocol that can gain a workload is a promise waiting to go stale.
//
// ⚠️ The budgets are measurement time only. Worker spawn, fetching and instantiating the WASM
// binary, the GPU complexity ramp and teardown are real seconds the person waits and appear in no
// budget. Measured on the reference device 2026-08-28: Quick 23.6 s against 20 s of budget, Full
// 72.5 s against 68 s, so the overhead is roughly constant rather than proportional. A slower
// device will spend longer still, which is why the copy says "about".
const RUN_OVERHEAD_ALLOWANCE_MS = 5_000;

const QUICK_BUDGET_MS = (CPU_SINGLE_THREAD_BUDGET_MS * 2)
  + CPU_PARALLELISM_RAMP_BUDGET_MS
  + GPU_MEASUREMENT_BUDGET_MS;
const FULL_BUDGET_MS = QUICK_BUDGET_MS
  + SUSTAINED_LOAD_DURATION_MS
  + RECOVERY_IDLE_DURATION_MS
  + RECOVERY_PROBE_DURATION_MS;

const advertisedSeconds = (budgetMs) =>
  Math.round((budgetMs + RUN_OVERHEAD_ALLOWANCE_MS) / 1000);

export const UI_SCREENS = Object.freeze([
  "idle",
  "consent",
  "running",
  "result",
  "unscored",
]);

export const RUN_LENGTHS = Object.freeze({
  quick: Object.freeze({
    id: "quick",
    label: "Quick",
    seconds: advertisedSeconds(QUICK_BUDGET_MS),
    durationLabel: `about ${advertisedSeconds(QUICK_BUDGET_MS)} seconds`,
  }),
  full: Object.freeze({
    id: "full",
    label: "Full",
    seconds: advertisedSeconds(FULL_BUDGET_MS),
    durationLabel: `about ${advertisedSeconds(FULL_BUDGET_MS)} seconds`,
  }),
});

const OUTCOME_TO_SCREEN = Object.freeze({
  scored: "result",
  invalid: "unscored",
  failed: "unscored",
});

export const MEASUREMENT_LABELS = Object.freeze({
  cpuJsSingleThreadThroughput: "CPU JavaScript single thread",
  cpuWasmSingleThreadThroughput: "CPU WASM single thread",
  cpuParallelThroughput: "CPU parallel",
  gpuSustainedWorkRate: "GPU",
});

export const UNSCORED_REASON_COPY = Object.freeze({
  "tab-backgrounded": Object.freeze({
    headline: "The measured window was interrupted",
    mechanism: "The tab was not in front for the whole measured window. Background tabs can receive less processor time, so no score was produced.",
    action: "Keep this tab in front, then run the test again.",
  }),
  "display-regime-changed": Object.freeze({
    headline: "Display timing changed",
    mechanism: "The display cadence changed between the opening and closing checks. That change can move the measured graphics rate.",
    action: "Keep the device power mode and display conditions unchanged, then run the test again.",
  }),
  "software-renderer-detected": Object.freeze({
    headline: "Hardware graphics were unavailable",
    mechanism: "The browser used a software graphics renderer. That would measure processor work in place of graphics hardware.",
    action: "Enable hardware acceleration in browser settings, restart the browser, then run the test again.",
  }),
  "webgl-context-lost": Object.freeze({
    headline: "The graphics context ended early",
    mechanism: "The browser closed the WebGL context before the measured work was complete, so the graphics reading cannot support a score.",
    action: "Close other graphics-heavy pages or applications, then run the test again.",
  }),
  "workload-checksum-mismatch": Object.freeze({
    headline: "A workload integrity check disagreed",
    mechanism: "A computed result did not match the independent checksum. The amount of work completed cannot be trusted.",
    action: "Reload BenchDev, then run the test again.",
  }),
  "timer-clamp-too-coarse": Object.freeze({
    headline: "The timer could not resolve the work",
    mechanism: "The browser timer advanced in steps larger than the shortest measured work unit. Timing at that resolution could produce a plausible but unsupported number.",
    action: "Use the browser's standard privacy settings or another supported browser, then run the test again.",
  }),
  "parallelism-irreconcilable": Object.freeze({
    headline: "The processor readings disagreed",
    mechanism: "Measured parallel work could not be reconciled with the processor count reported by the browser.",
    action: "Restart the browser with its standard settings, then run the test again.",
  }),
  "wasm-hash-mismatch": Object.freeze({
    headline: "The verified workload did not match",
    mechanism: "The downloaded WASM file did not match the hash of the audited workload source.",
    action: "Reload BenchDev to fetch one consistent set of files, then run the test again.",
  }),
});

export const RUN_STOPPED_COPY = Object.freeze({
  headline: "The run stopped before a score was ready",
  mechanism: "A browser or workload operation ended before the complete evidence set was available.",
  action: "Copy the diagnostic JSON, reload BenchDev, then run the test again.",
});

function assertRunLength(runLength) {
  if (!Object.hasOwn(RUN_LENGTHS, runLength)) {
    throw new TypeError("runLength must be quick or full");
  }
}

export function screenForState(state) {
  if (UI_SCREENS.includes(state)) {
    return state;
  }

  const screen = OUTCOME_TO_SCREEN[state];

  if (screen === undefined) {
    throw new TypeError("Unknown UI state or run outcome");
  }

  return screen;
}

export function createConsentSession(initialRunLength = "quick") {
  assertRunLength(initialRunLength);
  let runLength = initialRunLength;
  let screen = "idle";
  const consented = new Set();

  return Object.freeze({
    get runLength() {
      return runLength;
    },
    get screen() {
      return screen;
    },
    select(nextRunLength) {
      assertRunLength(nextRunLength);
      runLength = nextRunLength;
      screen = "idle";
      return screen;
    },
    requestRun() {
      screen = consented.has(runLength) ? "running" : "consent";
      return screen;
    },
    grantConsent() {
      consented.add(runLength);
      screen = "running";
      return screen;
    },
    back() {
      screen = "idle";
      return screen;
    },
    finish(outcomeKind) {
      screen = screenForState(outcomeKind);
      return screen;
    },
    wasConsented(candidate) {
      assertRunLength(candidate);
      return consented.has(candidate);
    },
  });
}

export function copyForReason(reasonId) {
  return UNSCORED_REASON_COPY[reasonId] ?? Object.freeze({
    headline: "The evidence set was incomplete",
    mechanism: "A recorded condition means this run cannot support a BenchDev score.",
    action: "Copy the diagnostic JSON, then run the test again.",
  });
}

export function formatScore(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("A score must be a positive finite number");
  }

  return String(Math.round(value));
}

export function scoreAxisPosition(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("A score must be a positive finite number");
  }

  return Math.min(96, Math.max(4, 50 + Math.log2(value / 100) * 18));
}

export function formatElapsed(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new TypeError("Elapsed time must be a non-negative finite number");
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatMeasuredValue(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError("A measured value must be finite");
  }

  if (Math.abs(value) >= 100) {
    return Math.round(value).toLocaleString("en-GB");
  }

  return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

export function referenceLandmark(baselineSet, protocolVersion) {
  const matches = baselineSet?.entries?.filter((entry) => (
    entry?.protocolVersion === protocolVersion
  )) ?? [];

  if (matches.length !== 1) {
    throw new RangeError("Exactly one reference device must match the protocol");
  }

  const reference = matches[0].referenceDevice;

  if (typeof reference?.model !== "string" || typeof reference.measuredMonth !== "string") {
    throw new TypeError("The reference device needs a model and measured month");
  }

  return `100 = ${reference.model}, ${reference.measuredMonth}`;
}

export function browserIdentity({ userAgentData = null, userAgent = "" } = {}) {
  const brands = userAgentData?.brands ?? userAgentData?.fullVersionList;

  if (Array.isArray(brands)) {
    const candidates = brands.filter(({ brand }) => !/not.?a.?brand/i.test(brand));
    const selected = candidates.find(({ brand }) => !/^Chromium$/i.test(brand))
      ?? candidates[0];

    if (selected !== undefined) {
      return Object.freeze({ name: selected.brand, version: String(selected.version).split(".")[0] });
    }
  }

  const patterns = [
    ["Microsoft Edge", /Edg\/([\d.]+)/],
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];

  for (const [name, pattern] of patterns) {
    const match = pattern.exec(userAgent);

    if (match !== null) {
      return Object.freeze({ name, version: match[1].split(".")[0] });
    }
  }

  return Object.freeze({ name: "Unknown browser", version: "unknown" });
}
