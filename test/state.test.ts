import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, statePath, type RunState } from "../src/state.ts";

/** Fresh temp cwd per test so no run leaks across tests or into the checkout. */
async function tmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dt-state-"));
}

function baseState(cwd: string): RunState {
  return {
    runId: "r1",
    target: "frontier",
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    tickets: {},
  };
}

describe("state — attempts/reason round-trip (issue #21)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await tmpCwd();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("a retried-then-failed ticket persists attempts + reason", async () => {
    const state = baseState(cwd);
    state.tickets[1] = {
      status: "failed",
      branch: "dag-1",
      rounds: 2,
      attempts: 3, // 1 initial + 2 retries (max-ticket-retries=2)
      reason: "ci-failed",
      error: "ci-failed",
    };
    await saveState(state, cwd);

    const loaded = (await loadState("r1", cwd))!;
    expect(loaded.tickets[1]?.status).toBe("failed");
    expect(loaded.tickets[1]?.attempts).toBe(3);
    expect(loaded.tickets[1]?.reason).toBe("ci-failed");
  });

  test("a clean first-run ticket persists attempts=1 and no reason", async () => {
    const state = baseState(cwd);
    state.tickets[2] = { status: "done", branch: "dag-2", pr: 1002, attempts: 1 };
    await saveState(state, cwd);
    const loaded = (await loadState("r1", cwd))!;
    expect(loaded.tickets[2]?.attempts).toBe(1);
    expect(loaded.tickets[2]?.reason).toBeUndefined();
  });

  test("issues-vs-unknown reason distinction survives the round-trip", async () => {
    // The two failure shapes that used to share one `review not clean` message
    // now keep distinct reasons in the persisted state.
    const state = baseState(cwd);
    state.tickets[3] = { status: "failed", reason: "review-issues", attempts: 1 };
    state.tickets[4] = { status: "failed", reason: "review-unknown", attempts: 1 };
    await saveState(state, cwd);
    const loaded = (await loadState("r1", cwd))!;
    expect(loaded.tickets[3]?.reason).toBe("review-issues");
    expect(loaded.tickets[4]?.reason).toBe("review-unknown");
    expect(loaded.tickets[3]?.reason).not.toBe(loaded.tickets[4]?.reason);
  });

  test("statePath keeps the run-scoped layout", async () => {
    expect(statePath("r1")).toBe(".scratch/dag-tickets/r1/state.json");
  });

  test("a pre-#21 state file (no attempts/reason) still loads", async () => {
    // Backward compat: state written before issue #21 omits attempts/reason;
    // loadState must not reject it. The fields simply stay undefined.
    const state = baseState(cwd);
    state.tickets[5] = { status: "failed", error: "ci-failed" }; // no reason/attempts
    await saveState(state, cwd);
    const loaded = (await loadState("r1", cwd))!;
    expect(loaded.tickets[5]?.status).toBe("failed");
    expect(loaded.tickets[5]?.attempts).toBeUndefined();
    expect(loaded.tickets[5]?.reason).toBeUndefined();
  });

  test("a ticket killed mid-backoff is `running`, not `failed`, so resume re-launches it (issue #21)", async () => {
    // The cli persists an in-flight transient failure as `running` with the
    // attempt count, NOT `failed`. On resume the scheduler seeds only
    // done/failed/skipped, so a `running` ticket is re-launched (getting a
    // fresh retry budget) instead of being wrongly cascaded as terminal.
    const state = baseState(cwd);
    state.tickets[6] = { status: "running", attempts: 1, reason: "ci-failed" };
    await saveState(state, cwd);
    const loaded = (await loadState("r1", cwd))!;
    expect(loaded.tickets[6]?.status).toBe("running");
    // The resume contract: a mid-backoff ticket is NOT in the failed seed.
    const { ticketsWithStatus } = await import("../src/state.ts");
    expect(ticketsWithStatus(loaded, "failed")).toEqual([]);
    expect(ticketsWithStatus(loaded, "done")).toEqual([]);
  });
});
