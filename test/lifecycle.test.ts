import { test, expect, describe } from "bun:test";
import { processTicket, type RunContext, type OverlapContext } from "../src/lifecycle.ts";
import type {
  AgentPort,
  CheckResult,
  CreatePrOpts,
  ImplResult,
  MergeStrategy,
  PullRequestPort,
  ReconcileResult,
  StepResult,
} from "../src/ports.ts";
import type { ReviewVerdict, Ticket } from "../src/types.ts";
import { EVT, RecordingSink } from "../src/events.ts";
import { NULL_SINK } from "../src/ports.ts";
import { OverlapCoordinator } from "../src/cli.ts";

/** Flush the microtask queue so an async lifecycle reaches its next await
 *  (e.g. waitForBlockers registering a waiter) before an assertion reads it. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function ticket(n = 1, title = "Do the thing"): Ticket {
  return {
    number: n,
    title,
    url: `https://example.com/${n}`,
    body: "body",
    labels: ["ready-for-agent"],
    state: "open",
    blockedBy: [],
    kind: "implement",
  };
}

const CLEAN: ReviewVerdict = { kind: "clean", issueCount: 0, raw: "" };
const issues = (n: number): ReviewVerdict => ({ kind: "issues", issueCount: n, raw: "findings" });

/** Scriptable AgentPort. review()/fix() pop successive scripted outcomes. */
class FakeAgent implements AgentPort {
  reviews: ReviewVerdict[] = [];
  fixes: StepResult[] = [];
  impl: ImplResult = { ok: true, commits: 3 };
  reviewCalls = 0;
  fixCalls = 0;
  implementBase: string | undefined;
  reviewBase: string | undefined;
  async implement(_t: Ticket, _branch: string, base: string): Promise<ImplResult> {
    this.implementBase = base;
    return this.impl;
  }
  async review(_t: Ticket, _branch: string, base: string): Promise<ReviewVerdict> {
    this.reviewBase = base;
    return this.reviews[this.reviewCalls++] ?? CLEAN;
  }
  async fix(): Promise<StepResult> {
    return this.fixes[this.fixCalls++] ?? { ok: true };
  }
  async singleShot(): Promise<StepResult> {
    return { ok: true };
  }
  providerLabel(s: "implement" | "review" | "triage" | "research"): string {
    return `fake/${s}`;
  }
  // #29: optional on AgentPort; declared here so the overlap tests can script
  // it via `agent.reconcile = async (...) => ...`. Undefined by default — the
  // lifecycle guards on truthiness, and the non-overlap tests never trigger it.
  reconcile?: (t: Ticket, blockerTipSha: string, base: string) => Promise<ReconcileResult>;
}

/** Recording PullRequestPort. createPr returns 1000+N; watchChecks returns scripted state. */
class FakePullRequest implements PullRequestPort {
  prs: CreatePrOpts[] = [];
  merged: number[] = [];
  strategies: MergeStrategy[] = [];
  closed: number[] = [];
  checks: CheckResult = { state: "pass", failed: [] };
  async createPr(opts: CreatePrOpts): Promise<number> {
    this.prs.push(opts);
    return 1000 + this.prs.length;
  }
  async watchChecks(): Promise<CheckResult> {
    return this.checks;
  }
  async mergePr(n: number, strategy: MergeStrategy): Promise<void> {
    this.merged.push(n);
    this.strategies.push(strategy);
  }
  async closeIssue(n: number): Promise<void> {
    this.closed.push(n);
  }
}

function ctx(agent: FakeAgent, pr: FakePullRequest, over: Partial<RunContext> = {}): RunContext {
  return {
    agent,
    pullRequest: pr,
    baseBranch: "main",
    maxFixRounds: 2,
    mergeStrategy: "squash" as MergeStrategy,
    autoMerge: true,
    requireChecks: false,
    dryRun: false,
    log: () => {},
    events: NULL_SINK,
    ...over,
  };
}

describe("implement lifecycle — happy path", () => {
  test("clean on first review: one PR, merged, closed, zero fix rounds", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("done");
    expect(out.rounds).toBe(0);
    expect(repo.prs).toHaveLength(1);
    expect(repo.prs[0]?.head).toBeTruthy();
    expect(repo.prs[0]?.base).toBe("main");
    expect(repo.prs[0]?.title).toContain("(#1)");
    expect(repo.merged).toEqual([1001]);
    expect(repo.strategies).toEqual(["squash"]);
    expect(repo.closed).toEqual([1]);
    expect(agent.reviewCalls).toBe(1);
    expect(agent.fixCalls).toBe(0);
  });

  test("one fix round resolves issues: rounds=1, still merged", async () => {
    const agent = new FakeAgent();
    agent.reviews = [issues(2), CLEAN];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("done");
    expect(out.rounds).toBe(1);
    expect(repo.prs).toHaveLength(1);
    expect(repo.merged).toEqual([1001]);
  });
});

describe("implement lifecycle — fix-loop bounds", () => {
  test("never clean within maxFixRounds: failed, NO PR opened", async () => {
    const agent = new FakeAgent();
    agent.reviews = [issues(3), issues(3), issues(3)];
    agent.fixes = [{ ok: true }, { ok: true }];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(agent.fixCalls).toBe(2); // exactly maxFixRounds
    expect(agent.reviewCalls).toBe(3); // initial + one after each fix
    expect(repo.prs).toHaveLength(0);
    expect(repo.merged).toHaveLength(0);
  });

  test("a fix that fails aborts immediately: failed, no further review", async () => {
    const agent = new FakeAgent();
    agent.reviews = [issues(2)];
    agent.fixes = [{ ok: false }];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(agent.reviewCalls).toBe(1); // initial only; no re-review after failed fix
    expect(repo.prs).toHaveLength(0);
  });

  test("unknown verdict after rounds is treated as not-clean: failed", async () => {
    const agent = new FakeAgent();
    agent.reviews = [{ kind: "unknown", issueCount: 0, raw: "rambled" }, CLEAN];
    const repo = new FakePullRequest();
    // unknown is not "issues", so the fix-loop never engages → not clean → fail.
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(agent.fixCalls).toBe(0); // fix-loop never engages on non-issues
    expect(repo.prs).toHaveLength(0);
  });
});

describe("implement lifecycle — CI gate & merge", () => {
  test("failing CI: failed, PR retained, NOT merged, NOT closed", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    repo.checks = { state: "fail", failed: ["build"] };
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(out.pr).toBe(1001);
    expect(out.error).toBe("ci-failed");
    expect(repo.merged).toHaveLength(0);
    expect(repo.closed).toHaveLength(0);
  });

  test("no CI + requireChecks: 'none' blocks the merge gate", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    repo.checks = { state: "none", failed: [] };
    const out = await processTicket(ticket(), ctx(agent, repo, { requireChecks: true }));
    expect(out.status).toBe("failed");
    expect(repo.merged).toHaveLength(0);
  });

  test("no CI without requireChecks: 'none' satisfies the gate, merged", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    repo.checks = { state: "none", failed: [] };
    const out = await processTicket(ticket(), ctx(agent, repo, { requireChecks: false }));
    expect(out.status).toBe("done");
    expect(repo.merged).toEqual([1001]);
  });

  test("autoMerge off: done, PR left for human, NOT merged", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo, { autoMerge: false }));
    expect(out.status).toBe("done");
    expect(repo.prs).toHaveLength(1);
    expect(repo.merged).toHaveLength(0);
    expect(repo.closed).toHaveLength(0);
  });

  test("non-default mergeStrategy reaches mergePr", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo, { mergeStrategy: "rebase" }));
    expect(out.status).toBe("done");
    expect(repo.strategies).toEqual(["rebase"]);
  });
});

describe("implement lifecycle — early failure", () => {
  test("empty implement (no commits): failed before any review runs", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "empty" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(agent.reviewCalls).toBe(0);
    expect(repo.prs).toHaveLength(0);
  });

  test("rate-limited implement with no fallback: failed", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "rate-limited" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(repo.prs).toHaveLength(0);
  });
});

describe("routing & dry-run", () => {
  test("single-shot (triage) completes without a PR", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const t = ticket();
    t.kind = "triage";
    t.labels = ["needs-triage"];
    const out = await processTicket(t, ctx(agent, repo));
    expect(out.status).toBe("done");
    expect(repo.prs).toHaveLength(0);
    expect(repo.merged).toHaveLength(0);
  });

  test("unknown kind is skipped, nothing dispatched", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const t = ticket();
    t.kind = "unknown";
    const out = await processTicket(t, ctx(agent, repo));
    expect(out.status).toBe("skipped");
    expect(repo.prs).toHaveLength(0);
  });
  test("skip kind (ready-for-human) is skipped as intentional, nothing dispatched", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const t = ticket();
    t.kind = "skip";
    t.labels = ["bug", "ready-for-human"];
    const out = await processTicket(t, ctx(agent, repo));
    expect(out.status).toBe("skipped");
    expect(out.error).toBe("intentional-skip");
    expect(repo.prs).toHaveLength(0);
  });

  test("dry-run prints the plan and dispatches nothing", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo, { dryRun: true }));
    expect(out.status).toBe("done");
    expect(repo.prs).toHaveLength(0);
    expect(agent.reviewCalls).toBe(0);
  });

  test("dry-run routes a research ticket to its own provider label", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const plan: string[] = [];
    const t = ticket();
    t.kind = "research";
    t.labels = ["needs-research"];
    const out = await processTicket(
      t,
      ctx(agent, repo, { dryRun: true, log: (_lvl, msg) => plan.push(msg) }),
    );
    expect(out.status).toBe("done");
    expect(plan.some((l) => l.includes("fake/research"))).toBe(true);
    expect(plan.some((l) => l.includes("fake/review"))).toBe(false); // single-shot: no review line
    expect(repo.prs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Structured event log (issue #19): the lifecycle emits step.start/step.end
// pairs (with durationMs) for each agent pass, plus pr.created / ci.result /
// merge point events. The human log is unchanged; this is the replayable trace.
// ---------------------------------------------------------------------------

describe("lifecycle — structured event log", () => {
  test("happy path: implement→review→pr→ci→merge steps all emitted, start before end", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    const sink = new RecordingSink();
    const out = await processTicket(ticket(), ctx(agent, repo, { events: sink }));
    expect(out.status).toBe("done");

    const types = sink.types();
    // Each step.end is preceded by its step.start.
    expect(types.indexOf(EVT.STEP_START)).toBeLessThan(types.indexOf(EVT.STEP_END));
    expect(types).toContain(EVT.PR_CREATED);
    expect(types).toContain(EVT.CI_RESULT);
    expect(types).toContain(EVT.MERGE);

    const implEnd = sink.events.find((e) => e.type === EVT.STEP_END && e.data?.step === "implement");
    expect(implEnd?.data).toMatchObject({ step: "implement", ok: true, commits: 3 });
    expect(typeof implEnd?.data?.durationMs).toBe("number");

    const reviewEnd = sink.events.find((e) => e.type === EVT.STEP_END && e.data?.step === "review");
    expect(reviewEnd?.data).toMatchObject({ step: "review", verdict: "clean", issueCount: 0 });

    const pr = sink.events.find((e) => e.type === EVT.PR_CREATED);
    expect(pr?.data).toMatchObject({ pr: 1001, base: "main" });

    const ci = sink.events.find((e) => e.type === EVT.CI_RESULT);
    expect(ci?.data).toMatchObject({ state: "pass", failed: [] });

    const merge = sink.events.find((e) => e.type === EVT.MERGE);
    expect(merge?.data).toMatchObject({ strategy: "squash", ok: true });
  });

  test("fix-loop: one fix round emits review(issues)→fix(round1)→review(clean)", async () => {
    const agent = new FakeAgent();
    agent.reviews = [issues(2), CLEAN];
    const repo = new FakePullRequest();
    const sink = new RecordingSink();
    await processTicket(ticket(), ctx(agent, repo, { events: sink }));

    const reviewEnds = sink.events.filter((e) => e.type === EVT.STEP_END && e.data?.step === "review");
    expect(reviewEnds).toHaveLength(2);
    expect(reviewEnds[0]!.data).toMatchObject({ verdict: "issues", issueCount: 2 });
    expect(reviewEnds[1]!.data).toMatchObject({ verdict: "clean" });

    const fixEnds = sink.events.filter((e) => e.type === EVT.STEP_END && e.data?.step === "fix");
    expect(fixEnds).toHaveLength(1);
    expect(fixEnds[0]!.data).toMatchObject({ step: "fix", round: 1, ok: true });
  });

  test("failing CI emits ci.result(fail) and NO merge event", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    repo.checks = { state: "fail", failed: ["build"] };
    const sink = new RecordingSink();
    const out = await processTicket(ticket(), ctx(agent, repo, { events: sink }));
    expect(out.status).toBe("failed");
    expect(sink.types()).toContain(EVT.CI_RESULT);
    expect(sink.events.find((e) => e.type === EVT.CI_RESULT)?.data).toMatchObject({
      state: "fail",
      failed: ["build"],
    });
    expect(sink.types().some((t) => t === EVT.MERGE)).toBe(false);
  });

  test("autoMerge off: merge event records manual:true, ok:false", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    const sink = new RecordingSink();
    await processTicket(ticket(), ctx(agent, repo, { autoMerge: false, events: sink }));
    const merge = sink.events.find((e) => e.type === EVT.MERGE);
    expect(merge?.data).toMatchObject({ strategy: "squash", ok: false, manual: true });
  });

  test("unknown-kind skip emits no step events", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const sink = new RecordingSink();
    const t = ticket();
    t.kind = "unknown";
    await processTicket(t, ctx(agent, repo, { events: sink }));
    expect(sink.events).toHaveLength(0);
  });

  test("single-shot (triage) emits one step.start/step.end pair", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const sink = new RecordingSink();
    const t = ticket();
    t.kind = "triage";
    await processTicket(t, ctx(agent, repo, { events: sink }));
    expect(sink.events.filter((e) => e.type === EVT.STEP_START)).toHaveLength(1);
    expect(sink.events.filter((e) => e.type === EVT.STEP_END)).toHaveLength(1);
    expect(sink.events.find((e) => e.type === EVT.STEP_END)?.data?.step).toBe("triage");
  });
});

// ---------------------------------------------------------------------------
// Failure reason classification (issue #21): the structured `reason` stops the
// post-mortem from conflating "issues remain after N rounds" with "verdict
// unknown", and tags each failure site with a retry-classifiable label. The
// retry policy (isTransient in retry.ts) branches on these; a single attempt
// here never sets `attempts` (that's the retry wrapper's job).
// ---------------------------------------------------------------------------

describe("implement lifecycle — failure reason classification (issue #21)", () => {
  test("review with issues after rounds → reason review-issues (terminal)", async () => {
    const agent = new FakeAgent();
    agent.reviews = [issues(3), issues(3), issues(3)];
    agent.fixes = [{ ok: true }, { ok: true }];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("review-issues");
    expect(out.attempts).toBeUndefined(); // a single attempt doesn't set it
  });

  test("review verdict unknown → reason review-unknown, DISTINCT from issues", async () => {
    // The two used to share the `review not clean` message; reason now tells a
    // human whether the code is incomplete (issues) or the agent rambled
    // (unknown) — different kinds of attention.
    const agent = new FakeAgent();
    agent.reviews = [{ kind: "unknown", issueCount: 0, raw: "rambled" }];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("review-unknown");
    expect(out.reason).not.toBe("review-issues");
  });

  test("failing CI → reason ci-failed (transient / retryable)", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    repo.checks = { state: "fail", failed: ["build"] };
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("ci-failed");
  });

  test("empty implement → reason implement-empty (terminal)", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "empty" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.reason).toBe("implement-empty");
  });

  test("rate-limited implement → reason rate-limited (transient)", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "rate-limited" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.reason).toBe("rate-limited");
  });

  test("timeout implement → reason agent-timeout (transient)", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "timeout" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.reason).toBe("agent-timeout");
  });

  test("connection-error implement → reason connection-error (transient, issue #39)", async () => {
    // A relay transport blip (ECONNRESET / stream closed) surfaces from the
    // adapter as ImplFailReason 'connection-error'; the lifecycle maps it to a
    // transient FailureReason so the retry wrapper backs off instead of
    // killing the batch. Mirrors how 'rate-limited' / 'timeout' map.
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "connection-error" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("connection-error");
  });

  test("stale-base implement → reason stale-base (transient)", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "stale-base" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.reason).toBe("stale-base");
  });

  test("plain failed implement → reason implement-failed (terminal)", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "failed" };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.reason).toBe("implement-failed");
  });

  test("a fix round that fails → reason fix-failed (terminal)", async () => {
    const agent = new FakeAgent();
    agent.reviews = [issues(2)];
    agent.fixes = [{ ok: false }];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("fix-failed");
  });

  test("a failed single-shot → reason single-shot-failed (terminal)", async () => {
    const agent = new FakeAgent();
    const repo = new FakePullRequest();
    const t = ticket();
    t.kind = "triage";
    // FakeAgent.singleShot returns ok by default; force a failure by overriding
    // the method on the instance (a class-method spread would drop the other
    // prototype methods, so override in place instead).
    agent.singleShot = async () => ({ ok: false });
    const out = await processTicket(t, ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("single-shot-failed");
  });

  test("a successful ticket sets NO reason", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("done");
    expect(out.reason).toBeUndefined();
  });

  test("a merge that throws → reason merge-race (transient)", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakePullRequest();
    repo.mergePr = async () => {
      throw new Error("base moved under us");
    };
    const out = await processTicket(ticket(), ctx(agent, repo, { autoMerge: true }));
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("merge-race");
    expect(out.pr).toBe(1001); // PR left for a human
  });
});

// ---------------------------------------------------------------------------
// #29 overlap: an overlapped dependent composes on its blocker's head, then a
// pull-model reconcile (between dispatches, before createPr) lands it onto the
// merged integration base. A conflicting rebase fails the dependent; a clean
// createPr marks the head pushed so this ticket's own dependents can overlap.
// ---------------------------------------------------------------------------

describe("implement lifecycle — #29 overlap", () => {
  test("overlap: branches off blockerHead, reconciles before PR, marks head pushed", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const reconciled: Array<{ sha: string; base: string }> = [];
    agent.reconcile = async (_t, sha, base) => {
      reconciled.push({ sha, base });
      return { ok: true };
    };
    const repo = new FakePullRequest();
    const pushed: number[] = [];
    const overlap: OverlapContext = {
      blockerHead: "origin/loop/1-foo",
      blockerTipSha: "abc123",
    };
    const out = await processTicket(
      ticket(2),
      ctx(agent, repo, { markHeadPushed: (n) => pushed.push(n) }),
      overlap,
    );
    expect(out.status).toBe("done");
    // implement + review branched/diffed off the blocker head, not "main".
    expect(agent.implementBase).toBe("origin/loop/1-foo");
    expect(agent.reviewBase).toBe("origin/loop/1-foo");
    // reconcile fired before the PR with the captured tip + integration base.
    expect(reconciled).toEqual([{ sha: "abc123", base: "main" }]);
    // PR opened against the integration base (post-rebase).
    expect(repo.prs[0]?.base).toBe("main");
    // head-pushed signal fired so this ticket's own dependents can overlap on it.
    expect(pushed).toEqual([2]);
  });

  test("overlap: a conflicting reconcile fails the dependent (overlap-rebase), no PR", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    agent.reconcile = async () => ({ ok: false, reason: "overlap-rebase" });
    const repo = new FakePullRequest();
    const overlap: OverlapContext = {
      blockerHead: "origin/loop/1-foo",
      blockerTipSha: "abc123",
    };
    const out = await processTicket(ticket(2), ctx(agent, repo), overlap);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("overlap-rebase");
    expect(repo.prs).toHaveLength(0); // no PR after a failed reconcile
  });

  test("overlap: a stale-base reconcile fails the dependent (stale-base)", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    agent.reconcile = async () => ({ ok: false, reason: "stale-base" });
    const repo = new FakePullRequest();
    const overlap: OverlapContext = {
      blockerHead: "origin/loop/1-foo",
      blockerTipSha: "abc123",
    };
    const out = await processTicket(ticket(2), ctx(agent, repo), overlap);
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("stale-base");
  });

  test("no overlap → no reconcile call, base is the integration branch", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    let reconcileCalled = false;
    agent.reconcile = async () => {
      reconcileCalled = true;
      return { ok: true };
    };
    const repo = new FakePullRequest();
    const out = await processTicket(ticket(), ctx(agent, repo)); // no overlap arg
    expect(out.status).toBe("done");
    expect(reconcileCalled).toBe(false);
    expect(agent.implementBase).toBe("main");
  });

  test("overlap: emits ticket.reconcile {ok:true} on a clean rebase", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    agent.reconcile = async () => ({ ok: true });
    const repo = new FakePullRequest();
    const sink = new RecordingSink();
    const overlap: OverlapContext = { blockerHead: "origin/loop/1-foo", blockerTipSha: "abc123" };
    await processTicket(ticket(2), ctx(agent, repo, { events: sink }), overlap);
    const rec = sink.events.find((e) => e.type === EVT.TICKET_RECONCILE);
    expect(rec?.data).toMatchObject({ ok: true, onto: "main", from: "abc123" });
  });

  test("overlap: createPr is gated on waitForBlockers(blockers) before reconcile", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    agent.reconcile = async () => ({ ok: true });
    const repo = new FakePullRequest();
    const waitedFor: number[][] = [];
    const t = ticket(3);
    t.blockedBy = [1, 2];
    const overlap: OverlapContext = { blockerHead: "origin/loop/1-foo", blockerTipSha: "abc" };
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    const running = processTicket(
      t,
      ctx(agent, repo, { waitForBlockers: async (bs) => {
        waitedFor.push(bs);
        await gate;
      } }),
      overlap,
    );
    // createPr hasn't run yet (gate unresolved), but the gate was called with the blockers.
    await new Promise((r) => setTimeout(r, 0));
    expect(repo.prs).toHaveLength(0);
    expect(waitedFor).toEqual([[1, 2]]);
    resolveGate();
    const out = await running;
    expect(out.status).toBe("done");
    expect(repo.prs).toHaveLength(1);
  });

  test("overlap: a failed/skipped blocker does NOT release the createPr gate — stuck until cascade-abort (#31)", async () => {
    // Exercises the REAL OverlapCoordinator (the class the fix lives in) wired
    // into the lifecycle — not a hand-rolled gate model — so this validates the
    // `settled`-Set exclusion + noteSettled status guard that ARE the #31 fix.
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    agent.reconcile = async () => ({ ok: true });
    const repo = new FakePullRequest();
    const t = ticket(2);
    t.blockedBy = [1];
    const overlap: OverlapContext = { blockerHead: "origin/loop/1-foo", blockerTipSha: "abc" };

    const coord = new OverlapCoordinator([]); // empty seed — blocker 1 not settled

    const running = processTicket(
      t,
      ctx(agent, repo, { waitForBlockers: coord.waitForBlockers }),
      overlap,
    );

    await tick(); // lifecycle reaches waitForBlockers → registers a waiter on 1
    expect(repo.prs).toHaveLength(0);

    // Blocker settles failed/skipped — gate stays LOCKED (#31): noteSettled's
    // status guard skips both the `settled` add AND the waiter release.
    coord.noteSettled(1, "failed");
    await tick();
    expect(repo.prs).toHaveLength(0); // still no PR — gate didn't release
    coord.noteSettled(1, "skipped");
    await tick();
    expect(repo.prs).toHaveLength(0); // still no PR

    // #31 race guard: a non-done settle must NOT land in `settled`, so a
    // dependent that registers its waiter AFTER the settle can't bypass the
    // gate via the awaitOne short-circuit. Blocker 1 settled failed above — a
    // fresh waiter registered now must still hang, not resolve immediately.
    let lateResolved = false;
    await Promise.race([
      coord.waitForBlockers([1]).then(() => {
        lateResolved = true;
      }),
      tick(),
    ]);
    expect(lateResolved).toBe(false); // 1 ∉ settled → no short-circuit

    // Sanity: "done" releases (proves the gate is status-aware).
    coord.noteSettled(1, "done");
    await running;
    expect(repo.prs).toHaveLength(1);
  });
});
