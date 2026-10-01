function freezeEntries(entries) {
  for (const entry of entries) {
    Object.freeze(entry.runLengths);
    Object.freeze(entry);
  }

  return Object.freeze(entries);
}

const PHASE_DEFINITIONS = freezeEntries([
  {
    id: "environment",
    label: "Checking the measurement environment",
    runLengths: ["quick", "full"],
  },
  {
    id: "cpu-single",
    label: "Measuring single-thread processor work",
    runLengths: ["quick", "full"],
  },
  {
    id: "cpu-parallel",
    label: "Measuring parallel processor work",
    runLengths: ["quick", "full"],
  },
  {
    id: "gpu",
    label: "Measuring graphics work",
    runLengths: ["quick", "full"],
  },
  {
    id: "sustained",
    label: "Measuring sustained graphics work",
    runLengths: ["full"],
  },
  {
    id: "recovery",
    label: "Checking recovery after sustained work",
    runLengths: ["full"],
  },
  {
    id: "final-check",
    label: "Checking the complete evidence set",
    runLengths: ["quick", "full"],
  },
]);

function phasesFor(runLength) {
  return Object.freeze(PHASE_DEFINITIONS
    .filter(({ runLengths }) => runLengths.includes(runLength))
    .map(({ id, label }) => Object.freeze({ id, label })));
}

export const BENCHMARK_PHASES = Object.freeze({
  quick: phasesFor("quick"),
  full: phasesFor("full"),
});

export const BENCHMARK_WORKLOAD_SEQUENCE = freezeEntries([
  {
    id: "environment",
    runLengths: ["quick", "full"],
    startPhase: "environment",
  },
  {
    id: "cpu-js-single",
    runLengths: ["quick", "full"],
    startPhase: "cpu-single",
  },
  {
    id: "cpu-wasm-single",
    runLengths: ["quick", "full"],
    startPhase: null,
  },
  {
    id: "cpu-parallel",
    runLengths: ["quick", "full"],
    startPhase: "cpu-parallel",
  },
  {
    id: "gpu",
    runLengths: ["quick", "full"],
    startPhase: "gpu",
  },
  {
    id: "sustained-and-recovery",
    runLengths: ["full"],
    startPhase: "sustained",
    requiresGpuMeasurement: true,
  },
  {
    id: "final-check",
    runLengths: ["quick", "full"],
    startPhase: "final-check",
  },
]);
