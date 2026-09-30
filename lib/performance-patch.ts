export const PERFORMANCE_CATEGORY_COUNT = 6;

export type PerformanceCategoryPatch = {
  index: number;
  value: number;
};

export type ParsedPerformancePayload = {
  patches: PerformanceCategoryPatch[];
  recoveredLegacyPayload: boolean;
};

const isValidScore = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 5 &&
  Number.isInteger(value * 2);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/**
 * Parse a current single-category update or an older full/sparse vector queued
 * by builds that received masked Performance values. Sparse holes and JSON
 * nulls mean "unknown / do not change", never zero.
 */
export function parsePerformancePayload(payload: unknown): ParsedPerformancePayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Performance update must contain a category index and score.");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.index !== "undefined" || typeof record.value !== "undefined") {
    if (!hasOnlyKeys(record, ["index", "value"]) ||
      !Number.isInteger(record.index) ||
      (record.index as number) < 0 ||
      (record.index as number) >= PERFORMANCE_CATEGORY_COUNT ||
      !isValidScore(record.value)) {
      throw new Error("Performance update requires a category index from 0–5 and a score from 0–5 in 0.5 increments.");
    }
    return {
      patches: [{ index: record.index as number, value: record.value }],
      recoveredLegacyPayload: false,
    };
  }

  if (Object.hasOwn(record, "values")) {
    const values = record.values;
    if (!hasOnlyKeys(record, ["values"]) || !Array.isArray(values) ||
      values.length < 1 || values.length > PERFORMANCE_CATEGORY_COUNT) {
      throw new Error("Legacy Performance update must contain 1–6 recoverable category values.");
    }
    const patches: PerformanceCategoryPatch[] = [];
    values.forEach((value, index) => {
      if (value === null || typeof value === "undefined") return;
      if (!isValidScore(value)) {
        throw new Error("Legacy Performance update contains an invalid score; the saved queue was kept unchanged.");
      }
      patches.push({ index, value });
    });
    if (!patches.length) {
      throw new Error("Legacy Performance update contains no recoverable category values; the saved queue was kept unchanged.");
    }
    return { patches, recoveredLegacyPayload: true };
  }

  throw new Error("Performance update must contain a category index and score.");
}
