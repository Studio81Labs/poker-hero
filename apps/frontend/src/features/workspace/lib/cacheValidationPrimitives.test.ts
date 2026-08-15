import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERSISTED_JOB_ID_PATTERN,
  PROCESSING_CACHE_FUTURE_SKEW_MS,
  isNullableCachedNumber,
  isSafeProcessingCacheTimestamp,
} from "./cacheValidationPrimitives";

describe("cache validation primitives", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts only lowercase 32-character persisted job ids", () => {
    expect(PERSISTED_JOB_ID_PATTERN.test("a".repeat(32))).toBe(true);
    expect(PERSISTED_JOB_ID_PATTERN.test("A".repeat(32))).toBe(false);
    expect(PERSISTED_JOB_ID_PATTERN.test("a".repeat(31))).toBe(false);
  });

  it("applies inclusive and exclusive nullable numeric bounds", () => {
    expect(isNullableCachedNumber(null, 0)).toBe(true);
    expect(isNullableCachedNumber(0, 0)).toBe(true);
    expect(isNullableCachedNumber(0, 0, false)).toBe(false);
    expect(isNullableCachedNumber(Number.NaN, 0)).toBe(false);
  });

  it("allows timestamps only through the configured future-skew boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const boundary = new Date(
      Date.now() + PROCESSING_CACHE_FUTURE_SKEW_MS,
    ).toISOString();
    const beyondBoundary = new Date(
      Date.now() + PROCESSING_CACHE_FUTURE_SKEW_MS + 1,
    ).toISOString();

    expect(isSafeProcessingCacheTimestamp(boundary)).toBe(true);
    expect(isSafeProcessingCacheTimestamp(beyondBoundary)).toBe(false);
    expect(isSafeProcessingCacheTimestamp("not-a-date")).toBe(false);
  });
});
