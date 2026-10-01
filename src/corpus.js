export const CORPUS_SCHEMA_VERSION = 1;
export const CORPUS_VERSION = 1;
export const EMPTY_COMPARISON_MESSAGE = "No comparison devices yet.";

const PREVIEW_MODES = Object.freeze(["standard", "reduced-motion"]);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableNonEmptyString(value) {
  return value === null || isNonEmptyString(value);
}

function isMonth(value) {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/u.test(value);
}

function isMeasurement(value, { nullable = false } = {}) {
  return isRecord(value)
    && ((nullable && value.value === null)
      || (Number.isFinite(value.value) && value.value >= 0))
    && isNonEmptyString(value.unit);
}

function isNamedMeasurement(value) {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isMeasurement({ value: value.value, unit: value.unit });
}

function hasUniqueIds(values) {
  return new Set(values.map(({ id }) => id)).size === values.length;
}

function isDetected(value) {
  return isRecord(value)
    && isRecord(value.browser)
    && isNonEmptyString(value.browser.name)
    && isPositiveInteger(value.browser.majorVersion)
    && isNonEmptyString(value.osFamily)
    && isMeasurement(value.reportedConcurrency, { nullable: true })
    && isMeasurement(value.measuredParallelism, { nullable: true })
    && isNullableNonEmptyString(value.gpuRenderer)
    && isMeasurement(value.devicePixelRatio);
}

function isClaimedLabel(value) {
  return isRecord(value)
    && isNonEmptyString(value.value)
    && value.claimed === true;
}

export function validateCorpusRecord(record, expectedSchemaVersion = CORPUS_SCHEMA_VERSION) {
  if (!isRecord(record)
    || record.schemaVersion !== expectedSchemaVersion
    || !isPositiveInteger(record.protocolVersion)
    || !isPositiveInteger(record.baselineVersion)
    || !PREVIEW_MODES.includes(record.previewMode)
    || !isMonth(record.capturedMonth)
    || !isDetected(record.detected)
    || (own(record, "label") && !isClaimedLabel(record.label))) {
    return false;
  }

  if (record.kind === "invalid") {
    return !own(record, "score")
      && !own(record, "subScores")
      && !own(record, "scoringVersion")
      && Array.isArray(record.reasons)
      && record.reasons.length > 0
      && record.reasons.every(isNonEmptyString);
  }

  if (record.kind === "scored") {
    return !own(record, "reasons")
      && isPositiveInteger(record.scoringVersion)
      && isMeasurement(record.score)
      && Array.isArray(record.subScores)
      && record.subScores.length > 0
      && record.subScores.every(isNamedMeasurement)
      && hasUniqueIds(record.subScores);
  }

  return false;
}

function assertCorpusEnvelope(corpus, expectedSchemaVersion) {
  if (!isRecord(corpus)
    || corpus.schemaVersion !== expectedSchemaVersion
    || !isPositiveInteger(corpus.corpusVersion)
    || !isMonth(corpus.buildMonth)
    || !Array.isArray(corpus.entries)) {
    throw new TypeError("Corpus does not match the supported corpus schema");
  }
}

function cloneRecord(record) {
  return structuredClone(record);
}

export function groupCorpusEntries(entries, {
  protocolVersion,
  scoringVersion,
  schemaVersion = CORPUS_SCHEMA_VERSION,
}) {
  if (!Array.isArray(entries)
    || !isPositiveInteger(protocolVersion)
    || !isPositiveInteger(scoringVersion)) {
    throw new TypeError(
      "A corpus entry array, a positive protocolVersion and a positive scoringVersion are required",
    );
  }

  const grouped = [];

  for (const record of entries) {
    if (!isRecord(record) || record.schemaVersion !== schemaVersion) {
      throw new TypeError("Corpus record has an unsupported schemaVersion");
    }

    if (record.protocolVersion !== protocolVersion) {
      continue;
    }

    if (!validateCorpusRecord(record, schemaVersion)) {
      throw new TypeError("Corpus record does not match the supported corpus schema");
    }

    // A score is only comparable with another computed by the same weights and aggregation
    // rule, and a scoring change deliberately does NOT bump protocolVersion, because that key
    // selects the baseline the scoring itself depends on. Partitioning on protocolVersion alone
    // would put two differently weighted scores in one table with nothing to show for it.
    if (record.kind === "scored" && record.scoringVersion !== scoringVersion) {
      continue;
    }

    grouped.push(cloneRecord(record));
  }

  return grouped;
}

export function readCorpus(corpus, {
  protocolVersion,
  scoringVersion,
  schemaVersion = CORPUS_SCHEMA_VERSION,
} = {}) {
  assertCorpusEnvelope(corpus, schemaVersion);

  return {
    schemaVersion,
    corpusVersion: corpus.corpusVersion,
    buildMonth: corpus.buildMonth,
    protocolVersion,
    scoringVersion,
    entries: groupCorpusEntries(corpus.entries, {
      protocolVersion,
      scoringVersion,
      schemaVersion,
    }),
  };
}

function freezeTree(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }

  return value;
}

export function createComparisonTableState(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("Corpus entries are required for comparison");
  }

  const rows = entries
    .filter(({ kind }) => kind === "scored")
    .map((entry, sourceIndex) => ({
      sourceIndex,
      label: entry.label === undefined
        ? { kind: "unlabelled" }
        : { kind: "claimed", value: entry.label.value },
      detected: cloneRecord(entry.detected),
      score: cloneRecord(entry.score),
      subScores: cloneRecord(entry.subScores),
      capturedMonth: entry.capturedMonth,
      baselineVersion: entry.baselineVersion,
      protocolVersion: entry.protocolVersion,
      scoringVersion: entry.scoringVersion,
    }))
    .sort((left, right) => (
      right.score.value - left.score.value || left.sourceIndex - right.sourceIndex
    ))
    .map(({ sourceIndex: _sourceIndex, ...row }) => row);

  if (rows.length === 0) {
    return Object.freeze({
      kind: "empty",
      message: EMPTY_COMPARISON_MESSAGE,
    });
  }

  return freezeTree({ kind: "table", rows });
}
