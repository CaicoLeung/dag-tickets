import { test, expect, describe } from "bun:test";
import { buildGraph, frontier, cascadeDependents, overlapBlockerFor, CycleError } from "../src/graph.ts";
import { fanInHeavyGraph } from "./helpers.ts";
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

  test("#29 overlap: an in-flight blocker satisfies a dependent when canOverlap permits", () => {
    // 1 → 2. Blocker 1 is running (in flight), not completed.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    // Strict frontier (no policy): 2 is NOT ready — 1 is neither completed nor overlap-allowed.
    expect(frontier(g, new Set(), new Set([1]), new Set())).toEqual([]);
    // Relaxed: 1 is in flight and the policy allows it → 2 becomes ready.
    expect(frontier(g, new Set(), new Set([1]), new Set(), { canOverlap: () => true })).toEqual([2]);
  });

  test("#29 overlap: canOverlap=false keeps the strict frontier", () => {
    // 1 → 2 → 3. Blocker 1 in flight.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    // Deny-all policy → nothing ready (same as no policy).
    expect(frontier(g, new Set(), new Set([1]), new Set(), { canOverlap: () => false })).toEqual([]);
    // Allow 2 to overlap 1 only → 2 ready; 3 still blocked (its blocker 2 is not in flight).
    expect(
      frontier(g, new Set(), new Set([1]), new Set(), {
        canOverlap: (dep, blocker) => dep.number === 2 && blocker.number === 1,
      }),
    ).toEqual([2]);
  });

  test("#29 overlap: a completed blocker satisfies regardless of canOverlap", () => {
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    // 1 completed → 2 ready even under a deny policy; the overlap path is never consulted.
    expect(frontier(g, new Set([1]), new Set(), new Set(), { canOverlap: () => false })).toEqual([2]);
  });

  test("#29 overlap: fan-in with two in-flight blockers stays strict (no overlap)", () => {
    // 4 depends on both 2 and 3; both in flight and overlap-permitted. Overlap
    // composes onto ONE head, so with two unresolved blockers it is unsafe →
    // 4 must NOT become ready even under an allow policy (the composition gap
    // the review flagged: a single overlapBlocker can't cover fan-in).
    const g = buildGraph([ticket(2), ticket(3), ticket(4, [2, 3])]);
    expect(frontier(g, new Set(), new Set([2, 3]), new Set(), { canOverlap: () => true })).toEqual([]);
    // Once one blocker completes, only one remains in flight → overlap-safe.
    expect(frontier(g, new Set([2]), new Set([3]), new Set(), { canOverlap: () => true })).toEqual([4]);
  });
});

describe("frontier ordering (fan-in / critical path)", () => {
  test("a ticket blocking more dependents launches before one blocking fewer", () => {
    // #2 blocks 5 dependents; #1 blocks none. Both ready. Higher fan-in first,
    // even though #1 < #2 under plain issue-number sort.
    expect(frontier(fanInHeavyGraph(), new Set(), new Set(), new Set())).toEqual([2, 1]);
  });

  test("critical-path depth breaks a fan-in tie (deeper chain first)", () => {
    // #1 and #2 each block one dependent (equal fan-in), but #2 sits atop a
    // longer downstream chain (#2 -> #4 -> #5) so it wins on critical depth.
    const g = buildGraph([
      ticket(1),
      ticket(2),
      ticket(3, [1]),
      ticket(4, [2]), ticket(5, [4]),
    ]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([2, 1]);
  });

  test("completed dependents drop out of the fan-in weight", () => {
    // #2 blocks three tickets, #1 blocks one. Initially #2 leads.
    const g = buildGraph([
      ticket(1),
      ticket(2),
      ticket(3, [2]), ticket(4, [2]), ticket(5, [2]),
      ticket(6, [1]),
    ]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([2, 1]);
    // Once #2's dependents are done it has nothing left to unblock; #1 (still
    // blocking #6) now has the higher fan-in and launches first.
    expect(frontier(g, new Set([3, 4, 5]), new Set(), new Set())).toEqual([1, 2]);
  });

  test("equal fan-in and depth fall back to ascending issue number", () => {
    // Symmetric leaves: deterministic, human-predictable tie-break.
    const g = buildGraph([
      ticket(1), ticket(2),
      ticket(3, [1]), ticket(4, [2]),
    ]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([1, 2]);
  });

  test("#29 (decision #4): an overlap-inflight dependent keeps its blocker's fan-in weight", () => {
    // #2 blocks {3,4} (fan-in 2); #1 blocks {5} (fan-in 1). Normally #2 leads.
    const g = buildGraph([
      ticket(1), ticket(2),
      ticket(3, [2]), ticket(4, [2]),
      ticket(5, [1]),
    ]);
    expect(frontier(g, new Set(), new Set(), new Set())).toEqual([2, 1]);
    // 3 launched early via overlap → it's in flight (in `running`). Naively it
    // would drop out of #2's pending dependents, tying #2's fan-in to #1's (1)
    // and flipping the order to ascending [1,2]. Excluding it from the
    // weighting `done` keeps #2's fan-in at 2 → order stays [2,1].
    expect(
      frontier(g, new Set(), new Set([3]), new Set(), { inflight: new Set([3]) }),
    ).toEqual([2, 1]);
  });
});

describe("overlapBlockerFor", () => {
  test("single in-flight blocker admitted by canOverlap → returns it", () => {
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    expect(overlapBlockerFor(g.byNumber.get(2)!, g, new Set([1]), () => true)).toBe(1);
  });

  test("two in-flight blockers (fan-in) → undefined (can't compose onto one head)", () => {
    const g = buildGraph([ticket(2), ticket(3), ticket(4, [2, 3])]);
    expect(overlapBlockerFor(g.byNumber.get(4)!, g, new Set([2, 3]), () => true)).toBeUndefined();
  });

  test("zero in-flight blockers (all completed) → undefined (no overlap needed)", () => {
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    expect(overlapBlockerFor(g.byNumber.get(2)!, g, new Set(), () => true)).toBeUndefined();
  });

  test("single in-flight blocker but canOverlap denies → undefined", () => {
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    expect(overlapBlockerFor(g.byNumber.get(2)!, g, new Set([1]), () => false)).toBeUndefined();
  });

  test("out-of-batch blocker doesn't count toward the single-in-flight check", () => {
    // 2 depends on 1 (in-flight) and 999 (out-of-batch → satisfied). One real
    // in-flight blocker → overlap-safe; the out-of-batch one is invisible here.
    const g = buildGraph([ticket(1), ticket(2, [1, 999])]);
    expect(overlapBlockerFor(g.byNumber.get(2)!, g, new Set([1]), () => true)).toBe(1);
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
