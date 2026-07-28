/**
 * Core domain types for dag-tickets.
 *
 * A Ticket mirrors a GitHub issue. The driver never edits the issue body; it
 * reads `Blocked by` edges to build a dependency graph and walks the frontier
 * (open, unblocked, unclaimed) exactly like the `to-tickets` / `wayfinder`
 * skills describe.
 */

export type TicketKind = "implement" | "triage" | "research" | "unknown";

/** Lifecycle of one ticket within a run. Persisted for resume. */
export type TicketStatus =
  | "pending" // not yet ready (blocked) or waiting for a concurrency slot
  | "ready" // on the frontier; eligible to start
  | "running" // an agent pipeline is in flight for this ticket
  | "done" // merged (implement) or completed (triage/research)
  | "failed" // exhausted retries / fix-loop; needs human attention
  | "skipped"; // unknown kind, closed, or filtered out

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
