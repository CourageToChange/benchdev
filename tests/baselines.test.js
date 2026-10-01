import assert from "node:assert/strict";
import test from "node:test";

import { BASELINES, BASELINE_VERSION } from "../src/baselines.js";

// ⚠️ THIS USED TO ASSERT THAT EVERY BASELINE WAS AN UNMEASURED PLACEHOLDER, which was the
// right guard while nothing had been measured and became a description of a previous state the
// moment a real device was. It was NOT deleted to get the suite green: it now guards the rule that
// actually matters and that survives more numbers being filled in.
//
// 🔴 THE RULE: a measurement is EITHER a real number carrying full provenance, OR an explicit
// null marked "TODO: measure". What must never exist is a number without provenance, because that
// is indistinguishable from an invented one, and every score derived from a baseline inherits
// whatever honesty the baseline had.
test("every baseline is either measured with full provenance or explicitly unmeasured", () => {
  assert.equal(BASELINES.baselineVersion, BASELINE_VERSION);
  assert.ok(BASELINES.entries.length >= 1);

  const REQUIRED_PROVENANCE = [
    "aggregationMethod",
    "browserName",
    "browserVersion",
    "deviceModel",
    "measuredMonth",
    "note",
    "osName",
    "osVersion",
    "runCount",
    "source",
  ];

  for (const entry of BASELINES.entries) {
    assert.equal(entry.protocolVersion, 5);

    for (const [name, measurement] of Object.entries(entry.measurements)) {
      assert.deepEqual(
        Object.keys(measurement.provenance).sort(),
        REQUIRED_PROVENANCE,
        `${name} must carry the full provenance shape whether or not it is measured`,
      );

      if (measurement.value === null) {
        assert.equal(
          measurement.provenance.note,
          "TODO: measure",
          `${name} is unmeasured and must say so`,
        );
        continue;
      }

      assert.equal(typeof measurement.value, "number", `${name} must be a number`);
      assert.ok(Number.isFinite(measurement.value) && measurement.value > 0,
        `${name} must be finite and positive`);

      // A measured number without these is a number nobody can reproduce or date.
      for (const key of ["deviceModel", "osName", "browserName", "browserVersion",
        "measuredMonth", "runCount", "aggregationMethod", "source"]) {
        assert.ok(
          measurement.provenance[key] !== null && measurement.provenance[key] !== undefined,
          `${name} is measured, so provenance.${key} may not be null`,
        );
      }
      assert.ok(measurement.provenance.runCount >= 3,
        `${name} must be measured at least three times`);
    }
  }
});

test("baseline data is recursively frozen", () => {
  const [entry] = BASELINES.entries;
  assert.equal(Object.isFrozen(BASELINES), true);
  assert.equal(Object.isFrozen(BASELINES.entries), true);
  assert.equal(Object.isFrozen(entry.measurements.cpuJsSingleThreadThroughput.provenance), true);
});
