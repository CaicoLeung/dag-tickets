import { test, expect, describe } from "bun:test";
import { run } from "../src/shell.ts";

// ---------------------------------------------------------------------------
// run() watchdog behaviour (issue #43)
//
// The watchdog is tested through the public `run()` API (the private
// `runWithWatchdog` is internal). We spawn short-lived child processes and
// verify that:
//   1. The overall wall timeout still fires when the watchdog is active.
//   2. The watchdog fires when no stdout/stderr output appears.
//   3. The watchdog resets and does NOT fire when output arrives steadily.
//   4. A bare run() without watchdog works as before (no regression).
// ---------------------------------------------------------------------------

describe("run() — per-step watchdog (#43)", () => {
  test("watchdog kills a silent process and returns timedOut:true", async () => {
    // Spawn a process that sleeps 5 seconds with no output. The watchdog
    // fires at 200ms and kills it.
    const r = await run(
      ["sh", "-c", "sleep 5"],
      { watchdogTimeoutMs: 200 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.stdout.length).toBe(0);
  }, 10_000);

  test("watchdog resets when output arrives — process that prints periodically survives", async () => {
    // Print "tick" every 100ms for 10 iterations (1 second total).
    // Watchdog at 300ms should NOT fire because output arrives every 100ms.
    const r = await run(
      ["sh", "-c", "i=0; while [ $i -lt 10 ]; do echo tick; sleep 0.1; i=$((i+1)); done"],
      { watchdogTimeoutMs: 300 },
    );
    expect(r.timedOut).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.stdout.split(/\n/).filter(Boolean).length).toBe(10);
  }, 10_000);

  test("overall timeout still fires with watchdog active", async () => {
    // A process that prints every 100ms (resetting the watchdog) but runs for
    // 5 seconds. Overall timeout at 500ms should kill it.
    const r = await run(
      ["sh", "-c", "i=0; while [ $i -lt 50 ]; do echo tick; sleep 0.1; i=$((i+1)); done"],
      { timeoutMs: 500, watchdogTimeoutMs: 200 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.stdout.split(/\n/).filter(Boolean).length).toBeLessThan(50);
  }, 10_000);

  test("bare run() without watchdog works as before (no regression)", async () => {
    const r = await run(
      ["sh", "-c", "echo hello; echo world"],
    );
    expect(r.timedOut).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("world");
  }, 5_000);

  test("watchdog disabled when watchdogTimeoutMs is 0", async () => {
    // watchdogTimeoutMs=0 means the watchdog path is NOT taken; the process
    // runs normally.
    const r = await run(
      ["sh", "-c", "echo ok"],
      { watchdogTimeoutMs: 0 },
    );
    expect(r.timedOut).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("ok");
  }, 5_000);

  test("stderr output also resets the watchdog", async () => {
    // Process writes to stderr every 100ms. Watchdog at 200ms should NOT fire.
    const r = await run(
      ["sh", "-c", "i=0; while [ $i -lt 5 ]; do echo tick >&2; sleep 0.1; i=$((i+1)); done"],
      { watchdogTimeoutMs: 200 },
    );
    expect(r.timedOut).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.stderr.split(/\n/).filter(Boolean).length).toBe(5);
  }, 10_000);
});
