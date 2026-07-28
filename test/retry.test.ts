import { test, expect, describe } from "bun:test";
import {
  computeBackoff,
  isTransient,
  runWithRetry,
  TRANSIENT_REASONS,
} from "../src/retry.ts";
import type { FailureReason } from "../src/types.ts";
import { EVT, RecordingSink } from "../src/events.ts";
import { NULL_SINK } from "../src/ports.ts";
import { retryableOutcome as outcome } from "./helpers.ts";

describe("isTransient", () => {
  test("transient causes are retryable", () => {
    const transient: FailureReason[] = [
      "ci-failed",
      "rate-limited",
      "stale-base",
      "merge-race",
      "agent-timeout",
    ];
    for (const r of transient) expect(isTransient(r)).toBe(true);
  });

  test("terminal causes are NOT retryable", () => {
    const terminal: FailureReason[] = [
      "review-issues",
      "review-unknown",
      "implement-empty",
      "implement-failed",
      "fix-failed",
      "single-shot-failed",
    ];
    for (const r of terminal) expect(isTransient(r)).toBe(false);
  });

  test("a missing reason (e.g. a thrown error mapped to bare failed) is terminal", () => {
    // No reason ⇒ we can't prove it's transient, so we don't retry: a bare
    // `failed` cascades immediately rather than burning retry budget on an
    // unknown cause.
    expect(isTransient(undefined)).toBe(false);
  });

  test("TRANSIENT_REASONS exactly matches the transient set", () => {
    // Guards against a future FailureReason being added to the union without a
    // deliberate transient/terminal decision — the set is the retry policy's
    // source of truth, so it must be exhaustive over the transient labels.
    expect([...TRANSIENT_REASONS].sort()).toEqual(
      ["agent-timeout", "ci-failed", "merge-race", "rate-limited", "stale-base"],
    );
  });
});

describe("computeBackoff", () => {
  test("doubles per attempt (exponential) before the cap", () => {
    expect(computeBackoff(1, 100, 10_000)).toBe(100); // 100 * 2^0
    expect(computeBackoff(2, 100, 10_000)).toBe(200); // 100 * 2^1
    expect(computeBackoff(3, 100, 10_000)).toBe(400); // 100 * 2^2
    expect(computeBackoff(4, 100, 10_000)).toBe(800); // 100 * 2^3
  });

  test("is capped at maxDelayMs", () => {
    expect(computeBackoff(10, 100, 1000)).toBe(1000); // 100*2^9 >> 1000 → cap
  });

  test("base larger than cap returns the cap immediately", () => {
    expect(computeBackoff(1, 5000, 1000)).toBe(1000);
  });
});

describe("runWithRetry", () => {
  test("success on first attempt: attempts=1, no sleep, no retry event", async () => {
    const slept: number[] = [];
    const sink = new RecordingSink();
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        return outcome("done");
      },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep: async (ms) => { slept.push(ms); },
        events: sink,
        ticketNumber: 7,
      },
    );
    expect(out.status).toBe("done");
    expect(out.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(sink.events).toEqual([]);
  });

  test("transient fail then success: retried once, attempts=2, one sleep, one retry event", async () => {
    const slept: number[] = [];
    const sink = new RecordingSink();
    const scripted = [
      outcome("failed", "ci-failed"), // attempt 1: transient flake
      outcome("done"), // attempt 2: succeeds
    ];
    let i = 0;
    const out = await runWithRetry(
      async () => scripted[i++]!,
      {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep: async (ms) => { slept.push(ms); },
        random: () => 1, // deterministic: delay == computeBackoff
        events: sink,
        ticketNumber: 7,
      },
    );
    expect(out.status).toBe("done");
    expect(out.attempts).toBe(2);
    expect(slept).toEqual([100]); // backoff before attempt 2
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      type: EVT.TICKET_RETRY,
      ticket: 7,
      data: { attempt: 2, delayMs: 100, reason: "ci-failed" },
    });
  });

  test("backoff grows exponentially across retries", async () => {
    const slept: number[] = [];
    const scripted = [
      outcome("failed", "ci-failed"),
      outcome("failed", "ci-failed"),
      outcome("failed", "ci-failed"),
      outcome("done"),
    ];
    let i = 0;
    await runWithRetry(
      async () => scripted[i++]!,
      {
        maxRetries: 5,
        baseDelayMs: 50,
        maxDelayMs: 10_000,
        sleep: async (ms) => { slept.push(ms); },
        random: () => 1,
        events: NULL_SINK,
      },
    );
    // after attempt 1 → 50, after attempt 2 → 100, after attempt 3 → 200
    expect(slept).toEqual([50, 100, 200]);
  });

  test("transient exhausted: terminal failed, attempts = maxRetries+1", async () => {
    const slept: number[] = [];
    const sink = new RecordingSink();
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        return outcome("failed", "ci-failed");
      },
      {
        maxRetries: 2, // → up to 3 total attempts
        baseDelayMs: 10,
        maxDelayMs: 100,
        sleep: async (ms) => { slept.push(ms); },
        random: () => 1,
        events: sink,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("ci-failed");
    expect(out.attempts).toBe(3); // 1 initial + 2 retries
    expect(calls).toBe(3);
    expect(slept).toHaveLength(2); // slept before attempt 2 and before attempt 3
    // two retry events, attempts 2 and 3
    expect(sink.events.map((e) => e.data?.attempt)).toEqual([2, 3]);
  });

  test("terminal failure is NOT retried: attempts=1, no sleep", async () => {
    const slept: number[] = [];
    const sink = new RecordingSink();
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        return outcome("failed", "review-issues"); // terminal
      },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep: async (ms) => { slept.push(ms); },
        events: sink,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("review-issues");
    expect(out.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(sink.events).toEqual([]);
  });

  test("maxRetries=0 disables retry (one attempt only, even for transient)", async () => {
    const slept: number[] = [];
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        return outcome("failed", "ci-failed");
      },
      {
        maxRetries: 0,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep: async (ms) => { slept.push(ms); },
        events: NULL_SINK,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("skipped outcome is not retried", async () => {
    const slept: number[] = [];
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        return outcome("skipped");
      },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep: async (ms) => { slept.push(ms); },
        events: NULL_SINK,
      },
    );
    expect(out.status).toBe("skipped");
    expect(out.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("onAttempt fires after each attempt with the running count", async () => {
    const seen: Array<{ attempt: number; status: string }> = [];
    const scripted = [
      outcome("failed", "ci-failed"),
      outcome("failed", "ci-failed"),
      outcome("done"),
    ];
    let i = 0;
    await runWithRetry(
      async () => scripted[i++]!,
      {
        maxRetries: 5,
        baseDelayMs: 1,
        maxDelayMs: 10,
        sleep: async () => {},
        events: NULL_SINK,
        onAttempt: (attempt, o) => { seen.push({ attempt, status: o.status }); },
      },
    );
    expect(seen).toEqual([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "failed" },
      { attempt: 3, status: "done" },
    ]);
  });

  test("full jitter keeps the delay within [0, computeBackoff]", async () => {
    // random() in [0,1) ⇒ the actual sleep is strictly less than the cap for
    // that attempt (the AWS "full jitter" strategy — spreads correlated
    // retries so a fleet of transient failures doesn't stampede the provider).
    const slept: number[] = [];
    await runWithRetry(
      async () => outcome("failed", "ci-failed"),
      {
        maxRetries: 1,
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        sleep: async (ms) => { slept.push(ms); },
        random: () => 0.5, // half of the cap
        events: NULL_SINK,
      },
    );
    expect(slept).toEqual([250]); // 0.5 * computeBackoff(1,500,10000)=0.5*500
  });
});

describe("runWithRetry — startAttempt (resume continuity, issue #21)", () => {
  test("startAttempt continues numbering cumulatively and the global cap still binds", async () => {
    // A ticket killed mid-backoff after 2 attempts (maxRetries=2) resumes with
    // startAttempt=3. The resumed loop runs attempt 3 only: a transient failure
    // there hits `attempt > maxRetries` (3 > 2) and stops — so the ticket gets
    // exactly 3 total attempts across both runs, NOT a fresh budget of 3 more.
    const calls: number[] = [];
    const out = await runWithRetry(
      async (attempt) => { calls.push(attempt); return outcome("failed", "ci-failed"); },
      {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 10,
        sleep: async () => {},
        events: NULL_SINK,
        startAttempt: 3,
      },
    );
    expect(calls).toEqual([3]); // only the resumed attempt, numbered cumulatively
    expect(out.attempts).toBe(3); // cumulative count — not reset to 1
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("ci-failed");
  });

  test("startAttempt with budget remaining backs off and retries cumulatively", async () => {
    // Resumed at attempt 2 (maxRetries=3, budget remains): attempt 2 fails
    // transiently, backs off, attempt 3 succeeds. Numbering stays cumulative —
    // the backoff is computed from the cumulative attempt (2 → base*2^1).
    const calls: number[] = [];
    const slept: number[] = [];
    const scripted = [outcome("failed", "ci-failed"), outcome("done")];
    let i = 0;
    const out = await runWithRetry(
      async (attempt) => {
        calls.push(attempt);
        return scripted[i++]!;
      },
      {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep: async (ms) => { slept.push(ms); },
        random: () => 1, // delay == computeBackoff
        events: NULL_SINK,
        startAttempt: 2,
      },
    );
    expect(calls).toEqual([2, 3]); // resumed at 2, succeeded at 3
    expect(slept).toEqual([200]); // computeBackoff(2,100,1000)=100*2^1=200
    expect(out.status).toBe("done");
    expect(out.attempts).toBe(3);
  });

  test("omitting startAttempt behaves exactly as before (starts at attempt 1)", async () => {
    // Regression guard: the default keeps the pre-resume-continuity numbering.
    const calls: number[] = [];
    const out = await runWithRetry(
      async (attempt) => { calls.push(attempt); return outcome("done"); },
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, sleep: async () => {}, events: NULL_SINK },
    );
    expect(calls).toEqual([1]);
    expect(out.attempts).toBe(1);
  });
});
