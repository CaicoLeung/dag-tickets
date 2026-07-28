/**
 * The seam between the deterministic Ticket lifecycle and the outside world.
 *
 * The lifecycle (lifecycle.ts) is a pure state machine over {@link TicketOutcome}:
 * it owns the implement→review→fix-loop→PR→CI→merge flow but touches no external
 * system directly. Every agent run crosses {@link AgentPort}; every git/gh
 * operation crosses {@link RepoPort}. Each has a real adapter (production) and a
 * fake (tests) — two adapters justify the seam.
 *
 * Design notes:
 *  - AgentPort is domain-level (implement/review/fix), not a pass-through over
 *    `dispatch(prompt)`. The worktree-cleanup invariant ("each agent step starts
 *    on a clean branch") and the rate-limit fallback chain live INSIDE the real
 *    adapter, so the orchestrator never branches on them.
 *  - review() returns a parsed {@link ReviewVerdict}: the real adapter reuses the
 *    tested `parseReviewVerdict`, so the REVIEW_VERDICT contract stays covered by
 *    parse.test.ts and stops leaking raw agent output across the seam.
 *  - RepoPort is deliberately low-level: the git/gh ops are already cohesive, so
 *    they stay as thin methods rather than invented domain verbs.
 */
import type { ReviewVerdict, Ticket } from "./types.ts";

export type MergeStrategy = "squash" | "merge" | "rebase";

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
  /** Run one fix pass against the review verdict, on the existing branch. */
  fix(t: Ticket, verdict: ReviewVerdict, branch: string): Promise<StepResult>;
  /** Single-shot skill (triage/research) in a fresh worktree — no PR. */
  singleShot(skill: string, t: Ticket, branch: string, base: string): Promise<StepResult>;
  /** Human-readable provider that would serve this skill (dry-run display only). */
  providerLabel(skill: "implement" | "review" | "triage" | "research"): string;
}

// ---------------------------------------------------------------------------
// RepoPort
// ---------------------------------------------------------------------------

export interface CreatePrOpts {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * The git + gh operations the lifecycle drives. The real adapter shells out via
 * `git`/`gh`; a fake records calls and returns scripted results.
 */
export interface RepoPort {
  /** Remove any linked worktree whose HEAD is on `branch` (git forbids >1). */
  cleanBranch(branch: string): Promise<void>;
  /** Commits on `branch` not reachable from `base` (0 on error / no diff). */
  commitCount(base: string, branch: string): Promise<number>;
  /** Force-delete a local branch (reset a failed branch-off before retry). */
  deleteBranch(branch: string): Promise<void>;
  /** Create a PR for the pushed head branch. Returns the PR number. */
  createPr(opts: CreatePrOpts): Promise<number>;
  /** Wait for PR checks to finish, then report pass/fail/none. */
  watchChecks(prNumber: number): Promise<CheckResult>;
  /** Merge a PR with the given strategy. */
  mergePr(prNumber: number, strategy: MergeStrategy): Promise<void>;
  /** Close an issue with an explanatory comment. */
  closeIssue(number: number, comment: string): Promise<void>;
}
