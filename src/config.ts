import type { RoutingRule, Ticket, TicketKind } from "./types.ts";

/**
 * Default label -> lifecycle routing, derived from the mattpocock skills:
 *  - `ready-for-agent`  -> /implement  (produces a PR)
 *  - `needs-triage`     -> /triage     (single agent, no PR)
 *  - research labels    -> /research   (single agent, writes a markdown asset)
 *
 * The user can override any of these label lists via CLI flags.
 */
export interface RoutingConfig {
  implementLabels: string[];
  triageLabels: string[];
  researchLabels: string[];
}

export const DEFAULT_ROUTING: RoutingConfig = {
  implementLabels: ["ready-for-agent"],
  triageLabels: ["needs-triage"],
  researchLabels: ["research", "wayfinder:research", "needs-research"],
};

/** Priority order matters: implement wins over triage wins over research. */
export function resolveKind(labels: string[], cfg: RoutingConfig = DEFAULT_ROUTING): TicketKind {
  const has = (arr: string[]) => arr.some((l) => labels.includes(l));
  if (has(cfg.implementLabels)) return "implement";
  if (has(cfg.triageLabels)) return "triage";
  if (has(cfg.researchLabels)) return "research";
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
      return { kind, skill: "", expectPr: false };
  }
}

/** Attach resolved kind to raw tickets. */
export function annotateKinds(tickets: Ticket[], cfg: RoutingConfig = DEFAULT_ROUTING): Ticket[] {
  return tickets.map((t) => ({ ...t, kind: resolveKind(t.labels, cfg) }));
}
