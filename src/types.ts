/**
 * Core domain types for loop-tickets.
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
