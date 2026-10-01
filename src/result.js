export const RESULT_SCHEMA_VERSION = 1;
export const BENCHMARK_PROTOCOL_VERSION = 5;

export const PREVIEW_MODES = Object.freeze([
  "standard",
  "reduced-motion",
]);

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

function isMeasurement(value) {
  return isRecord(value)
    && Number.isFinite(value.value)
    && value.value >= 0
    && isNonEmptyString(value.unit);
}

function isNamedMeasurement(value) {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isMeasurement({ value: value.value, unit: value.unit });
}

function hasValidCommonFields(value, expectedSchemaVersion) {
  return value.schemaVersion === expectedSchemaVersion
    && isPositiveInteger(value.protocolVersion)
    && isPositiveInteger(value.baselineVersion)
    && PREVIEW_MODES.includes(value.previewMode);
}

function hasUniqueMeasurementIds(measurements) {
  return new Set(measurements.map(({ id }) => id)).size === measurements.length;
}

export function validateRunResult(value, expectedSchemaVersion = RESULT_SCHEMA_VERSION) {
  if (!isRecord(value) || !hasValidCommonFields(value, expectedSchemaVersion)) {
    return false;
  }

  if (value.kind === "invalid") {
    return !own(value, "score")
      && !own(value, "subScores")
      && !own(value, "measurements")
      && Array.isArray(value.reasons)
      && value.reasons.length > 0
      && value.reasons.every(isNonEmptyString);
  }

  if (value.kind === "scored") {
    return !own(value, "reasons")
      && isMeasurement(value.score)
      && Array.isArray(value.subScores)
      && value.subScores.length > 0
      && value.subScores.every(isNamedMeasurement)
      && hasUniqueMeasurementIds(value.subScores)
      && Array.isArray(value.measurements)
      && value.measurements.every(isNamedMeasurement)
      && hasUniqueMeasurementIds(value.measurements);
  }

  return false;
}

export function assertValidRunResult(value, expectedSchemaVersion = RESULT_SCHEMA_VERSION) {
  if (!validateRunResult(value, expectedSchemaVersion)) {
    throw new TypeError("RunResult does not match the supported result schema");
  }

  return value;
}

function freezeResult(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeResult);
  } else if (isRecord(value)) {
    Object.values(value).forEach(freezeResult);
  }

  return Object.freeze(value);
}

function copyMeasurement({ id, value, unit }) {
  return id === undefined ? { value, unit } : { id, value, unit };
}

export function createScoredRunResult({
  schemaVersion = RESULT_SCHEMA_VERSION,
  protocolVersion,
  baselineVersion,
  previewMode,
  score,
  subScores,
  measurements = [],
}) {
  const result = {
    kind: "scored",
    schemaVersion,
    protocolVersion,
    baselineVersion,
    previewMode,
    score: copyMeasurement(score ?? {}),
    subScores: Array.isArray(subScores) ? subScores.map(copyMeasurement) : subScores,
    measurements: Array.isArray(measurements) ? measurements.map(copyMeasurement) : measurements,
  };

  assertValidRunResult(result);
  return freezeResult(result);
}

export function createInvalidRunResult({
  schemaVersion = RESULT_SCHEMA_VERSION,
  protocolVersion,
  baselineVersion,
  previewMode,
  reasons,
}) {
  const result = {
    kind: "invalid",
    schemaVersion,
    protocolVersion,
    baselineVersion,
    previewMode,
    reasons: Array.isArray(reasons) ? [...reasons] : reasons,
  };

  assertValidRunResult(result);
  return freezeResult(result);
}
