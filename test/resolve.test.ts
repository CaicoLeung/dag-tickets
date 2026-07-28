import { test, expect, describe } from "bun:test";
import { buildGraph, frontier, resolveTitleEdges } from "../src/graph.ts";
import type { Ticket } from "../src/types.ts";

function ticket(n: number, title: string, blockedBy: number[] = []): Ticket {
  return {
    number: n,
    title,
    url: `https://example.com/${n}`,
    body: "",
    labels: ["ready-for-agent"],
    state: "open",
    blockedBy,
    kind: "implement",
  };
}

describe("resolveTitleEdges", () => {
  test("matches the user's real title-ref convention", () => {
    const tickets = [
      ticket(25, "T2 — Ticket-type labels + routing dispatch"),
      ticket(29, "T5b — Close-out loop", [26]), // also has a #NN edge
    ];
    const refs = new Map<number, string[]>([
      [29, ["T2 — Ticket-type labels + routing dispatch"]],
    ]);
    const resolved = resolveTitleEdges(tickets, refs);
    expect(resolved.find((t) => t.number === 29)!.blockedBy).toEqual([25, 26]);
  });

  test("normalization ignores dashes, case, and whitespace", () => {
    const tickets = [ticket(1, "Refactor the Foo"), ticket(2, "x", [])];
    const refs = new Map<number, string[]>([[2, ["refactor THE  foo"]]]);
    expect(resolveTitleEdges(tickets, refs).find((t) => t.number === 2)!.blockedBy).toEqual([1]);
  });

  test("unmatched title ref is left as out-of-batch (no edge added)", () => {
    const tickets = [ticket(1, "Alpha")];
    const refs = new Map<number, string[]>([[1, ["Nonexistent ticket"]]]);
    expect(resolveTitleEdges(tickets, refs)[0]!.blockedBy).toEqual([]);
  });

  test("title edge flows through to the frontier", () => {
    // #29 blocked-by-title #25 → only #25 is on the frontier.
    const tickets = [
      ticket(25, "T2 — Ticket-type labels + routing dispatch"),
      ticket(29, "T5b — Close-out loop"),
    ];
    const refs = new Map<number, string[]>([
      [29, ["T2 — Ticket-type labels + routing dispatch"]],
    ]);
    const g = buildGraph(resolveTitleEdges(tickets, refs));
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([25]);
  });

  test("exact title wins over a normalized collision", () => {
    // Two titles collapse to the same normKey ("fixloginbug") but are distinct
    // strings. Before an exact-match pass, byNorm kept only one and a ref to
    // either could cross-link to the wrong ticket. Each ref must resolve to its
    // exact-title counterpart, not the normalized survivor.
    const tickets = [
      ticket(1, "Fix login bug"),
      ticket(2, "Fix-login-bug"),
      ticket(3, "Work item"),
    ];
    const refs = new Map<number, string[]>([[3, ["Fix login bug", "Fix-login-bug"]]]);
    const resolved = resolveTitleEdges(tickets, refs);
    expect(resolved.find((t) => t.number === 3)!.blockedBy).toEqual([1, 2]);
  });
});
