import { test, expect, describe } from "bun:test";
import { buildGraph, frontier, cascadeDependents, CycleError } from "../src/graph.ts";
import type { Ticket } from "../src/types.ts";

function ticket(n: number, blockedBy: number[] = [], labels = ["ready-for-agent"]): Ticket {
  return {
    number: n,
    title: `Ticket ${n}`,
    url: `https://example.com/${n}`,
    body: "",
    labels,
    state: "open",
    blockedBy,
    kind: "implement",
  };
}

describe("frontier", () => {
  test("linear chain: only the root is ready initially", () => {
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([1]);
  });

  test("completing a ticket unblocks its dependents", () => {
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    expect(frontier(g, new Set([1]), new Set(), new Set())).toEqual([2]);
    expect(frontier(g, new Set([1, 2]), new Set(), new Set())).toEqual([3]);
    expect(frontier(g, new Set([1, 2, 3]), new Set(), new Set())).toEqual([]);
  });

  test("independent tickets all ready at once (parallel fan-out)", () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3)]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([1, 2, 3]);
  });

  test("diamond dependency", () => {
    // 1 -> {2,3} -> 4
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [1]), ticket(4, [2, 3])]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([1]);
    expect(frontier(g, new Set([1]), new Set(), new Set())).toEqual([2, 3]);
    // 4 needs both 2 and 3
    expect(frontier(g, new Set([1, 2]), new Set(), new Set())).toEqual([3]);
    expect(frontier(g, new Set([1, 2, 3]), new Set(), new Set())).toEqual([4]);
  });

  test("running tickets are excluded from the frontier", () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3)]);
    expect(frontier(g, new Set(), new Set([2]), new Set())).toEqual([1, 3]);
  });

  test("failed tickets are excluded", () => {
    const g = buildGraph([ticket(1), ticket(2)]);
    expect(frontier(g, new Set(), new Set(), new Set([1]))).toEqual([2]);
  });

  test("out-of-batch blocker is treated as satisfied", () => {
    // 2 depends on 999 which isn't in the batch (already closed / external)
    const g = buildGraph([ticket(2, [999])]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([2]);
  });
});

describe("cascadeDependents", () => {
  test("a terminal blocker dooms its dependents transitively", () => {
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    expect(cascadeDependents(g, new Set(), new Set([1]))).toEqual([2, 3]);
  });

  test("completed branch is not cascaded", () => {
    // 1 terminal; 2 depends on 1 (doomed); 3 depends on nothing (survives)
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3)]);
    expect(cascadeDependents(g, new Set(), new Set([1]))).toEqual([2]);
  });

  test("status-agnostic: seeds from any set (here a 'skipped' seed)", () => {
    // Same closure logic drives both failure and skip cascades in the driver;
    // the function only answers "which dependents are blocked by the seed?".
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2]), ticket(4, [1, 3])]);
    expect(cascadeDependents(g, new Set(), new Set([1]))).toEqual([2, 3, 4]);
  });
});

describe("cycle detection", () => {
  test("throws on a direct cycle", () => {
    expect(() => buildGraph([ticket(1, [2]), ticket(2, [1])])).toThrow(CycleError);
  });

  test("throws on a longer cycle", () => {
    expect(() => buildGraph([ticket(1, [3]), ticket(2, [1]), ticket(3, [2])])).toThrow(CycleError);
  });

  test("no false positive on a diamond", () => {
    expect(() => buildGraph([ticket(1), ticket(2, [1]), ticket(3, [1]), ticket(4, [2, 3])])).not.toThrow();
  });
});
