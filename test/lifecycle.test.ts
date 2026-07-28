import { test, expect, describe } from "bun:test";
import { processTicket, type RunContext } from "../src/lifecycle.ts";
import type {
  AgentPort,
  CheckResult,
  CreatePrOpts,
  ImplResult,
  MergeStrategy,
  RepoPort,
  StepResult,
} from "../src/ports.ts";
import type { ReviewVerdict, Ticket } from "../src/types.ts";

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
  async implement(): Promise<ImplResult> {
    return this.impl;
  }
  async review(): Promise<ReviewVerdict> {
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
}

/** Recording RepoPort. createPr returns 1000+N; watchChecks returns scripted state. */
class FakeRepo implements RepoPort {
  prs: CreatePrOpts[] = [];
  merged: number[] = [];
  closed: number[] = [];
  checks: CheckResult = { state: "pass", failed: [] };
  async cleanBranch(): Promise<void> {}
  async commitCount(): Promise<number> {
    return 3;
  }
  async deleteBranch(): Promise<void> {}
  async createPr(opts: CreatePrOpts): Promise<number> {
    this.prs.push(opts);
    return 1000 + this.prs.length;
  }
  async watchChecks(): Promise<CheckResult> {
    return this.checks;
  }
  async mergePr(n: number): Promise<void> {
    this.merged.push(n);
  }
  async closeIssue(n: number): Promise<void> {
    this.closed.push(n);
  }
}

function ctx(agent: FakeAgent, repo: FakeRepo, over: Partial<RunContext> = {}): RunContext {
  return {
    agent,
    repo,
    baseBranch: "main",
    maxFixRounds: 2,
    mergeStrategy: "squash" as MergeStrategy,
    autoMerge: true,
    requireChecks: false,
    dryRun: false,
    log: () => {},
    ...over,
  };
}

describe("implement lifecycle — happy path", () => {
  test("clean on first review: one PR, merged, closed, zero fix rounds", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakeRepo();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("done");
    expect(out.rounds).toBe(0);
    expect(repo.prs).toHaveLength(1);
    expect(repo.merged).toEqual([1001]);
    expect(repo.closed).toEqual([1]);
    expect(agent.reviewCalls).toBe(1);
    expect(agent.fixCalls).toBe(0);
  });

  test("one fix round resolves issues: rounds=1, still merged", async () => {
    const agent = new FakeAgent();
    agent.reviews = [issues(2), CLEAN];
    const repo = new FakeRepo();
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
    const repo = new FakeRepo();
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
    const repo = new FakeRepo();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(agent.reviewCalls).toBe(1); // initial only; no re-review after failed fix
    expect(repo.prs).toHaveLength(0);
  });

  test("unknown verdict after rounds is treated as not-clean: failed", async () => {
    const agent = new FakeAgent();
    agent.reviews = [{ kind: "unknown", issueCount: 0, raw: "rambled" }, CLEAN];
    const repo = new FakeRepo();
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
    const repo = new FakeRepo();
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
    const repo = new FakeRepo();
    repo.checks = { state: "none", failed: [] };
    const out = await processTicket(ticket(), ctx(agent, repo, { requireChecks: true }));
    expect(out.status).toBe("failed");
    expect(repo.merged).toHaveLength(0);
  });

  test("no CI without requireChecks: 'none' satisfies the gate, merged", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakeRepo();
    repo.checks = { state: "none", failed: [] };
    const out = await processTicket(ticket(), ctx(agent, repo, { requireChecks: false }));
    expect(out.status).toBe("done");
    expect(repo.merged).toEqual([1001]);
  });

  test("autoMerge off: done, PR left for human, NOT merged", async () => {
    const agent = new FakeAgent();
    agent.reviews = [CLEAN];
    const repo = new FakeRepo();
    const out = await processTicket(ticket(), ctx(agent, repo, { autoMerge: false }));
    expect(out.status).toBe("done");
    expect(repo.prs).toHaveLength(1);
    expect(repo.merged).toHaveLength(0);
    expect(repo.closed).toHaveLength(0);
  });
});

describe("implement lifecycle — early failure", () => {
  test("empty implement (no commits): failed before any review runs", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "empty" };
    const repo = new FakeRepo();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(agent.reviewCalls).toBe(0);
    expect(repo.prs).toHaveLength(0);
  });

  test("rate-limited implement with no fallback: failed", async () => {
    const agent = new FakeAgent();
    agent.impl = { ok: false, commits: 0, reason: "rate-limited" };
    const repo = new FakeRepo();
    const out = await processTicket(ticket(), ctx(agent, repo));
    expect(out.status).toBe("failed");
    expect(repo.prs).toHaveLength(0);
  });
});

describe("routing & dry-run", () => {
  test("single-shot (triage) completes without a PR", async () => {
    const agent = new FakeAgent();
    const repo = new FakeRepo();
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
    const repo = new FakeRepo();
    const t = ticket();
    t.kind = "unknown";
    const out = await processTicket(t, ctx(agent, repo));
    expect(out.status).toBe("skipped");
    expect(repo.prs).toHaveLength(0);
  });

  test("dry-run prints the plan and dispatches nothing", async () => {
    const agent = new FakeAgent();
    const repo = new FakeRepo();
    const out = await processTicket(ticket(), ctx(agent, repo, { dryRun: true }));
    expect(out.status).toBe("done");
    expect(repo.prs).toHaveLength(0);
    expect(agent.reviewCalls).toBe(0);
  });
});
