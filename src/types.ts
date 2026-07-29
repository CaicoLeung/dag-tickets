/**
 * Core domain types for dag-tickets.
 *
 * A Ticket mirrors a GitHub issue. The driver never edits the issue body; it
 * reads `Blocked by` edges to build a dependency graph and walks the frontier
 * (open, unblocked, unclaimed) exactly like the `to-tickets` / `wayfinder`
 * skills describe.
 */

export type TicketKind = "implement" | "triage" | "research" | "skip" | "unknown";

/** Lifecycle of one ticket within a run. Persisted for resume. */
export type TicketStatus =
  | "pending" // not yet ready (blocked) or waiting for a concurrency slot
  | "ready" // on the frontier; eligible to start
  | "running" // an agent pipeline is in flight for this ticket
  | "done" // merged (implement) or completed (triage/research)
  | "failed" // exhausted retries / fix-loop; needs human attention
  | "skipped"; // unknown kind, intentional skip (ready-for-human/wontfix/needs-info), closed, or filtered out

/**
 * Non-natural settle marker — why a ticket settled other than by running to
 * its own outcome. Persisted on resume state so a resumed run can tell a
 * cascade-aborted dependent apart from an unknown-kind skip or a genuine error.
 *
 * - `"cascade-abort"` — an in-flight dependent killed by the cascade when its
 *   blocker settled failed/skipped (#20). Reachable in prod once the frontier
 *   lets dependents overlap in-flight blockers (#29).
 */
export type SettleReason = "cascade-abort";

export interface Ticket {
  /** GitHub issue number. */
  number: number;
  title: string;
  url: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  /** Issue numbers this ticket depends on, parsed from the body + native links. */
  blockedBy: number[];
  /** Resolved from labels via the routing config. */
  kind: TicketKind;
}

export interface ReviewVerdict {
  kind: "clean" | "issues" | "unknown";
  /** Number of actionable findings when kind === "issues". */
  issueCount: number;
  /** Tail of the agent output, for logs / human escalation. */
  raw: string;
}

/** Per-kind execution shape. */
export interface RoutingRule {
  kind: TicketKind;
  /** mattpocock skill to invoke, e.g. "implement", "triage", "research". */
  skill: string;
  /** Whether the lifecycle produces a PR that must be created, checked, merged. */
  expectPr: boolean;
}

/**
 * Why a ticket settled `failed`, as a machine-readable classification (issue #21).
 *
 * The free-form `error` string stays for the human detail ("merge failed: <gh
 * error>"); `reason` is the enum a retry policy branches on. Splitting them
 * stops the post-mortem from conflating "issues remain after N rounds" with
 * "verdict unknown" — the two used to share the same `review not clean`
 * message — and lets a transient failure (CI flake, momentary rate-limit, merge
 * race) be retried while a terminal one (issues that won't resolve) cascades.
 *
 * Retryability is policy, not intrinsic to the label, so it lives in retry.ts
 * (`isTransient`) rather than baked into this union. The split is: transient
 * causes may clear on a backoff-and-retry; terminal causes will not.
 */
export type FailureReason =
  // transient (a backoff-and-retry may clear them):
  | "ci-failed" // CI red — often a flake / momentary infra failure
  | "rate-limited" // provider quota exhausted every fallback
  | "stale-base" // origin/<base> fetch failed (offline?); refusing a stale branch-off
  | "merge-race" // gh merge failed (base moved / conflict / transient 5xx)
  | "agent-timeout" // an agent run exceeded its wall budget
  | "connection-error" // relay transport blip (ECONNRESET / stream closed / fetch failed) — paseo auto-recovers in the daemon, so a backoff-and-retry clears it
  | "push-head-failed" // #42: force-push of a rebased branch failed (transient network/credential)
  // terminal (retrying the whole ticket won't change the outcome):
  | "review-issues" // review still has actionable findings after maxFixRounds
  | "review-unknown" // review verdict stayed unknown (no ISSUES/CLEAN emitted)
  | "implement-empty" // agent completed but produced no commits
  | "implement-failed" // agent run failed (non-transient)
  | "fix-failed" // a fix round failed
  | "single-shot-failed" // a triage/research single-shot agent failed
  | "overlap-rebase"; // #29: rebasing an overlapped dependent onto its merged blocker conflicted (terminal — needs resolution)
