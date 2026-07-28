import { test, expect } from "bun:test";
import { parseArgs } from "../src/cli.ts";

test("--version / -V set the version flag", () => {
  expect(parseArgs(["--version"]).version).toBe(true);
  expect(parseArgs(["-V"]).version).toBe(true);
});

test("version flag defaults to false", () => {
  expect(parseArgs([]).version).toBe(false);
  expect(parseArgs(["--frontier"]).version).toBe(false);
});

test("unknown argument still throws regardless of version flag", () => {
  expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
});

test("--fallback-provider accepts a single provider", () => {
  expect(parseArgs(["--fallback-provider", "claude/sonnet"]).fallbackProviders).toEqual([
    "claude/sonnet",
  ]);
});

test("--fallback-provider splits comma-separated list", () => {
  expect(
    parseArgs(["--fallback-provider", "claude/sonnet, omp/zai/glm-5.2"]).fallbackProviders,
  ).toEqual(["claude/sonnet", "omp/zai/glm-5.2"]);
});

test("--fallback-provider is repeatable and accumulates", () => {
  expect(
    parseArgs([
      "--fallback-provider",
      "claude/sonnet",
      "--fallback-provider",
      "omp/zai/glm-5.2",
    ]).fallbackProviders,
  ).toEqual(["claude/sonnet", "omp/zai/glm-5.2"]);
});

test("fallbackProviders defaults to empty", () => {
  expect(parseArgs([]).fallbackProviders).toEqual([]);
});

// --max-ticket-retries (issue #21): transient whole-ticket retry budget.
test("--max-ticket-retries sets the transient retry budget", () => {
  expect(parseArgs(["--max-ticket-retries", "5"]).maxTicketRetries).toBe(5);
});

test("--max-ticket-retries 0 disables retry", () => {
  expect(parseArgs(["--max-ticket-retries", "0"]).maxTicketRetries).toBe(0);
});

test("--max-ticket-retries ignores non-positive / non-numeric and keeps the default", () => {
  // num() rejects <=0 and NaN, so the default (2) is retained — no crash.
  expect(parseArgs(["--max-ticket-retries", "abc"]).maxTicketRetries).toBe(2);
  expect(parseArgs(["--max-ticket-retries", "-1"]).maxTicketRetries).toBe(2);
});

test("--max-ticket-retries defaults to 2", () => {
  expect(parseArgs([]).maxTicketRetries).toBe(2);
});

test("--max-ticket-retries=value form is accepted (= splicing)", () => {
  expect(parseArgs(["--max-ticket-retries=4"]).maxTicketRetries).toBe(4);
});

// --ci-watch-timeout-minutes: ceiling on `gh pr checks --watch` so a stuck
// check can't starve a concurrency slot. Becomes a transient ci-failed on
// timeout (retried with backoff). 0 disables the bound.
test("--ci-watch-timeout-minutes defaults to 30", () => {
  expect(parseArgs([]).ciWatchTimeoutMinutes).toBe(30);
});

test("--ci-watch-timeout-minutes sets the ceiling", () => {
  expect(parseArgs(["--ci-watch-timeout-minutes", "60"]).ciWatchTimeoutMinutes).toBe(60);
});

test("--ci-watch-timeout-minutes 0 disables the bound (no ceiling)", () => {
  // 0 is valid (indefinite watch) — distinct from --concurrency's num() which
  // rejects non-positive values.
  expect(parseArgs(["--ci-watch-timeout-minutes", "0"]).ciWatchTimeoutMinutes).toBe(0);
});

test("--ci-watch-timeout-minutes ignores non-numeric / negative, keeps default", () => {
  expect(parseArgs(["--ci-watch-timeout-minutes", "abc"]).ciWatchTimeoutMinutes).toBe(30);
  expect(parseArgs(["--ci-watch-timeout-minutes", "-5"]).ciWatchTimeoutMinutes).toBe(30);
});

test("--ci-watch-timeout-minutes=value form is accepted (= splicing)", () => {
  expect(parseArgs(["--ci-watch-timeout-minutes=45"]).ciWatchTimeoutMinutes).toBe(45);
});
