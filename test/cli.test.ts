import { test, expect } from "bun:test";
import { parseArgs, stopInFlightAgents, RunExit } from "../src/cli.ts";
import type { Logger } from "../src/ports.ts";

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

// --category-label / --skip-label (ADR-0001): add to the orphan-detection /
// intentional-skip sets. Same shape as --fallback-provider (comma-split, trim,
// repeatable) but defaults to empty here — the defaults live in
// DEFAULT_ROUTING and are merged at buildRouting() time.

test("--category-label accepts a single role", () => {
  expect(parseArgs(["--category-label", "bug"]).categoryLabels).toEqual(["bug"]);
});

test("--category-label splits a comma-separated list and trims whitespace", () => {
  expect(parseArgs(["--category-label", "bug, enhancement , type-bug"]).categoryLabels).toEqual([
    "bug",
    "enhancement",
    "type-bug",
  ]);
});

test("--category-label is repeatable and accumulates across flags", () => {
  expect(
    parseArgs(["--category-label", "bug", "--category-label", "enhancement,flaw"]).categoryLabels,
  ).toEqual(["bug", "enhancement", "flaw"]);
});

test("--category-label filters empty segments (trailing/leading/double commas)", () => {
  expect(parseArgs(["--category-label", ",bug,,enhancement,"]).categoryLabels).toEqual([
    "bug",
    "enhancement",
  ]);
});

test("--skip-label mirrors --category-label: single, comma-split, repeatable", () => {
  expect(parseArgs(["--skip-label", "needs-info"]).skipLabels).toEqual(["needs-info"]);
  expect(parseArgs(["--skip-label", "needs-info, wontfix"]).skipLabels).toEqual([
    "needs-info",
    "wontfix",
  ]);
  expect(
    parseArgs(["--skip-label", "needs-info", "--skip-label", "wontfix,blocked"]).skipLabels,
  ).toEqual(["needs-info", "wontfix", "blocked"]);
});

test("--category-label=value and --skip-label=value forms are accepted (= splicing)", () => {
  expect(parseArgs(["--category-label=bug,enhancement"]).categoryLabels).toEqual([
    "bug",
    "enhancement",
  ]);
  expect(parseArgs(["--skip-label=wontfix"]).skipLabels).toEqual(["wontfix"]);
});

test("categoryLabels / skipLabels default to empty", () => {
  expect(parseArgs([]).categoryLabels).toEqual([]);
  expect(parseArgs([]).skipLabels).toEqual([]);
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

// ---------------------------------------------------------------------------
// #40 — stopInFlightAgents: exit-cleanup helper. Pins the guard + swallow
// contract so a regression that removes the guard (or the try/catch) fails CI
// instead of silently swallowing a TypeError on a fake AgentPort that doesn't
// implement the optional stopInFlight.
// ---------------------------------------------------------------------------

test("stopInFlightAgents is a no-op when no agent is wired (dry-run / pre-dispatch)", async () => {
  // A missing agent must be a clean no-op, not a swallowed TypeError — the
  // honest reading of AgentPort.stopInFlight's optional contract.
  await expect(stopInFlightAgents(undefined, [11])).resolves.toBeUndefined();
});

test("stopInFlightAgents honours stopInFlight's optional contract — absent method is a no-op", async () => {
  // A fake AgentPort that doesn't implement stopInFlight must not crash (the
  // pre-#40 behaviour the optional contract promises). Without the guard this
  // would be a silently-swallowed TypeError.
  const agent: { stopInFlight?(n: Iterable<number>): Promise<void> } = {};
  await expect(stopInFlightAgents(agent, [11])).resolves.toBeUndefined();
});

test("stopInFlightAgents calls stopInFlight with the live ticket set when present", async () => {
  const stopped: number[][] = [];
  const agent = {
    stopInFlight: async (n: Iterable<number>) => {
      stopped.push([...n]);
    },
  };
  await stopInFlightAgents(agent, new Set([11, 12]));
  expect(stopped).toEqual([[11, 12]]);
});

test("stopInFlightAgents swallows a throwing stopInFlight — never throws", async () => {
  // A per-run stop failure must not block the exit/cleanup that follows.
  const agent = {
    stopInFlight: async () => {
      throw new Error("paseo stop exploded");
    },
  };
  await expect(stopInFlightAgents(agent, [11])).resolves.toBeUndefined();
});

// Note: empty-set handling lives in PaseoAgent.stopInFlight (covered in
// paseo.test.ts), not here — the helper's job is guard + swallow, and it
// correctly delegates stopInFlight([]) whenever the method exists.

// ---------------------------------------------------------------------------
// #40 — RunExit: the exit-path coordinator. Pins "every catchable exit calls
// cleanup (stop → flush → release) and exits with the right code" so a
// regression that drops a handler registration, a cleanup step, or the detach
// fails here instead of orphaning agents in an unattended run. process.exit is
// injected as a recorder so the test process isn't terminated.
// ---------------------------------------------------------------------------

const SILENT_LOG: Logger = () => {};

/** Fakes that record cleanup-step order + the exit code, without touching the
 *  real process. `releaseThrowing` flips release to throw (resilience test). */
function fakeDeps(releaseThrowing = false) {
  const calls: string[] = [];
  const exits: number[] = [];
  return {
    calls,
    exits,
    deps: {
      stop: async () => {
        calls.push("stop");
      },
      flush: async () => {
        calls.push("flush");
      },
      release: async () => {
        calls.push("release");
        if (releaseThrowing) throw new Error("release boom");
      },
      log: SILENT_LOG,
      exit: (code: number) => {
        exits.push(code);
      },
    },
  };
}

/** Drain the async cleanExit chain (stop/flush/release are microtasks; exit fires
 *  in .finally). One macrotask is enough: every step before exit() is a
 *  microtask, and microtasks drain before setTimeout fires. */
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

test("RunExit SIGINT runs stop→flush→release in order then exits 130", async () => {
  const { calls, exits, deps } = fakeDeps();
  new RunExit(deps).onSignal("SIGINT");
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]); // order is load-bearing
  expect(exits).toEqual([130]); // 128 + 2
});

test("RunExit SIGTERM exits 143", async () => {
  const { exits, deps } = fakeDeps();
  new RunExit(deps).onSignal("SIGTERM");
  await settled();
  expect(exits).toEqual([143]); // 128 + 15
});

test("RunExit uncaughtException runs full cleanup then exits 1", async () => {
  const { calls, exits, deps } = fakeDeps();
  new RunExit(deps).onUncaught();
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]);
  expect(exits).toEqual([1]);
});

test("RunExit unhandledRejection exits 1 with full cleanup", async () => {
  const { calls, exits, deps } = fakeDeps();
  new RunExit(deps).onRejection();
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]);
  expect(exits).toEqual([1]);
});

test("RunExit still exits when release throws — cleanup must not block exit", async () => {
  // A failing lock release must not swallow the exit. The outer .catch eats the
  // rejection; .finally still fires exit().
  const { calls, exits, deps } = fakeDeps(true);
  new RunExit(deps).onUncaught();
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]); // release was attempted
  expect(exits).toEqual([1]); // exit still happened
});

test("RunExit.register adds all 4 listeners and detach removes them", () => {
  const g = new RunExit(fakeDeps().deps);
  const evs = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;
  const before = evs.map((e) => process.listenerCount(e));
  try {
    g.register();
    const added = evs.map((e, i) => process.listenerCount(e) - before[i]!);
    expect(added).toEqual([1, 1, 1, 1]); // exactly one handler per exit path
  } finally {
    g.detach();
  }
  const after = evs.map((e, i) => process.listenerCount(e) - before[i]!);
  expect(after).toEqual([0, 0, 0, 0]); // detach restored baseline
});
