import { test, expect, describe } from "bun:test";
import { isRateLimited } from "../src/paseo.ts";

describe("isRateLimited", () => {
  test("detects the real claude 429 quota string from the field", () => {
    const out =
      "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. " +
      "Your limit will reset at 2026-07-27 23:32:13][20260727232718912c36341c0842a6]";
    expect(isRateLimited(out)).toBe(true);
  });

  test("detects bare 429", () => {
    expect(isRateLimited("HTTP 429 Too Many Requests")).toBe(true);
  });

  test("detects 'rate limit' / 'rate-limit'", () => {
    expect(isRateLimited("rate limit exceeded")).toBe(true);
    expect(isRateLimited("rate-limit hit")).toBe(true);
  });

  test("detects quota language", () => {
    expect(isRateLimited("quota exceeded for the day")).toBe(true);
  });

  test("does not flag normal agent output", () => {
    expect(isRateLimited("REVIEW_VERDICT: CLEAN")).toBe(false);
    expect(isRateLimited("All 12 tests pass. Implementation complete.")).toBe(false);
    expect(isRateLimited("")).toBe(false);
  });

  test("does not false-positive on unrelated numbers", () => {
    expect(isRateLimited("Fixed 3 issues in 1429 lines")).toBe(false);
  });
});
