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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  test("relay ECONNRESET on implement → transient connection-error retry converges (issue #39)", async () => {
    // A transport blip makes `paseo run` exit non-zero with ECONNRESET on
    // STDERR. Pre-fix this killed the batch as a hard implement-failed; now it
    // is classified transient `connection-error` and the ticket backs off and
    // retries, converging like a CI flake. The shim writes the errno to stderr
    // (not stdout) so this also proves dispatch() scans stderr on the failure path.
    const env = await setup({
      issues: [issue(39, "Connection blip")],
      verdicts: { "39": ["clean"] },
      // First implement dispatch: ECONNRESET to stderr + exit 1. The latch lets
      // the retry dispatch materialise a commit and exit 0.
      connectionErrors: [39],
    });
    try {
      expect(await runMain(env, ["39", "--max-ticket-retries", "1"])).toBe(0);

      const t = ticketOf((await readState(env))!, 39);
      expect(t.status).toBe("done");
      expect(t.attempts).toBe(2); // 1 transport-blip + 1 succeeded
      expect(t.reason).toBeUndefined(); // a settled-done ticket carries no failure reason

      // A transient connection-error retry was emitted — NOT a terminal cascade.
      const retries = (await readEvents(env))!.filter(
        (e) => e.type === EVT.TICKET_RETRY && e.ticket === 39,
      );
      expect(retries.length).toBe(1);
      expect(retries[0]?.data?.reason).toBe("connection-error");
    } finally {
      await teardown(env);
    }
  }, 30_000);

  test("implement dispatch exceeds the wall budget → transient agent-timeout retry converges", async () => {
    // An agent run that blows its wall budget is killed by run() (timedOut) →
    // implFailReason "timeout" → transient `agent-timeout` → backoff-and-retry.
    // Pre-this-test `agent-timeout` was never hit at E2E. Of the six transient
    // FailureReasons this now puts five behind an E2E assertion (ci-failed /
    // rate-limited / connection-error / agent-timeout here, plus the #38 merge
    // path); the remaining two — `stale-base` (needs a broken origin fetch the
    // harness can't yet script) and `merge-race` (the #38 reconcile exists
    // specifically to PREVENT it settling) — stay unit-only for now.
    //
    // DAG_AGENT_TIMEOUT_MS collapses the wall budget to ~ms; the shim's
    // `timeouts` knob hangs the first implement dispatch past it (latched
    // before the kill, so the retry materialises a commit and succeeds).
    const env = await setup({
      issues: [issue(18, "Slow agent")],
      verdicts: { "18": ["clean"] },
      timeouts: [18],
    });
    const prevTimeout = process.env.DAG_AGENT_TIMEOUT_MS;
    process.env.DAG_AGENT_TIMEOUT_MS = "300";
    try {
      expect(await runMain(env, ["18", "--max-ticket-retries", "1"])).toBe(0);

      const t = ticketOf((await readState(env))!, 18);
      expect(t.status).toBe("done");
      expect(t.attempts).toBe(2); // 1 wall-budget-exceeded + 1 succeeded

      const retries = (await readEvents(env))!.filter(
        (e) => e.type === EVT.TICKET_RETRY && e.ticket === 18,
      );
      expect(retries.length).toBe(1);
      expect(retries[0]?.data?.reason).toBe("agent-timeout");

      // The timeout fired at IMPLEMENT (pre-createPr), so attempt 1 opened no
      // PR; the retry opened exactly one and merged it. (Contrast ci-failed,
      // which fires post-createPr and so leaves a PR open per attempt.)
      expect((await readShimState(env)).prCounter).toBe(1001);
      expect((await readShimState(env)).merged).toContain(1001);
    } finally {
      if (prevTimeout === undefined) delete process.env.DAG_AGENT_TIMEOUT_MS;
      else process.env.DAG_AGENT_TIMEOUT_MS = prevTimeout;
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

  test("fix round dispatch fails → terminal fix-failed", async () => {
    // A review that found ISSUES enters the fix-loop; if the fix dispatch
    // itself fails (agent crashed / produced nothing) the ticket settles
    // terminal `fix-failed` — distinct from implement-failed (the fix step,
    // not the implement step, broke). Pre-this-test `fix-failed` was a
    // FailureReason never hit at E2E (the shim's fix always succeeded).
    const env = await setup({
      issues: [issue(16, "Fixable work")],
      verdicts: { "16": ["issues:2"] },
      fixFails: [16],
    });
    try {
      expect(await runMain(env, ["16", "--max-fix-rounds", "1"])).toBe(1);

      const t = ticketOf((await readState(env))!, 16);
      expect(t.status).toBe("failed");
      expect(t.reason).toBe("fix-failed");
      // (rounds is not persisted on the fix-failed path — lifecycle's fail()
      // helper omits it, unlike the ci-failed return — so don't assert it.)

      // No PR was ever opened — the ticket died in the fix-loop, pre-createPr.
      expect((await readShimState(env)).prCounter).toBe(1000);
    } finally {
      await teardown(env);
    }
  });

  test("triage single-shot dispatch fails → terminal single-shot-failed (no PR)", async () => {
    // A triage/research single-shot that fails settles terminal
    // `single-shot-failed`. Pre-this-test `single-shot-failed` was a
    // FailureReason never hit at E2E (the shim's single-shot always completed).
    const env = await setup({
      issues: [{ number: 17, title: "Broken triage", labels: ["needs-triage"] }],
      singleShotFails: [17],
    });
    try {
      expect(await runMain(env, ["--label", "needs-triage"])).toBe(1);

      const t = ticketOf((await readState(env))!, 17);
      expect(t.status).toBe("failed");
      expect(t.reason).toBe("single-shot-failed");
      expect(t.pr).toBeUndefined();
      expect((await readShimState(env)).prCounter).toBe(1000);
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

// --- new coverage: ci-watch-timeout / cascade-abort / SIGINT ----------------

describe("e2e: ci-watch-timeout (the load-bearing availability path)", () => {
  test("a stuck `gh pr checks --watch` hits the ceiling → transient ci-failed → retry converges", async () => {
    // README names this "the one load-bearing availability risk": a stuck /
    // never-completing check would otherwise poll forever and starve a
    // concurrency slot. The --ci-watch-timeout-minutes ceiling turns that into
    // a transient ci-failed the retry loop backs off and clears. Pre-this-test
    // the whole chain (run() kills the stuck gh → timedOut → watchChecks maps
    // to {state:fail, failed:["checks-watch-timeout"]} → transient → backoff →
    // retry) was only reasoned about, never run end-to-end.
    //
    // DAG_CI_WATCH_TIMEOUT_MS collapses the ceiling to ~ms (the flag is whole
    // minutes — too coarse for a fast test), exactly like DAG_RETRY_* collapses
    // the backoff. The shim's stuckChecksFirst sleeps past that ceiling on the
    // FIRST watch (latched before the kill, so the retry's watch falls through
    // to the scripted `none` outcome → CI ok → merge).
    const env = await setup({
      issues: [issue(4, "Stuck CI")],
      verdicts: { "4": ["clean"] },
      stuckChecksFirst: [4],
    });
    const prevCeiling = process.env.DAG_CI_WATCH_TIMEOUT_MS;
    process.env.DAG_CI_WATCH_TIMEOUT_MS = "300";
    try {
      expect(await runMain(env, ["4", "--max-ticket-retries", "1"])).toBe(0);

      const t = ticketOf((await readState(env))!, 4);
      expect(t.status).toBe("done");
      expect(t.attempts).toBe(2); // 1 stuck-timeout + 1 succeeded

      const events = (await readEvents(env))!;
      // The timeout-fired CI result carries the canonical checks-watch-timeout
      // marker — the one an operator greps for.
      const stuckCi = events.find((e) => {
        if (e.type !== EVT.CI_RESULT || e.ticket !== 4) return false;
        const failed = e.data?.failed;
        return Array.isArray(failed) && failed.includes("checks-watch-timeout");
      });
      expect(stuckCi).toBeDefined();
      expect(stuckCi!.data?.state).toBe("fail");
      // It was classified transient and retried (not terminal at retries=0).
      const retries = events.filter((e) => e.type === EVT.TICKET_RETRY && e.ticket === 4);
      expect(retries.length).toBe(1);
      expect(retries[0]?.data?.reason).toBe("ci-failed");

      // The retry's second attempt opened a fresh PR and merged it.
      expect((await readShimState(env)).prCounter).toBe(1002);
      expect((await readShimState(env)).merged).toContain(1002);
    } finally {
      if (prevCeiling === undefined) delete process.env.DAG_CI_WATCH_TIMEOUT_MS;
      else process.env.DAG_CI_WATCH_TIMEOUT_MS = prevCeiling;
      await teardown(env);
    }
  }, 30_000);
});

describe("e2e: cascade-abort of an in-flight dependent (#20)", () => {
  test("blocker fails terminally while an overlap-dependent is in flight → dependent cascade-aborted", async () => {
    // The #20 abort branch (applyCascadePlan kind:"abort") fires when a
    // dependent is GENUINELY in flight when its blocker settles failed. Under
    // the strict frontier that can't happen; it needs overlap (#29). The unit
    // tests prove applyCascadePlan with an injected fake; this proves the real
    // scheduler + cli wiring reaches the abort branch (not the mark branch)
    // under a real overlap launch.
    //
    // Choreography (mirror of the #29 overlap test, but the blocker FAILS):
    //   #1 (blocker)  — holdWatchFail: its `pr checks --watch` blocks until
    //                   state.dependentLaunched, then returns FAIL. With
    //                   --max-ticket-retries 0 that ci-failed is terminal.
    //   #2 (dependent)— dependentImpl: its implement flips dependentLaunched
    //                   (the release signal for #1's held watch). It then parks
    //                   at waitForBlockers([1]) — genuinely in flight — when #1
    //                   settles.
    //   #3 (pacer)    — pacerUntil {3:1}: its implement blocks until #1 pushed
    //                   its head; when #3 settles (freeing a slot) #2 overlap-
    //                   launches on #1's pushed head.
    // When #1 settles failed, #2 is in flight → applyCascade ABORTS it: records
    // it cascade-skipped, emits TICKET_CASCADE{reason:cascade-abort}, and fires
    // agent.abort (best-effort stop + clean).
    //
    // SCOPE NOTE: the scheduler deletes an aborted dependent from its in-flight
    // map but does NOT cancel its pending processTicket promise (the T05
    // cancel-semantics work). That orphaned promise may resume after #1 settles
    // and append its own step/pr events — so this test asserts the deterministic
    // abort contract (the cascade event + the single skipped TICKET_END, both
    // emitted synchronously at abort time, before any resume) and does NOT
    // assert #2's final state.json status or merged-set membership.
    const env = await setup({
      issues: [
        issue(1, "Base work"),
        issue(2, "Dependent work", [1]),
        issue(3, "Pacer"),
      ],
      verdicts: { "1": ["clean"], "2": ["clean"], "3": ["clean"] },
      pacerUntil: { "3": 1 },
      holdWatch: [1],
      holdWatchFail: [1],
      dependentImpl: [2],
    });
    try {
      // #1's ci-failed is terminal at retries 0 → it settles failed (not retried).
      expect(await runMain(env, ["1", "2", "3", "--concurrency", "2", "--max-ticket-retries", "0"])).toBe(1);

      const state = (await readState(env))!;
      // The blocker settled terminal ci-failed (deterministic — #1 is never
      // resumed, only its dependents can be).
      expect(ticketOf(state, 1).status).toBe("failed");
      expect(ticketOf(state, 1).reason).toBe("ci-failed");

      const events = (await readEvents(env))!;
      // The abort branch fired for the dependent — this event ONLY emits from
      // applyCascadePlan's abort path, proving the scheduler reached ABORT (not
      // the not-yet-started MARK path the existing cascade test covers).
      const cascade = events.filter(
        (e) => e.type === EVT.TICKET_CASCADE && e.ticket === 2,
      );
      expect(cascade.length).toBe(1);
      expect(cascade[0]?.data?.reason).toBe("cascade-abort");
      expect(cascade[0]?.data?.status).toBe("skipped");
      expect(Array.isArray(cascade[0]?.data?.from)).toBe(true);
      expect(cascade[0]?.data?.from).toContain(1);

      // Exactly ONE TICKET_END for #2, and it is the aborted (skipped /
      // cascade-abort) one. The orphaned resume never emits a TICKET_END (that's
      // scheduler-only, and #2 was removed from the in-flight map), so this
      // count is stable regardless of the resume race.
      const ends = events.filter((e) => e.type === EVT.TICKET_END && e.ticket === 2);
      expect(ends.length).toBe(1);
      expect(ends[0]?.data?.status).toBe("skipped");
      expect(ends[0]?.data?.reason).toBe("cascade-abort");
    } finally {
      await teardown(env);
    }
  }, 30_000);
});

describe("e2e: SIGINT releases the lock + flushes the event trace (#40)", () => {
  test("Ctrl-C mid-run exits 130, releases run.lock, leaves a complete ordered event prefix", async () => {
    // #40's RunExit coordinates stop→flush→release across signal exits. The
    // unit tests prove the ordering with an injected `exit` fake; this proves
    // the REAL signal→cleanup→lock-release chain against a spawned binary: a
    // run interrupted mid-flight must not orphan the repo-wide run.lock (the
    // next run would then fail with EX_TEMPFAIL) nor lose its event trace.
    //
    // holdWatch (no dependent) parks the run at `gh pr checks --watch` —
    // ticket in flight, lock HELD — so the signal lands while the lock is
    // genuinely owned (proving release matters). We signal right after the
    // "PR #N opened" marker (the line that precedes watchChecks).
    const env = await setup({
      issues: [issue(1, "Interrupt me")],
      verdicts: { "1": ["clean"] },
      holdWatch: [1],
    });
    try {
      const res = await spawnBinAndWaitFor(env, ["1"], "PR #1001 opened", "SIGINT");

      // Shell convention: 128 + SIGINT(2) = 130.
      expect(res.code).toBe(130);

      // The lock was released by the signal cleanup (not left held → the next
      // run would otherwise fail EX_TEMPFAIL forever).
      expect(lockExists(env)).toBe(false);

      // The event trace flushed before exit: every line parses (runEvents
      // throws on a truncated/malformed tail) and carries the run prefix up to
      // the interruption. RUN_END is emitted only at clean completion, so its
      // absence proves the run was genuinely interrupted mid-flight.
      const events = await readEvents(env);
      expect(events).not.toBeNull();
      const types = events!.map((e) => e.type);
      expect(types).toContain(EVT.RUN_START);
      expect(types).not.toContain(EVT.RUN_END);
      // seq is monotonic in emit order — the flush preserved ordering.
      const seqs = events!.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      await teardown(env);
    }
  }, 20_000);
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

/** Spawn the real `bin/dag-tickets.ts` as a child (inheriting the harness's
 *  shim PATH / scenario env), wait for `marker` to appear on its stderr, then
 *  deliver `sig`. Resolves with the child's exit code + captured stderr. Used
 *  by the SIGINT test, which can't use the in-process runMain() because
 *  signals target processes, not async functions. */
function spawnBinAndWaitFor(
  env: Env,
  args: string[],
  marker: string,
  sig: NodeJS.Signals = "SIGINT",
  timeoutMs = 15_000,
): Promise<{ code: number; stderr: string }> {
  const bin = fileURLToPath(new URL("../../bin/dag-tickets.ts", import.meta.url));
  const child = spawn(process.execPath, [bin, ...args, "--cwd", env.repo, "--run-id", "e2e"], {
    cwd: env.repo,
    env: { ...process.env },
  });
  let stderr = "";
  let signaled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error(`spawnBinAndWaitFor: timed out after ${timeoutMs}ms waiting for exit (marker=${JSON.stringify(marker)})\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (!signaled && stderr.includes(marker)) {
        signaled = true;
        try { child.kill(sig); } catch { /* race with natural exit */ }
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}
