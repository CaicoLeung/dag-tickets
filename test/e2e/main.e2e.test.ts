/**
 * End-to-end tests for dag-tickets.
 *
 * Each test drives the REAL main() against a REAL local git repo with a local
 * bare origin, with `gh` and `paseo` replaced by executable shims on a temp
 * PATH. Nothing is module-mocked: the full parseArgs → main → ShellBranch /
 * ShellPullRequest / PaseoAgent → Bun.spawn chain runs, exactly as a real
 * `dag-tickets` invocation does. git stays real (fetch / push / rev-parse /
 * worktree all hit the local repo).
 *
 * See test/e2e/harness.ts for the environment contract.
 */
import { test, describe, expect } from "bun:test";
import {
  captureStderr,
  lockExists,
  readEvents,
  readShimState,
  readState,
  runMain,
  setup,
  teardown,
  ticketEventTypes,
  writeLiveLock,
  type Env,
  type IssueSpec,
} from "./harness.ts";
import { EVT } from "../../src/events.ts";
import { statePath, type RunState, type TicketState } from "../../src/state.ts";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

describe("e2e: arg-only exits (no dispatch)", () => {
  test("--version / --help / bare invoke exit 0 without touching gh", async () => {
    const env = await setup({ issues: [] });
    try {
      expect(await runMain(env, ["--version"])).toBe(0);
      expect(await runMain(env, ["--help"])).toBe(0);
      expect(await runMain(env, [])).toBe(0);
    } finally {
      await teardown(env);
    }
  });
});

describe("e2e: discovery + planning", () => {
  test("empty frontier → exit 0, no state, no lock", async () => {
    const env = await setup({ issues: [] });
    try {
      expect(await runMain(env, ["--frontier"])).toBe(0);
      expect(await readState(env)).toBeNull();
      expect(lockExists(env)).toBe(false);
    } finally {
      await teardown(env);
    }
  });

  test("dry-run plans two tickets but dispatches nothing", async () => {
    const env = await setup({
      issues: [issue(1, "Add alpha"), issue(2, "Add beta")],
    });
    try {
      expect(await runMain(env, ["--dry-run"])).toBe(0);

      // Dry-run is lock-free and skips saveState entirely.
      expect(await readState(env)).toBeNull();
      expect(lockExists(env)).toBe(false);

      // The event log is always on, even in dry-run.
      const events = await readEvents(env);
      expect(events).not.toBeNull();
      const types = events!.map((e) => e.type);
      expect(types).toContain(EVT.RUN_START);
      expect(types).toContain(EVT.RUN_END);

      // No PR was created and nothing merged.
      const shim = await readShimState(env);
      expect(shim.prCounter).toBe(1000);
      expect(shim.merged).toEqual([]);
    } finally {
      await teardown(env);
    }
  });
});

describe("e2e: implement lifecycle", () => {
  test("happy path: implement → review CLEAN → PR → merge → close", async () => {
    const env = await setup({
      issues: [issue(1, "Add foo")],
      verdicts: { "1": ["clean"] },
    });
    try {
      expect(await runMain(env, ["1"])).toBe(0);

      const state = await readState(env);
      expect(state).not.toBeNull();
      const t = ticketOf(state!, 1);
      expect(t.status).toBe("done");
      expect(t.pr).toBe(1001);
      expect(t.rounds).toBe(0);
      expect(t.reason).toBeUndefined();

      // Real git push happened (head reached gh), real gh merge recorded it.
      const shim = await readShimState(env);
      expect(shim.merged).toContain(1001);
      expect(Object.keys(shim.prHeads)).toContain("1001");
      expect(shim.prHeads["1001"]).toStartWith("loop/1-");

      // The full event chain for the ticket landed in order.
      const types = ticketEventTypes((await readEvents(env))!, 1);
      expect(types).toContain(EVT.STEP_START);
      expect(types).toContain(EVT.PR_CREATED);
      expect(types).toContain(EVT.CI_RESULT);
      expect(types).toContain(EVT.MERGE);
      expect(types).toContain(EVT.TICKET_END);
    } finally {
      await teardown(env);
    }
  });

  test("review ISSUES → fix → CLEAN → merge (rounds=1)", async () => {
    const env = await setup({
      issues: [issue(2, "Add bar")],
      verdicts: { "2": ["issues:2", "clean"] },
    });
    try {
      expect(await runMain(env, ["2", "--max-fix-rounds", "1"])).toBe(0);

      const t = ticketOf((await readState(env))!, 2);
      expect(t.status).toBe("done");
      expect(t.rounds).toBe(1);
      expect(t.pr).toBe(1001);
      expect((await readShimState(env)).merged).toContain(1001);
    } finally {
      await teardown(env);
    }
  });

  test("review never clean after max rounds → terminal fail + cascade", async () => {
    const env = await setup({
      issues: [issue(3, "Base work"), issue(4, "Dependent", [3])],
      verdicts: { "3": ["issues:3", "issues:3", "issues:3"] },
    });
    try {
      expect(await runMain(env, ["3", "4", "--max-fix-rounds", "2"])).toBe(1);

      const state = (await readState(env))!;
      expect(ticketOf(state, 3).status).toBe("failed");
      expect(ticketOf(state, 3).reason).toBe("review-issues");
      // The dependent was never started; it inherits the blocker's failure.
      expect(ticketOf(state, 4).status).toBe("failed");

      const cascades = (await readEvents(env))!.filter(
        (e) => e.type === EVT.TICKET_CASCADE && e.ticket === 4,
      );
      expect(cascades.length).toBe(1);
    } finally {
      await teardown(env);
    }
  });

  test("CI fails → ticket failed (ci-failed), PR left open", async () => {
    const env = await setup({
      issues: [issue(5, "Add gamma")],
      verdicts: { "5": ["clean"] },
      checks: "fail",
    });
    try {
      expect(await runMain(env, ["5", "--max-ticket-retries", "0"])).toBe(1);

      const t = ticketOf((await readState(env))!, 5);
      expect(t.status).toBe("failed");
      expect(t.reason).toBe("ci-failed");
      expect(t.pr).toBe(1001);
      // Never merged — left for a human.
      expect((await readShimState(env)).merged).toEqual([]);

      const ci = (await readEvents(env))!.find(
        (e) => e.type === EVT.CI_RESULT && e.ticket === 5,
      );
      expect(ci?.data?.state).toBe("fail");
    } finally {
      await teardown(env);
    }
  });

  test("--no-auto-merge: review clean + CI green, PR left unmerged", async () => {
    const env = await setup({
      issues: [issue(6, "Add delta")],
      verdicts: { "6": ["clean"] },
    });
    try {
      expect(await runMain(env, ["6", "--no-auto-merge"])).toBe(0);

      const t = ticketOf((await readState(env))!, 6);
      expect(t.status).toBe("done");
      expect(t.pr).toBe(1001);
      expect((await readShimState(env)).merged).toEqual([]);
    } finally {
      await teardown(env);
    }
  });

  test("triage single-shot completes with no PR", async () => {
    const env = await setup({
      issues: [{ number: 11, title: "Triage me", labels: ["needs-triage"] }],
    });
    try {
      expect(await runMain(env, ["--label", "needs-triage"])).toBe(0);

      const t = ticketOf((await readState(env))!, 11);
      expect(t.status).toBe("done");
      expect(t.pr).toBeUndefined();

      const shim = await readShimState(env);
      expect(shim.prCounter).toBe(1000); // no pr create
      expect(shim.merged).toEqual([]);
    } finally {
      await teardown(env);
    }
  });
});

describe("e2e: safety rails", () => {
  test("dependency cycle aborts before any dispatch (exit 2)", async () => {
    const env = await setup({
      issues: [issue(7, "A", [8]), issue(8, "B", [7])],
    });
    const cap = captureStderr();
    try {
      expect(await runMain(env, ["7", "8"])).toBe(2);
      expect(cap.text().toLowerCase()).toContain("cycle");
      // Aborted before state or lock.
      expect(await readState(env)).toBeNull();
    } finally {
      cap.restore();
      await teardown(env);
    }
  });

  test("a live run.lock → exit 75 (EX_TEMPFAIL)", async () => {
    const env = await setup({ issues: [issue(9, "Locked out")] });
    try {
      await writeLiveLock(env);
      expect(await runMain(env, ["9"])).toBe(75);
    } finally {
      await teardown(env);
    }
  });

  test("resume skips a ticket already persisted done", async () => {
    const env = await setup({
      issues: [issue(10, "Already done")],
      verdicts: { "10": ["clean"] },
    });
    try {
      // Seed a prior run's state: #10 already merged.
      await seedRunState(env, {
        runId: "e2e",
        target: "issues-10",
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        tickets: { 10: { status: "done", pr: 4242 } },
      });

      expect(await runMain(env, ["10", "--resume", "e2e"])).toBe(0);

      // The done ticket was NOT re-dispatched: no new PR, no merge.
      const shim = await readShimState(env);
      expect(shim.prCounter).toBe(1000);
      expect(shim.merged).toEqual([]);

      const start = (await readEvents(env))!.find((e) => e.type === EVT.RUN_START);
      expect(start?.data?.resume).toBe(true);
    } finally {
      await teardown(env);
    }
  });
});

// --- helpers ---------------------------------------------------------------

function issue(n: number, title: string, blockedBy: number[] = []): IssueSpec {
  return { number: n, title, blockedBy };
}

/** Fetch a ticket's persisted state, failing loudly if it's missing — every
 *  assertion below presumes the ticket ran. */
function ticketOf(state: RunState, n: number): TicketState {
  const t = state.tickets[n];
  if (!t) throw new Error(`expected ticket #${n} in state, found none`);
  return t;
}

/** Write a state.json directly under the repo's scratch dir (simulating a
 *  prior run for --resume). */
async function seedRunState(env: Env, state: object): Promise<void> {
  const full = join(env.repo, statePath("e2e"));
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, JSON.stringify(state, null, 2) + "\n", "utf8");
}
