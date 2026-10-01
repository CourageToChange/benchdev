import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BASELINES } from "../src/baselines.js";
import { SCORING_VERSION } from "../src/scoring.js";
import {
  createComparisonTableState,
  EMPTY_COMPARISON_MESSAGE,
  readCorpus,
  validateCorpusRecord,
} from "../src/corpus.js";

function detected(overrides = {}) {
  return {
    browser: { name: "Example Browser", majorVersion: 1 },
    osFamily: "Example OS",
    reportedConcurrency: { value: 4, unit: "logical processors" },
    measuredParallelism: { value: 3, unit: "workers" },
    gpuRenderer: "Example Renderer",
    devicePixelRatio: { value: 2, unit: "ratio" },
    ...overrides,
  };
}

function scoredRecord(protocolVersion, overrides = {}) {
  return {
    kind: "scored",
    schemaVersion: 1,
    protocolVersion,
    scoringVersion: 1,
    baselineVersion: 1,
    previewMode: "standard",
    capturedMonth: "2026-08",
    detected: detected(),
    score: { value: 100, unit: "BenchDev points" },
    subScores: [{ id: "cpu", value: 100, unit: "BenchDev points" }],
    ...overrides,
  };
}

function corpus(entries) {
  return {
    schemaVersion: 1,
    corpusVersion: 1,
    buildMonth: "2026-08",
    entries,
  };
}

test("a record at another protocolVersion is absent from the grouped output", () => {
  const current = scoredRecord(2, { detected: detected({ gpuRenderer: "Current" }) });
  const stale = scoredRecord(1, { detected: detected({ gpuRenderer: "Stale" }) });

  const grouped = readCorpus(corpus([stale, current]), { protocolVersion: 2, scoringVersion: 1 });
  const state = createComparisonTableState(grouped.entries);

  assert.equal(grouped.entries.length, 1);
  assert.equal(grouped.entries[0].detected.gpuRenderer, "Current");
  assert.equal(grouped.entries.some(({ protocolVersion }) => protocolVersion === 1), false);
  assert.equal(state.kind, "table");
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].detected.gpuRenderer, "Current");
});

test("a claimed label is distinguishable from detected-only machine facts", () => {
  const detectedOnly = scoredRecord(1);
  const labelled = scoredRecord(1, {
    label: { value: "Example Laptop", claimed: true },
  });

  const grouped = readCorpus(
    corpus([detectedOnly, labelled]),
    { protocolVersion: 1, scoringVersion: 1 },
  );

  assert.equal(Object.hasOwn(grouped.entries[0], "label"), false);
  assert.deepEqual(grouped.entries[1].label, {
    value: "Example Laptop",
    claimed: true,
  });
  assert.notDeepEqual(grouped.entries[1].label, grouped.entries[1].detected);
});

test("the comparison state keeps a claimed label separate from detected facts", () => {
  const labelled = scoredRecord(1, {
    label: { value: "Example Laptop", claimed: true },
  });

  const state = createComparisonTableState([labelled]);

  assert.equal(state.kind, "table");
  assert.deepEqual(state.rows[0].label, {
    kind: "claimed",
    value: "Example Laptop",
  });
  assert.deepEqual(state.rows[0].detected, labelled.detected);
  assert.notDeepEqual(state.rows[0].label, state.rows[0].detected);
});

test("an empty corpus becomes an explicit empty comparison state", () => {
  const grouped = readCorpus(corpus([]), { protocolVersion: 1, scoringVersion: 1 });
  const state = createComparisonTableState(grouped.entries);

  assert.deepEqual(state, {
    kind: "empty",
    message: EMPTY_COMPARISON_MESSAGE,
  });
  assert.equal(state.message, "No comparison devices yet.");
});

test("comparison devices are sorted by score while equal scores keep corpus order", () => {
  const firstEqual = scoredRecord(1, {
    detected: detected({ gpuRenderer: "First equal" }),
    score: { value: 80, unit: "BenchDev points" },
  });
  const fastest = scoredRecord(1, {
    detected: detected({ gpuRenderer: "Fastest" }),
    score: { value: 120, unit: "BenchDev points" },
  });
  const secondEqual = scoredRecord(1, {
    detected: detected({ gpuRenderer: "Second equal" }),
    score: { value: 80, unit: "BenchDev points" },
  });

  const state = createComparisonTableState([firstEqual, fastest, secondEqual]);

  assert.deepEqual(
    state.rows.map(({ detected: facts }) => facts.gpuRenderer),
    ["Fastest", "First equal", "Second equal"],
  );
});

test("schemaVersion is validated before corpus records are used", () => {
  assert.throws(
    () => readCorpus(
      { ...corpus([scoredRecord(1)]), schemaVersion: 2 },
      { protocolVersion: 1, scoringVersion: 1 },
    ),
    /schema/u,
  );

  assert.throws(
    () => readCorpus(
      corpus([{ ...scoredRecord(1), schemaVersion: 2 }]),
      { protocolVersion: 1, scoringVersion: 1 },
    ),
    /schemaVersion/u,
  );
});

test("an invalid corpus record cannot carry a score", () => {
  assert.equal(validateCorpusRecord({
    kind: "invalid",
    schemaVersion: 1,
    protocolVersion: 1,
    baselineVersion: 1,
    previewMode: "standard",
    capturedMonth: "2026-08",
    detected: detected(),
    reasons: ["tab-hidden"],
    score: null,
  }), false);
});

test("the static corpus contains only the measured named baseline device", () => {
  const asset = JSON.parse(readFileSync(
    new URL("../corpus.json", import.meta.url),
    "utf8",
  ));
  const [baseline] = BASELINES.entries;
  const grouped = readCorpus(asset, {
    protocolVersion: baseline.protocolVersion,
    scoringVersion: SCORING_VERSION,
  });

  assert.equal(grouped.entries.length, 1);
  assert.equal(grouped.entries[0].label.value, baseline.referenceDevice.model);
  assert.equal(grouped.entries[0].label.claimed, true);
  assert.equal(grouped.entries[0].score.value, 100);
  assert.deepEqual(
    grouped.entries[0].subScores.map(({ value }) => value),
    [100, 100, 100, 100],
  );
  assert.equal(grouped.entries[0].detected.reportedConcurrency.value,
    baseline.observedConcurrency.reported);
  assert.equal(grouped.entries[0].detected.measuredParallelism.value,
    baseline.observedConcurrency.measuredPeakPoolSize);
});

// A scoring change deliberately does not bump protocolVersion, because that key selects the
// baseline the scoring itself depends on. So protocolVersion alone cannot decide comparability,
// and these four guards are what stops two differently weighted scores sharing one table.

test("a scored record without a scoringVersion is not a valid corpus record", () => {
  const { scoringVersion: _omitted, ...withoutVersion } = scoredRecord(1);

  assert.equal(validateCorpusRecord(scoredRecord(1)), true);
  assert.equal(validateCorpusRecord(withoutVersion), false);
});

test("an invalid corpus record cannot carry a scoringVersion", () => {
  assert.equal(validateCorpusRecord({
    kind: "invalid",
    schemaVersion: 1,
    protocolVersion: 1,
    baselineVersion: 1,
    previewMode: "standard",
    capturedMonth: "2026-08",
    detected: detected(),
    reasons: ["tab-hidden"],
    scoringVersion: 1,
  }), false);
});

test("a record scored under other weights is absent from the table at the same protocol", () => {
  const current = scoredRecord(1, { detected: detected({ gpuRenderer: "Current" }) });
  const reweighted = scoredRecord(1, {
    scoringVersion: 2,
    score: { value: 999, unit: "BenchDev points" },
    detected: detected({ gpuRenderer: "Reweighted" }),
  });

  const grouped = readCorpus(corpus([reweighted, current]), {
    protocolVersion: 1,
    scoringVersion: 1,
  });
  const state = createComparisonTableState(grouped.entries);

  assert.equal(grouped.entries.length, 1);
  assert.equal(grouped.entries[0].detected.gpuRenderer, "Current");
  assert.equal(state.kind, "table");
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].detected.gpuRenderer, "Current");
  assert.equal(state.rows[0].scoringVersion, 1);
});

test("reading a corpus without stating a scoringVersion throws", () => {
  assert.throws(
    () => readCorpus(corpus([scoredRecord(1)]), { protocolVersion: 1 }),
    TypeError,
  );
});
