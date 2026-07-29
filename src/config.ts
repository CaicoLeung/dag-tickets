import type { RoutingRule, Ticket, TicketKind } from "./types.ts";

/**
 * Default label -> lifecycle routing, derived from the mattpocock skills'
 * seven-role triage model (see CONTEXT.md + docs/adr/0001):
 *
 *   category roles (2): bug, enhancement        — descriptive, never a trigger
 *   state roles   (5): needs-triage, needs-info, ready-for-agent,
 *                       ready-for-human, wontfix — these drive routing
 *
 *  - `ready-for-agent`  -> /implement  (produces a PR)
 *  - `needs-triage`     -> /triage     (single agent, no PR)
 *  - research labels    -> /research   (single agent, writes a markdown asset)
 *  - an issue carrying a category role but NO state role (an "orphan", e.g.
 *    `[bug]` alone) -> /triage — the canonical "unlabeled -> needs-triage" rule
 *    extended to category-labeled-but-stateless.
 *  - `needs-info` / `ready-for-human` / `wontfix` -> intentional skip: not for
 *    a batch agent, left for a human / interactive /triage.
 *
 * Any of these label lists can be overridden via CLI flags.
 */
export interface RoutingConfig {
  implementLabels: string[];
  triageLabels: string[];
  researchLabels: string[];
  /** Category roles — descriptive; never a routing trigger on their own. Used
   *  only to recognise orphans (category present, no state role). */
  categoryLabels: string[];
  /** State roles the batch driver deliberately does not act on. These settle as
   *  an intentional skip, not an unknown-kind warning. */
  skipLabels: string[];
}

export const DEFAULT_ROUTING: RoutingConfig = {
  implementLabels: ["ready-for-agent"],
  triageLabels: ["needs-triage"],
  researchLabels: ["research", "wayfinder:research", "needs-research"],
  categoryLabels: ["bug", "enhancement"],
  skipLabels: ["needs-info", "ready-for-human", "wontfix"],
};

/** Priority: implement > triage > research > skip > orphan > unknown.
 *  See ADR-0001. */
export function resolveKind(labels: string[], cfg: RoutingConfig = DEFAULT_ROUTING): TicketKind {
  const has = (arr: string[]) => arr.some((l) => labels.includes(l));
  if (has(cfg.implementLabels)) return "implement";
  if (has(cfg.triageLabels)) return "triage";
  if (has(cfg.researchLabels)) return "research";
  if (has(cfg.skipLabels)) return "skip";
  // Orphan: a category role with no state role -> triage it (it needs a state).
  // Unreachable for any state role: implement/triage/research/skip all return
  // above, so reaching here already proves no state role is present. We only
  // need to ask whether a category role is present at all.
  if (has(cfg.categoryLabels)) return "triage";
  return "unknown";
}

export function routingRuleFor(kind: TicketKind): RoutingRule {
  switch (kind) {
    case "implement":
      return { kind, skill: "implement", expectPr: true };
    case "triage":
      return { kind, skill: "triage", expectPr: false };
    case "research":
      return { kind, skill: "research", expectPr: false };
    default:
      // "skip" and "unknown" carry no skill — the driver settles both as a skip.
      return { kind, skill: "", expectPr: false };
  }
}

/** Attach resolved kind to raw tickets. */
export function annotateKinds(tickets: Ticket[], cfg: RoutingConfig = DEFAULT_ROUTING): Ticket[] {
  return tickets.map((t) => ({ ...t, kind: resolveKind(t.labels, cfg) }));
}
