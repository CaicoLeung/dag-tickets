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
 *    {@link EventSink} follows the same rule: a structured post-mortem channel
 *    shared by the orchestrator AND the real adapter ({@link PaseoAgent}), so it
 *    lives beside {@link Logger}, not in its own module. The file-backed adapter
 *    ({@link JsonlEventLog}) stays in events.ts; only the seam + the null fake
 *    are domain-level here — mirrors Logger being here while its writers are not.
 */
import type { ReviewVerdict, Ticket } from "./types.ts";

export type MergeStrategy = "squash" | "merge" | "rebase";

/** Severity for the shared logger. Used by the orchestrator and both adapters. */
export type LogLevel = "info" | "ok" | "warn" | "error" | "dim";
export type Logger = (level: LogLevel, msg: string, ticketNumber?: number) => void;

// ---------------------------------------------------------------------------
// EventSink — structured post-mortem channel (issue #19)
// ---------------------------------------------------------------------------

/**
 * Structured event emission seam, shared by the orchestrator
 * (lifecycle/scheduler/cli) and the real agent adapter ({@link PaseoAgent}) —
 * the same cross-seam property that puts {@link Logger} here. The real adapter
 * is `JsonlEventLog` (events.ts, append-only file); tests pass {@link NULL_SINK}
 * or a capturing fake. `emit` never throws and is durable per-call: each line
 * is on disk before `emit` returns (issue #41), so mid-run monitoring sees
 * every event without waiting for a flush.
 */
export interface EventSink {
  emit(type: string, ticket: number | undefined, data?: Record<string, unknown>): void;
}

/** Drop-all sink. Default for unit tests and for `events`-optional seams. */
export const NULL_SINK: EventSink = Object.freeze({
  emit() {},
});

export interface CheckResult {
  /** "pass" | "fail" | "none" (no CI configured). */
  state: "pass" | "fail" | "none";
  failed: string[];
}

// ---------------------------------------------------------------------------
// AgentPort
// ---------------------------------------------------------------------------

/** Why an implement step did not produce a reviewable branch. */
export type ImplFailReason =
  | "failed"
  | "timeout"
  | "rate-limited"
  | "empty"
  | "stale-base"
  | "connection-error"; // relay transport blip (ECONNRESET / stream closed) — transient, retried

/** Outcome of an implement dispatch. `ok` implies real commits landed. */
export interface ImplResult {
  ok: boolean;
  /** Commits on the branch not reachable from base (0 when reason === "empty"). */
  commits: number;
  /** Present iff `!ok`. */
  reason?: ImplFailReason;
}

/** #29: outcome of an overlap reconcile — rebase a dependent's branch onto its
 *  just-merged blocker. `ok` → rebase clean, the dependent continues; `!ok` +
 *  `reason` → the caller fails the dependent (terminal). */
export interface ReconcileResult {
  ok: boolean;
  /** Present iff `!ok`. */
  reason?: "stale-base" | "overlap-rebase";
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
  /**
   * Abort an in-flight ticket: stop its running agent dispatch and clean its
   * worktree (#20). Called by the scheduler when a running dependent's blocker
   * settles failed/skipped, so the dependent doesn't burn a full
   * implement→review→fix→CI cycle on a doomed branch. Must be safe to call on a
   * ticket whose dispatch already finished (lost race) and must not throw — the
   * scheduler records the dependent cascade-skipped regardless. Optional so
   * fakes (and tests that never exercise abort) need not implement it; an
   * absent abort leaves in-flight dependents to settle on their own.
   */
  abort?(t: Ticket): Promise<void>;
  /**
   * #29: rebase an overlapping in-flight `dependent` onto its just-merged
   *  `blocker`. `blockerTipSha` is the blocker tip captured at the dependent's
   *  launch (the base it branched from); `base` is the integration branch whose
   *  `origin/<base>` now holds the merge. Returns the outcome so the caller can
   *  fail the dependent on conflict; never throws (errors → `{ ok: false }`).
   *  Optional: fakes/tests need not implement it; an absent reconcile leaves the
   *  dependent on whatever it branched off (it may conflict at its own PR).
   */
  reconcile?(t: Ticket, blockerTipSha: string, base: string): Promise<ReconcileResult>;
  /**
   * #40: stop every agent this run still has in flight — called on graceful
   *  exit (try/finally) and on signal exit (SIGINT/SIGTERM) so a stopped or
   *  crashed run doesn't orphan running agents editing a worktree. Best-effort
   *  and never throws; a per-ticket failure doesn't skip the rest. Optional:
   *  fakes/tests need not implement it; an absent stopInFlight leaves in-flight
   *  agents to settle on their own (the pre-#40 behaviour).
   */
  stopInFlight?(ticketNumbers: Iterable<number>): Promise<void>;
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
  /** True when the agent output indicates a relay transport failure (ECONNRESET,
   *  stream closed, fetch failed, …). A transport blip is transient — paseo
   *  auto-recovers in the daemon — so the caller retries the step instead of
   *  declaring a hard `implement-failed`. Mirrors {@link rateLimited}. */
  connectionError: boolean;
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
  /**
   * Ensure `origin/<base>` is current so a branch-off from it contains a
   * blocker's same-run squash-merge. Returns false only when the fetch fails
   * (offline / no remote / non-fast-forward). A dependent ticket cannot safely
   * start on a stale base, so the caller MUST treat false as a hard failure —
   * never resolve the branch-off to `origin/<base>` without a confirmed fetch.
   */
  ensureBaseRefFresh(base: string): Promise<boolean>;
  /**
   * #29: rebase `branch` (checked out in its linked worktree) so commits in
   *  `oldBase..branch` replay onto `newBase`. Used to land an overlapped
   *  dependent onto its just-merged blocker: `oldBase` = the blocker tip the
   *  dependent branched from, `newBase` = the fetched `origin/<base>` (now
   *  holding the merge). Returns true on a clean rebase, false on conflict (the
   *  worktree is left clean via `--abort`). A branch with no linked worktree
   *  (lost race / already settled) is a no-op success.
   */
  rebaseOnto(branch: string, oldBase: string, newBase: string): Promise<boolean>;
  /**
   * #29: fetch `ref` fresh into its remote-tracking ref and resolve its tip SHA.
   *  Used at an overlap launch to (a) confirm the blocker's head branch was
   *  pushed (its createPr step) and (b) capture the exact tip the dependent
   *  branches from — the `blockerTipSha` {@link AgentPort.reconcile} later
   *  rebases `--onto`. Returns null when the fetch fails OR the ref doesn't
   *  exist on the remote (blocker hasn't pushed its head yet → the dependent
   *  must wait, not branch off a missing tip).
   */
  resolveRemoteTip(ref: string): Promise<string | null>;
}

/** Strip a stray `origin/` prefix so callers can pass either form without
 *  double-prefixing the fetch refspec (`origin/origin/main`). */
export function normalizeBase(base: string): string {
  return base.startsWith("origin/") ? base.slice("origin/".length) : base;
}

/** The remote-tracking ref for a bare branch name: `main` → `origin/main`. */
export function remoteRef(base: string): string {
  return `origin/${normalizeBase(base)}`;
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
