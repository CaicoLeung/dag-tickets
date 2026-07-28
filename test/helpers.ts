import { buildGraph } from "../src/graph.ts";
import type { Graph } from "../src/graph.ts";
import type { Ticket } from "../src/types.ts";

function ticket(n: number, blockedBy: number[] = []): Ticket {
  return {
    number: n,
    title: `Ticket ${n}`,
    url: `https://example.com/${n}`,
    body: "",
    labels: ["ready-for-agent"],
    state: "open",
    blockedBy,
    kind: "implement",
  };
}

/**
 * The canonical fan-in fixture for frontier-ordering tests: #2 blocks five
 * dependents (#3–#7), #1 blocks none. Shared by the graph (unit: `frontier`)
 * and scheduler (integration: `runBatch`) suites so the two cannot drift apart
 * — a change to the fixture updates both coverage paths at once.
 */
export function fanInHeavyGraph(): Graph {
  return buildGraph([
    ticket(1),
    ticket(2),
    ticket(3, [2]),
    ticket(4, [2]),
    ticket(5, [2]),
    ticket(6, [2]),
    ticket(7, [2]),
  ]);
}
