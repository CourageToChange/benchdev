export const BASELINE_VERSION = 1;

const TODO_NOTE = "TODO: measure";

function unmeasured(unit) {
  return {
    value: null,
    unit,
    provenance: {
      deviceModel: null,
      osName: null,
      osVersion: null,
      browserName: null,
      browserVersion: null,
      measuredMonth: null,
      runCount: null,
      aggregationMethod: null,
      source: null,
      note: TODO_NOTE,
    },
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }

  return value;
}

function measured(value, unit, extra = {}) {
  return {
    value,
    unit,
    provenance: {
      deviceModel: "Desktop: AMD Ryzen 7 5800X3D (8C/16T), AMD Radeon RX 9070 XT, 32 GB",
      osName: "Windows",
      osVersion: "11 Pro 10.0.26200",
      browserName: "Chromium (headless, driven by Playwright)",
      browserVersion: "149.0.7827.55",
      measuredMonth: "2026-08",
      runCount: 5,
      aggregationMethod: "median of runs 2..6 through the app; the first run is discarded as warm-up",
      source: "tests/browser/production-baseline.mjs, measured THROUGH THE APPLICATION",
      note: null,
      ...extra,
    },
  };
}

export const BASELINES = deepFreeze({
  baselineVersion: BASELINE_VERSION,
  entries: [
    {
      // ⭐ Comparison is against NAMED devices, never a distribution. This is one named
      // device measured once, not "typical hardware", and the id says which one.
      id: "desktop-ryzen-7-5800x3d-rx-9070-xt",
      protocolVersion: 5,
      referenceDevice: {
        model: "Desktop: AMD Ryzen 7 5800X3D (8C/16T), AMD Radeon RX 9070 XT, 32 GB",
        osName: "Windows",
        osVersion: "11 Pro 10.0.26200",
        browserName: "Chromium (headless, driven by Playwright)",
        browserVersion: "149.0.7827.55",
        measuredMonth: "2026-08",
        note: "Measured 2026-08-28, all four quantities in ONE headless run so they share provenance. ⚠️ The browser is HEADLESS Chromium with ANGLE forced to real "
          + "hardware, not the user's everyday Chrome, and that is part of what these numbers mean.",
      },
      measurements: {
        // Through the app: 213, 214, 212, 213, 212, 213 -> median of runs 2-6, spread 1.21%.
        cpuJsSingleThreadThroughput: measured(212.9, "work units/second"),

        // ✅ MEASURED 2026-08-28, once the kernel was finally reachable from a page. Until then
        // `cpu-wasm-browser.js` exported only a loader that NOTHING imported, so the committed
        // binary was never loaded and never timed, and the whole unit suite was green through it.
        // Through the app: 595, 592, 590, 590, 590, 597 -> median of runs 2-6, spread 1.30%.
        // Its raw rate is 2.8x the JS figure, but a WASM unit is only the integer half
        // of a JS unit, so the two rates are not comparable with each other.
        cpuWasmSingleThreadThroughput: measured(590.2, "work units/second"),

        // ✅ MEASURED AT LAST, AND THE 22% VARIANCE WAS MY HARNESS, NOT THE PRODUCT.
        // Gate 4 (ARCH-08) spotted that `measure-baseline.js` gives each workload its OWN runner,
        // so its workers are terminated before the next begins, while a real run puts all four in
        // ONE scope with the JS and WASM workers still resident. Measured through the actual
        // application instead: 1187, 1220, 1241, 1233, 1227, 1236 -> spread **1.72%**, against the
        // 22 to 25% I recorded from the harness and spent a settle experiment on.
        // ⚠️ So my earlier conclusion, "a settle does not fix it", was answering the wrong
        // question. A written diagnosis is a hypothesis, and so is your own harness.
        // **Measure through the path the user takes.**
        cpuParallelThroughput: measured(1232.6, "work units/second"),

        // Through the app: 230783, 231917, 232109, 231908, 232041, 231177 -> median of runs 2-6,
        // spread 0.40%. Slightly below the harness figure, measured on a warmer machine.
        gpuSustainedWorkRate: measured(231917, "work units/second", {
          note: "complexity level 32768; per-run coefficient of variation 0.005-0.006",
        }),
      },
      // Peak pool size was 8 while navigator.hardwareConcurrency reported 16. 8 is also
      // the largest pool the ramp tries, so this run does not show whether 16 threads
      // would have done more.
      observedConcurrency: { reported: 16, measuredPeakPoolSize: 8 },
    },
  ],
});
