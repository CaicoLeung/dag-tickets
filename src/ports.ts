/**
 * The seam between the deterministic Ticket lifecycle and the outside world.
 *
 * The lifecycle (lifecycle.ts) is a pure state machine over {@link TicketOutcome}:
 * it owns the implement→review→fix-loop→PR→CI→merge flow but touches no external
 * system directly. Every agent run crosses {@link AgentPort}; git worktree/branch
 * hygiene crosses {@link BranchPort} (driven by the agent adapter); the gh
 * PR→CI→merge path crosses {@link PullRequestPort} (driven by the orchestrator).
 * Each has a real adapter (production) and a fake (tests) — two consumers, two
 * interfaces, zero overlap.
 *
 * Design notes:
 *  - AgentPort is domain-level (implement/review/fix), not a pass-through over
 *    `dispatch(prompt)`. The worktree-cleanup invariant ("each agent step starts
 *    on a clean branch") and the rate-limit fallback chain live INSIDE the real
 *    adapter, so the orchestrator never branches on them.
 *  - review() returns a parsed {@link ReviewVerdict}: the real adapter reuses the
 *    tested `parseReviewVerdict`, so the REVIEW_VERDICT contract stays covered by
 *    parse.test.ts and stops leaking raw agent output across the seam.
 *  - The repo surface is split by consumer: {@link BranchPort} (git worktree/
 *    branch hygiene, owned by the agent adapter) and {@link PullRequestPort}
 *    (gh PR/CI/merge/issue, owned by the orchestrator). These ops are already
 *    cohesive, so they stay thin methods rather than invented domain verbs.
 *  - {@link Logger} lives here too: both the orchestrator and the real adapters
 *    log through it, so a rate-limit retry inside PaseoAgent can surface the
 *    same `warn` line the orchestrator would — no silent retries.
 */
import type { ReviewVerdict, Ticket } from "./types.ts";

export type MergeStrategy = "squash" | "merge" | "rebase";

/** Severity for the shared logger. Used by the orchestrator and both adapters. */
export type LogLevel = "info" | "ok" | "warn" | "error" | "dim";
export type Logger = (level: LogLevel, msg: string, ticketNumber?: number) => void;

export interface CheckResult {
  /** "pass" | "fail" | "none" (no CI configured). */
  state: "pass" | "fail" | "none";
  failed: string[];
}

// ---------------------------------------------------------------------------
// AgentPort
// ---------------------------------------------------------------------------

/** Why an implement step did not produce a reviewable branch. */
export type ImplFailReason = "failed" | "timeout" | "rate-limited" | "empty";

/** Outcome of an implement dispatch. `ok` implies real commits landed. */
export interface ImplResult {
  ok: boolean;
  /** Commits on the branch not reachable from base (0 when reason === "empty"). */
  commits: number;
  /** Present iff `!ok`. */
  reason?: ImplFailReason;
}

/** Outcome of a fix or single-shot dispatch. */
export interface StepResult {
  ok: boolean;
  timedOut?: boolean;
  rateLimited?: boolean;
}

/**
 * Drives the agent half of a Ticket's lifecycle. The real adapter composes Paseo
 * dispatch (with stable-log polling), the rate-limit fallback chain, worktree
 * cleanup before each step, and verdict parsing — all hidden behind these calls.
 */
export interface AgentPort {
  /** Run /implement in a fresh worktree branched off `base`. Verifies commits landed. */
  implement(t: Ticket, branch: string, base: string): Promise<ImplResult>;
  /** Run /code-review on `branch` against `base`. Returns the parsed verdict. */
  review(t: Ticket, branch: string, base: string): Promise<ReviewVerdict>;
  /** Run one fix pass against the review verdict, on the existing branch.
   *  `round` (1-based) disambiguates repeated fix passes in the agent UI. */
  fix(t: Ticket, verdict: ReviewVerdict, branch: string, round: number): Promise<StepResult>;
  /** Single-shot skill (triage/research) in a fresh worktree — no PR. */
  singleShot(skill: string, t: Ticket, branch: string, base: string): Promise<StepResult>;
  /** Human-readable provider that would serve this skill (dry-run display only). */
  providerLabel(skill: "implement" | "review" | "triage" | "research"): string;
}

// ---------------------------------------------------------------------------
// Dispatcher — the Paseo dispatch seam
// ---------------------------------------------------------------------------

/** Options for one Paseo agent run. Mirrors `paseo run` flags. */
export interface DispatchOpts {
  provider: string;
  title: string;
  /** Paseo worktree slug — groups the run in the UI. */
  slug: string;
  cwd?: string;
  /** Max wall time for the agent run (paseo --wait-timeout). */
  timeoutMs?: number;
  mode?: string;
  branchMode: "branch-off" | "checkout-branch";
  /** branch-off: new branch to create. */
  newBranch?: string;
  /** branch-off: base ref. */
  base?: string;
  /** checkout-branch: existing branch to check out. */
  branch?: string;
}

/** Result of one Paseo agent dispatch. */
export interface DispatchResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
  /** True when the agent output indicates provider rate-limiting / quota exhaustion. */
  rateLimited: boolean;
}

/**
 * The Paseo dispatch seam consumed by the real agent adapter ({@link PaseoAgent}).
 *
 * The real adapter binds the module-level `dispatch` (stable-log polling) into a
 * rate-limit fallback loop so prod behaviour is unchanged.
 * Tests pass a fake that returns scripted {@link DispatchResult}s — letting the
 * adapter's dispatch-result → {@link ImplResult}/verdict mappings be unit-tested
 * without spawning a real `paseo run`. The two consumers (prod wiring in cli.ts,
 * focused unit tests) share one interface, exactly like AgentPort/BranchPort.
 */
export interface Dispatcher {
  dispatch(prompt: string, opts: DispatchOpts): Promise<DispatchResult>;
  dispatchWithFallback(
    prompt: string,
    opts: DispatchOpts,
    fallbacks: string[],
    onSwitch?: (nextProvider: string) => Promise<void>,
  ): Promise<DispatchResult>;
}

// ---------------------------------------------------------------------------
// BranchPort + PullRequestPort
// ---------------------------------------------------------------------------

export interface CreatePrOpts {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * Git worktree/branch hygiene. Driven by the agent adapter ({@link PaseoAgent})
 * so each agent step starts on a clean branch — the lifecycle orchestrator
 * never calls these directly.
 */
export interface BranchPort {
  /** Remove any linked worktree whose HEAD is on `branch` (git forbids >1). */
  cleanBranch(branch: string): Promise<void>;
  /** Commits on `branch` not reachable from `base` (0 on error / no diff). */
  commitCount(base: string, branch: string): Promise<number>;
  /** Force-delete a local branch (reset a failed branch-off before retry). */
  deleteBranch(branch: string): Promise<void>;
}

/**
 * The gh PR→CI→merge→close path. Driven by the lifecycle orchestrator; a fake
 * records calls and returns scripted results. Two consumers, two interfaces —
 * the agent adapter needs only BranchPort, the orchestrator only this.
 */
export interface PullRequestPort {
  /** Create a PR for the pushed head branch. Returns the PR number. */
  createPr(opts: CreatePrOpts): Promise<number>;
  /** Wait for PR checks to finish, then report pass/fail/none. */
  watchChecks(prNumber: number): Promise<CheckResult>;
  /** Merge a PR with the given strategy. */
  mergePr(prNumber: number, strategy: MergeStrategy): Promise<void>;
  /** Close an issue with an explanatory comment. */
  closeIssue(number: number, comment: string): Promise<void>;
}
