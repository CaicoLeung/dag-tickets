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
  prForTicket,
  revParseOrigin,
  writeDeadLock,
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
      // The head branch really landed on the bare origin (proves the real
      // `git push -u --force origin loop/1-…:loop/1-…` ran, not just that gh
      // pr create received the --head arg).
      expect(revParseOrigin(env, "loop/1-add-foo")).not.toBeNull();
      // The merged issue was really closed (gh issue close ran post-merge).
      expect(shim.closed).toContain(1);

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

  test("merge --delete-branch exits 1 but PR merged on GitHub → done, no duplicate PR (#38)", async () => {
    // The #38 race: dag-tickets leaves its review worktree on the ticket
    // branch, so `gh pr merge --squash --delete-branch` exits 1 ("cannot delete
    // branch used by worktree") even though the squash merge landed on GitHub.
    // Pre-fix this was misclassified as merge-race → the ticket re-implemented
    // → duplicate PR. Post-fix mergePr reconciles via `gh pr view --json state`
    // → MERGED → the ticket settles done with a SINGLE PR.
    const env = await setup({
      issues: [issue(38, "Merge race me")],
      verdicts: { "38": ["clean"] },
      mergeDeleteBranchFails: [38],
    });
    try {
      expect(await runMain(env, ["38"])).toBe(0);

      const state = (await readState(env))!;
      const t = ticketOf(state, 38);
      // The ticket settled done (not failed merge-race), so it was NOT retried.
      expect(t.status).toBe("done");
      expect(t.reason).toBeUndefined();
      expect(t.pr).toBe(1001);

      const shim = await readShimState(env);
      // Exactly ONE PR was opened (no duplicate from a merge-race retry) and it
      // was recorded merged despite the non-zero gh exit.
      expect(shim.prCounter).toBe(1001);
      expect(shim.merged).toEqual([1001]);
      // The issue was still closed post-merge (the success path ran to completion).
      expect(shim.closed).toContain(38);

      // The MERGE event landed ok (not the error variant a merge-race emits).
      const mergeEvt = (await readEvents(env))!.find(
        (e) => e.type === EVT.MERGE && e.ticket === 38,
      );
      expect(mergeEvt).toBeDefined();
      expect(mergeEvt!.data?.ok).toBe(true);
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
      // PR left open → its branch was NOT deleted, so it still resolves on the
      // bare origin (proves the push landed and survives the no-merge path).
      expect(revParseOrigin(env, "loop/6-add-delta")).not.toBeNull();
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

// --- new coverage: concurrency / overlap / retry / rate-limit / flags -------

describe("e2e: concurrency", () => {
  test("--concurrency 2 fans two independent tickets out and merges both", async () => {
    const env = await setup({
      issues: [issue(1, "Add alpha"), issue(2, "Add beta")],
      verdicts: { "1": ["clean"], "2": ["clean"] },
    });
    try {
      expect(await runMain(env, ["1", "2", "--concurrency", "2"])).toBe(0);

      const state = (await readState(env))!;
      expect(ticketOf(state, 1).status).toBe("done");
      expect(ticketOf(state, 2).status).toBe("done");

      // Two DISTINCT PRs merged (the shim's state lock serialised prCounter so
      // concurrent gh pr create calls didn't lose a number).
      const shim = await readShimState(env);
      expect(shim.merged.length).toBe(2);
      expect(new Set(shim.merged).size).toBe(2);
      // Both heads really landed on the bare origin (parallel real pushes).
      expect(revParseOrigin(env, "loop/1-add-alpha")).not.toBeNull();
      expect(revParseOrigin(env, "loop/2-add-beta")).not.toBeNull();
    } finally {
      await teardown(env);
    }
  }, 30_000);
});

describe("e2e: overlap + reconcile (#29)", () => {
  test("dependent overlap-launches while blocker in flight, then reconciles", async () => {
    // Three tickets + concurrency 2. Deterministic choreography:
    //   #1 (blocker)  — holdWatch: its `pr checks --watch` blocks until
    //                   state.dependentLaunched, so it can't settle before #2
    //                   overlap-launched.
    //   #2 (dependent)— dependentImpl: its implement flips dependentLaunched
    //                   (the release signal for #1's held watch).
    //   #3 (pacer)    — pacerUntil {3:1}: its implement blocks until #1 pushed
    //                   its head, so when #3 settles (freeing a slot) #2 can
    //                   overlap on #1's pushed head.
    // This removes every race: #1 settles only after #2's implement ran, and #2
    // launches only after #3 settles with #1's head already pushed.
    const env = await setup({
      issues: [
        issue(1, "Base work"),
        issue(2, "Dependent work", [1]),
        issue(3, "Pacer"),
      ],
      verdicts: { "1": ["clean"], "2": ["clean"], "3": ["clean"] },
      pacerUntil: { "3": 1 },
      holdWatch: [1],
      dependentImpl: [2],
    });
    try {
      expect(await runMain(env, ["1", "2", "3", "--concurrency", "2"])).toBe(0);

      const state = (await readState(env))!;
      expect(ticketOf(state, 1).status).toBe("done");
      expect(ticketOf(state, 2).status).toBe("done");
      expect(ticketOf(state, 3).status).toBe("done");

      // The reconcile event fired for the dependent — it ONLY emits when an
      // overlap context was present, so this proves #2 launched via frontier
      // relaxation (not after #1 completed) and reached the reconcile step.
      const rec = (await readEvents(env))!.filter(
        (e) => e.type === EVT.TICKET_RECONCILE && e.ticket === 2,
      );
      expect(rec.length).toBe(1);
      expect(rec[0]?.data?.ok).toBe(true);

      // All three merged through the real subprocess boundary.
      expect((await readShimState(env)).merged.length).toBe(3);
    } finally {
      await teardown(env);
    }
  }, 30_000);
});

describe("e2e: transient retry + backoff (#21)", () => {
  test("CI fails then passes → whole-ticket retry converges (attempts=2)", async () => {
    const env = await setup({
      issues: [issue(4, "Flaky CI")],
      verdicts: { "4": ["clean"] },
      // Per-ticket CI sequence: attempt 1 fails (transient), attempt 2 passes.
      checksSeq: { "4": ["fail", "pass"] },
    });
    try {
      expect(await runMain(env, ["4", "--max-ticket-retries", "1"])).toBe(0);

      const t = ticketOf((await readState(env))!, 4);
      expect(t.status).toBe("done");
      expect(t.attempts).toBe(2); // 1 failed + 1 succeeded

      // A ticket.retry event was emitted for the transient failure.
      const retries = (await readEvents(env))!.filter(
        (e) => e.type === EVT.TICKET_RETRY && e.ticket === 4,
      );
      expect(retries.length).toBe(1);
      expect(retries[0]?.data?.reason).toBe("ci-failed");

      // Two PRs opened (one per attempt; the failed attempt's PR is left open).
      expect((await readShimState(env)).prCounter).toBe(1002);
    } finally {
      await teardown(env);
    }
  }, 30_000);
});

describe("e2e: rate-limit fallback (#7)", () => {
  test("rate-limited primary dispatch switches to fallback and merges", async () => {
    const env = await setup({
      issues: [issue(5, "Rate limited")],
      verdicts: { "5": ["clean"] },
      rateLimited: [5],
    });
    try {
      expect(
        await runMain(env, ["5", "--fallback-provider", "codex/gpt-5.1"]),
      ).toBe(0);

      expect(ticketOf((await readState(env))!, 5).status).toBe("done");

      // The provider.switch event fired for the implement skill on rate-limit.
      const switches = (await readEvents(env))!.filter(
        (e) => e.type === EVT.PROVIDER_SWITCH && e.ticket === 5,
      );
      expect(switches.length).toBe(1);
      expect(switches[0]?.data?.skill).toBe("implement");
      expect(switches[0]?.data?.reason).toBe("rate-limited");

      expect((await readShimState(env)).merged).toContain(1001);
    } finally {
      await teardown(env);
    }
  }, 30_000);
});

describe("e2e: flags + routing", () => {
  test("--require-checks blocks merge when CI is 'none' (PR left open)", async () => {
    const env = await setup({
      issues: [issue(6, "No CI")],
      verdicts: { "6": ["clean"] },
      checks: "none", // a 'none' result normally satisfies the gate…
    });
    try {
      // …but --require-checks flips it: 'none' no longer satisfies → ci-failed.
      expect(await runMain(env, ["6", "--require-checks", "--max-ticket-retries", "0"])).toBe(1);

      const t = ticketOf((await readState(env))!, 6);
      expect(t.status).toBe("failed");
      expect(t.reason).toBe("ci-failed");
      // PR opened but never merged.
      expect((await readShimState(env)).merged).toEqual([]);
    } finally {
      await teardown(env);
    }
  });

  test("--parent discovers sub-issues via graphql and drives them", async () => {
    const env = await setup({
      issues: [issue(20, "Parent"), issue(21, "Sub A"), issue(22, "Sub B")],
      parents: { "20": [21, 22] },
      verdicts: { "21": ["clean"], "22": ["clean"] },
    });
    try {
      expect(await runMain(env, ["--parent", "20"])).toBe(0);

      const state = (await readState(env))!;
      expect(ticketOf(state, 21).status).toBe("done");
      expect(ticketOf(state, 22).status).toBe("done");
    } finally {
      await teardown(env);
    }
  });

  test("--parent falls back to #N refs in the parent body when graphql is empty", async () => {
    const env = await setup({
      issues: [
        { number: 30, title: "Parent", body: "See #31 and #32 for the breakdown." },
        issue(31, "Ref A"),
        issue(32, "Ref B"),
      ],
      // No `parents` → graphql returns empty nodes → discover parses the body.
      verdicts: { "31": ["clean"], "32": ["clean"] },
    });
    try {
      expect(await runMain(env, ["--parent", "30"])).toBe(0);

      const state = (await readState(env))!;
      expect(ticketOf(state, 31).status).toBe("done");
      expect(ticketOf(state, 32).status).toBe("done");
    } finally {
      await teardown(env);
    }
  });

  test("--merge-strategy rebase reaches gh pr merge with the rebase flag", async () => {
    const env = await setup({
      issues: [issue(7, "Rebase me")],
      verdicts: { "7": ["clean"] },
    });
    try {
      expect(await runMain(env, ["7", "--merge-strategy", "rebase"])).toBe(0);

      const shim = await readShimState(env);
      const pr = await prForTicket(env, 7);
      expect(pr).toBeDefined();
      // The shim recorded the strategy flag gh actually received.
      expect(shim.mergedStrategies[String(pr)]).toBe("rebase");
    } finally {
      await teardown(env);
    }
  });

  test("research single-shot completes with no PR", async () => {
    const env = await setup({
      issues: [{ number: 12, title: "Research me", labels: ["needs-research"] }],
    });
    try {
      expect(await runMain(env, ["12"])).toBe(0);

      const t = ticketOf((await readState(env))!, 12);
      expect(t.status).toBe("done");
      expect(t.pr).toBeUndefined();
      // No PR created.
      expect((await readShimState(env)).prCounter).toBe(1000);
    } finally {
      await teardown(env);
    }
  });

  test("--provider / --review-provider overrides reach the paseo subprocess", async () => {
    const env = await setup({
      issues: [issue(8, "Override me")],
      verdicts: { "8": ["clean"] },
    });
    try {
      expect(
        await runMain(env, [
          "8",
          "--provider",
          "codex/custom-impl",
          "--review-provider",
          "anthropic/custom-rev",
        ]),
      ).toBe(0);

      // The shim recorded the --provider argv the dispatcher passed for each
      // skill — proves the CLI override wired through to the real subprocess.
      const providers = (await readShimState(env)).providers["8"];
      expect(providers?.implement).toBe("codex/custom-impl");
      expect(providers?.review).toBe("anthropic/custom-rev");
    } finally {
      await teardown(env);
    }
  });
});

describe("e2e: agent failure modes", () => {
  test("review verdict UNKNOWN (no parseable line) → terminal review-unknown", async () => {
    const env = await setup({
      issues: [issue(9, "No verdict")],
      verdicts: { "9": ["unknown"] },
    });
    try {
      expect(await runMain(env, ["9", "--max-fix-rounds", "0"])).toBe(1);

      const t = ticketOf((await readState(env))!, 9);
      expect(t.status).toBe("failed");
      expect(t.reason).toBe("review-unknown");
    } finally {
      await teardown(env);
    }
  });

  test("implement produces no commits → terminal implement-empty", async () => {
    const env = await setup({
      issues: [issue(13, "Empty impl")],
      implementFails: [13],
    });
    try {
      expect(await runMain(env, ["13"])).toBe(1);

      const t = ticketOf((await readState(env))!, 13);
      expect(t.status).toBe("failed");
      expect(t.reason).toBe("implement-empty");
    } finally {
      await teardown(env);
    }
  });

  test("paseo run returns failed → terminal implement-failed", async () => {
    const env = await setup({
      issues: [issue(14, "Broken impl")],
      runFails: [14],
    });
    try {
      expect(await runMain(env, ["14"])).toBe(1);

      const t = ticketOf((await readState(env))!, 14);
      expect(t.status).toBe("failed");
      expect(t.reason).toBe("implement-failed");
    } finally {
      await teardown(env);
    }
  });
});

describe("e2e: lock stale-pid recovery", () => {
  test("a stale run.lock whose holder pid is dead is recovered (exit 0, not 75)", async () => {
    const env = await setup({ issues: [issue(15, "Recover")] });
    // Use a genuinely-dead pid: spawn a child that exits immediately, await
    // its exit, then write a lock claiming it as the holder. acquireLock's
    // liveness probe (process.kill(pid, 0) → ESRCH) sees it's gone → reclaims.
    const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    const deadPid = child.pid;
    await child.exited;
    try {
      await writeDeadLock(env, deadPid);
      expect(await runMain(env, ["15"])).toBe(0);

      expect(ticketOf((await readState(env))!, 15).status).toBe("done");
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
