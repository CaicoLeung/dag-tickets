import { test, expect, describe } from "bun:test";
import { runBatch, planCascade, applyCascadePlan, type LaunchInfo } from "../src/scheduler.ts";
import { buildGraph } from "../src/graph.ts";
import { fanInHeavyGraph, retryableOutcome } from "./helpers.ts";
import type { FailureReason, Ticket, TicketStatus } from "../src/types.ts";
import type { CascadeAction } from "../src/scheduler.ts";
import { EVT, RecordingSink } from "../src/events.ts";
import { NULL_SINK } from "../src/ports.ts";
import { runWithRetry, type RetryableOutcome } from "../src/retry.ts";

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
 * Scripted `process` fake. `await Promise.resolve()` yields so that tickets the
 * scheduler launches together (up to `concurrency`) actually overlap — without
 * it each call completes synchronously before the next starts, hiding the bound.
 * Tracks call order and the peak number of overlapping calls.
 */
function makeFake(
  statuses: Record<number, TicketStatus> = {},
  throwOn: number[] = [],
) {
  const order: number[] = [];
  let concurrent = 0;
  let peak = 0;
  const process = async (n: number): Promise<TicketStatus> => {
    concurrent++;
    if (concurrent > peak) peak = concurrent;
    order.push(n);
    await Promise.resolve();
    concurrent--;
    if (throwOn.includes(n)) throw new Error(`boom-${n}`);
    return statuses[n] ?? "done";
  };
  return { process, order: () => [...order], peak: () => peak };
}

describe("runBatch — dependency ordering", () => {
  test("linear DAG processes strictly in dependency order", async () => {
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const fake = makeFake();
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.completed).toEqual([1, 2, 3]);
    // A ticket never starts before its blocker has settled.
    expect(fake.order()).toEqual([1, 2, 3]);
  });

  test("diamond: the join runs only after both branches", async () => {
    // 1 -> {2,3} -> 4
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [1]), ticket(4, [2, 3])]);
    const fake = makeFake();
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.completed).toEqual([1, 2, 3, 4]);
    const o = fake.order();
    expect(o.indexOf(1)).toBeLessThan(o.indexOf(2));
    expect(o.indexOf(1)).toBeLessThan(o.indexOf(3));
    expect(o.indexOf(2)).toBeLessThan(o.indexOf(4));
    expect(o.indexOf(3)).toBeLessThan(o.indexOf(4));
  });

  test("empty graph resolves to empty results", async () => {
    const out = await runBatch(buildGraph([]), { concurrency: 2, process: makeFake().process });
    expect(out).toEqual({ completed: [], failed: [], skipped: [] });
  });

  test("launch order follows fan-in weight (highest dependents first)", async () => {
    // #2 blocks 5 dependents; #1 blocks none. With a single worker the first
    // ticket dispatched is the one that unblocks the most downstream work.
    // Covers AC #1 (5-vs-0 ordering) at the runBatch integration seam; the
    // dry-run output clause of AC #2 has its own asserting test below.
    const fake = makeFake();
    await runBatch(fanInHeavyGraph(), { concurrency: 1, process: fake.process });
    const order = fake.order();
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
  });

  test("dry-run plan order follows fan-in weight (AC #2 dry-run clause)", async () => {
    // `--dry-run` drives the same runBatch → frontier seam, but the process fn
    // emits a plan line and returns `done` instead of dispatching (see
    // lifecycle.dryRunPlan). Assert the plan comes out in fan-in order, so the
    // "dry-run output reflects fan-in" AC is asserted directly rather than by
    // proximity to the launch-order test above.
    const plan: number[] = [];
    const dryProcess = async (n: number): Promise<TicketStatus> => {
      plan.push(n);
      return "done";
    };
    await runBatch(fanInHeavyGraph(), { concurrency: 1, process: dryProcess });
    expect(plan.indexOf(2)).toBeLessThan(plan.indexOf(1));
  });
});

describe("runBatch — concurrency bound", () => {
  test("independent tickets fan out to exactly the concurrency limit", async () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3), ticket(4)]);
    const fake = makeFake();
    await runBatch(g, { concurrency: 2, process: fake.process });
    expect(fake.peak()).toBe(2); // not 1 (serialized) and not 4 (unbounded)
  });

  test("peak never exceeds the concurrency limit", async () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3), ticket(4), ticket(5)]);
    const fake = makeFake();
    await runBatch(g, { concurrency: 3, process: fake.process });
    expect(fake.peak()).toBeLessThanOrEqual(3);
    expect(fake.peak()).toBe(3);
  });

  test("concurrency 1 serializes everything (peak == 1)", async () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3)]);
    const fake = makeFake();
    await runBatch(g, { concurrency: 1, process: fake.process });
    expect(fake.peak()).toBe(1);
  });
});

describe("runBatch — #29 frontier relaxation (overlap)", () => {
  test("a dependent launches while its blocker is still in flight under canOverlap", async () => {
    // 1 → 2. Blocker 1 is held in flight (gated), so the only way 2 can launch
    // is via overlap: frontier must see 1 in `running` and let canOverlap admit 2.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const launched: number[] = [];
    let release1!: () => void;
    const process = async (n: number): Promise<TicketStatus> => {
      launched.push(n);
      if (n === 1) await new Promise<void>((r) => { release1 = r; });
      return "done";
    };
    const run = runBatch(g, { concurrency: 2, process, canOverlap: () => true });
    // Flush microtasks: the scheduler launches 1, recomputes frontier (1 now in
    // flight → 2 overlap-ready), and launches 2 — all before 1 settles.
    await new Promise((r) => setTimeout(r, 0));
    expect(launched).toEqual([1, 2]); // 2 launched AFTER 1, BEFORE 1 settled
    release1();
    const out = await run;
    expect(out.completed).toEqual([1, 2]);
  });

  test("without canOverlap a dependent waits for its blocker to settle (strict)", async () => {
    // Same graph, no canOverlap → 2 must NOT launch while 1 is in flight.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const launched: number[] = [];
    let release1!: () => void;
    const process = async (n: number): Promise<TicketStatus> => {
      launched.push(n);
      if (n === 1) await new Promise<void>((r) => { release1 = r; });
      return "done";
    };
    const run = runBatch(g, { concurrency: 2, process }); // no canOverlap → strict
    await new Promise((r) => setTimeout(r, 0));
    expect(launched).toEqual([1]); // 2 NOT launched while 1 in flight
    release1();
    const out = await run;
    expect(out.completed).toEqual([1, 2]);
  });

  test("#29: a blocker settling done fires reconcile for each overlapping in-flight dependent", async () => {
    // 1 → {2,3}. All three gated. Release 1 → it settles done while 2,3 are
    // still in flight (overlap-launched) → reconcile must fire for both.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [1])]);
    const reconciled: Array<{ dep: number; blocker: number }> = [];
    const gates = new Map<number, () => void>();
    const process = async (n: number): Promise<TicketStatus> => {
      await new Promise<void>((r) => { gates.set(n, r); });
      return "done";
    };
    const run = runBatch(g, {
      concurrency: 3,
      process,
      canOverlap: () => true,
      reconcile: async (dep, blocker) => {
        reconciled.push({ dep, blocker });
        gates.get(dep)?.(); // rebase done → let the dependent continue + settle
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    // 1, 2, 3 all launched and gated. Release 1 → done → reconcile(2,1),(3,1).
    gates.get(1)!();
    await run;
    expect(reconciled).toContainEqual({ dep: 2, blocker: 1 });
    expect(reconciled).toContainEqual({ dep: 3, blocker: 1 });
  });

  test("#29: reconcile is not fired when the dependent was not overlap-launched", async () => {
    // Strict order: 1 settles done BEFORE 2 launches, so 2 is never in flight
    // concurrent with 1's settle → reconcile never fires.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const reconciled: Array<{ dep: number; blocker: number }> = [];
    const fake = makeFake();
    await runBatch(g, {
      concurrency: 2,
      process: fake.process,
      reconcile: async (dep, blocker) => { reconciled.push({ dep, blocker }); },
    });
    expect(reconciled).toEqual([]);
  });

  test("#29: process receives {overlapBlocker} on an overlap launch and {} otherwise", async () => {
    // 1 → 2. Hold 1 in flight; 2 overlap-launches (canOverlap).
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const infos: Array<{ n: number; info: LaunchInfo | undefined }> = [];
    let release1!: () => void;
    const process = async (n: number, info?: LaunchInfo): Promise<TicketStatus> => {
      infos.push({ n, info });
      if (n === 1) await new Promise<void>((r) => { release1 = r; });
      return "done";
    };
    const run = runBatch(g, { concurrency: 2, process, canOverlap: () => true });
    await new Promise((r) => setTimeout(r, 0));
    // 1 launched normally (no overlap info); 2 launched overlapping 1.
    expect(infos.find((i) => i.n === 1)?.info).toEqual({});
    expect(infos.find((i) => i.n === 2)?.info).toEqual({ overlapBlocker: 1 });
    release1();
    await run;
  });
});

describe("runBatch — failure cascade", () => {
  test("a failed ticket cascades to its unstarted dependents", async () => {
    // 1 fails -> 2 (depends on 1) and 3 (depends on 2) never run.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const fake = makeFake({ 1: "failed" });
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.failed).toEqual([1, 2, 3]);
    expect(out.completed).toEqual([]);
    expect(fake.order()).toEqual([1]); // dependents never processed
  });

  test("an independent sibling of a failure still completes", async () => {
    // 1 fails; 2 depends on 1 (cascades); 3 is independent (survives).
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3)]);
    const fake = makeFake({ 1: "failed" });
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.completed).toEqual([3]);
    expect(out.failed).toEqual([1, 2]);
  });

  test("a process that throws is recorded as failed and cascades", async () => {
    // The launch `.catch` must absorb the rejection -> status "failed".
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const fake = makeFake({}, [1]); // ticket 1 throws
    const out = await runBatch(g, { concurrency: 2, process: fake.process });
    expect(out.failed).toEqual([1, 2]);
    expect(fake.order()).toEqual([1]);
  });
});

describe("runBatch — cascade reaches the settle callback", () => {
  test("a mid-run failure reports each cascaded dependent as failed via onSettle", async () => {
    // 1 fails -> 2 (depends on 1) and 3 (depends on 2) cascade. Each must
    // reach onSettle so a killed run persists them without waiting for resume.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const settled: Array<[number, TicketStatus]> = [];
    await runBatch(g, {
      concurrency: 3,
      process: makeFake({ 1: "failed" }).process,
      onSettle: (n, s) => settled.push([n, s]),
    });
    expect(settled).toContainEqual([1, "failed"]);
    expect(settled).toContainEqual([2, "failed"]);
    expect(settled).toContainEqual([3, "failed"]);
    // root cause recorded before its dependents
    expect(settled.findIndex((e) => e[0] === 1)).toBeLessThan(
      settled.findIndex((e) => e[0] === 2),
    );
  });

  test("a mid-run failure fires onSettle exactly once per dependent (no dup on later settles)", async () => {
    // 1 fails (cascades 2); 3 is independent and completes afterwards. The
    // cascade recompute on 3's settle must not re-fire for 2.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3)]);
    const settled: Array<[number, TicketStatus]> = [];
    await runBatch(g, {
      concurrency: 1, // serialize: 1 settles, then 3 settles, so 2 is cascaded
      process: makeFake({ 1: "failed" }).process,
      onSettle: (n, s) => settled.push([n, s]),
    });
    const twoFails = settled.filter((e) => e[0] === 2 && e[1] === "failed");
    expect(twoFails).toHaveLength(1);
  });

  test("a seeded-failure cascade at startup reports each cascaded dependent via onSettle", async () => {
    // Resumed run: 1 already failed (persisted). Its dependents 2,3 cascade
    // at startup and must be persisted immediately, not only on next resume.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const settled: Array<[number, TicketStatus]> = [];
    await runBatch(g, {
      concurrency: 3,
      process: makeFake().process,
      seedFailed: [1],
      onSettle: (n, s) => settled.push([n, s]),
    });
    expect(settled).toContainEqual([2, "failed"]);
    expect(settled).toContainEqual([3, "failed"]);
    // the seeded failure itself is NOT re-reported (already persisted)
    expect(settled.find((e) => e[0] === 1)).toBeUndefined();
  });
});

describe("runBatch — skip cascade", () => {
  test("a skipped ticket cascades skip to its unstarted dependents (multi-hop)", async () => {
    // 1 skips (unknown kind) -> 2 (depends on 1) and 3 (depends on 2) never run
    // and are reported skipped, not silently dropped nor failed.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const fake = makeFake({ 1: "skipped" });
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.skipped).toEqual([1, 2, 3]);
    expect(out.failed).toEqual([]);
    expect(out.completed).toEqual([]);
    expect(fake.order()).toEqual([1]); // dependents never processed
  });

  test("a skipped join cascades through a diamond", async () => {
    // 1 skips -> {2,3} -> 4 all skip transitively.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [1]), ticket(4, [2, 3])]);
    const fake = makeFake({ 1: "skipped" });
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.skipped).toEqual([1, 2, 3, 4]);
    expect(fake.order()).toEqual([1]);
  });

  test("an independent sibling of a skip still completes", async () => {
    // 1 skips; 2 depends on 1 (cascades skip); 3 is independent (survives).
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3)]);
    const fake = makeFake({ 1: "skipped" });
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.completed).toEqual([3]);
    expect(out.skipped).toEqual([1, 2]);
  });
});

describe("runBatch — skip cascade reaches the settle callback", () => {
  test("a mid-run skip reports each cascaded dependent as skipped via onSettle", async () => {
    // 1 skips -> 2 and 3 cascade. Each must reach onSettle as 'skipped' so a
    // killed run persists them without waiting for resume.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const settled: Array<[number, TicketStatus]> = [];
    await runBatch(g, {
      concurrency: 3,
      process: makeFake({ 1: "skipped" }).process,
      onSettle: (n, s) => settled.push([n, s]),
    });
    expect(settled).toContainEqual([1, "skipped"]);
    expect(settled).toContainEqual([2, "skipped"]);
    expect(settled).toContainEqual([3, "skipped"]);
    // root cause recorded before its dependents
    expect(settled.findIndex((e) => e[0] === 1)).toBeLessThan(
      settled.findIndex((e) => e[0] === 2),
    );
  });

  test("a mid-run skip fires onSettle exactly once per dependent", async () => {
    // 1 skips (cascades 2); 3 is independent and completes afterwards. The
    // cascade recompute on 3's settle must not re-fire for 2.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3)]);
    const settled: Array<[number, TicketStatus]> = [];
    await runBatch(g, {
      concurrency: 1, // serialize: 1 settles, then 3 settles
      process: makeFake({ 1: "skipped" }).process,
      onSettle: (n, s) => settled.push([n, s]),
    });
    const twoSkips = settled.filter((e) => e[0] === 2 && e[1] === "skipped");
    expect(twoSkips).toHaveLength(1);
  });

  test("a seeded-skip cascade at startup reports each cascaded dependent via onSettle", async () => {
    // Resumed run: 1 already skipped (persisted). Its dependents 2,3 cascade
    // at startup and must be persisted immediately, not only on next resume.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const settled: Array<[number, TicketStatus]> = [];
    await runBatch(g, {
      concurrency: 3,
      process: makeFake().process,
      seedSkipped: [1],
      onSettle: (n, s) => settled.push([n, s]),
    });
    expect(settled).toContainEqual([2, "skipped"]);
    expect(settled).toContainEqual([3, "skipped"]);
    // the seeded skip itself is NOT re-reported (already persisted)
    expect(settled.find((e) => e[0] === 1)).toBeUndefined();
  });

  test("an already-completed dependent is not yanked when its blocker later skips", async () => {
    // 1 skips this run; 2 depends on 1 but was completed last run (seeded).
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const fake = makeFake({ 1: "skipped" });
    const out = await runBatch(g, {
      concurrency: 2,
      process: fake.process,
      seedCompleted: [2],
    });
    expect(out.skipped).toEqual([1]);
    expect(out.completed).toEqual([2]); // resume correctness: not re-cascaded
  });
});

describe("runBatch — skipped and callbacks", () => {
  test("skipped tickets are counted separately and don't block siblings", async () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3)]);
    const fake = makeFake({ 2: "skipped" });
    const out = await runBatch(g, { concurrency: 3, process: fake.process });
    expect(out.skipped).toEqual([2]);
    expect(out.completed).toEqual([1, 3]);
  });

  test("onSettle fires once per processed ticket with its status", async () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3)]);
    const settled: Array<[number, TicketStatus]> = [];
    await runBatch(g, {
      concurrency: 3,
      process: makeFake({ 2: "skipped" }).process,
      onSettle: (n, s) => settled.push([n, s]),
    });
    expect(settled).toHaveLength(3);
    expect(settled).toContainEqual([1, "done"]);
    expect(settled).toContainEqual([2, "skipped"]);
    expect(settled).toContainEqual([3, "done"]);
  });
});

describe("runBatch — resume (seed)", () => {
  test("seeded-completed tickets are not reprocessed and unblock dependents", async () => {
    // 1 already done (seeded); 2 depends on 1 and should now run.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const fake = makeFake();
    const out = await runBatch(g, {
      concurrency: 2,
      process: fake.process,
      seedCompleted: [1],
    });
    expect(out.completed).toEqual([1, 2]);
    expect(fake.order()).toEqual([2]); // 1 skipped entirely
  });

  test("seeded-failed tickets cascade to dependents at startup", async () => {
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const fake = makeFake();
    const out = await runBatch(g, {
      concurrency: 3,
      process: fake.process,
      seedFailed: [1],
    });
    expect(out.failed).toEqual([1, 2, 3]);
    expect(fake.order()).toEqual([]); // nothing to run — all cascaded
  });

  test("an already-completed dependent is not yanked when its blocker later fails", async () => {
    // 1 fails this run; 2 depends on 1 but was completed last run (seeded).
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const fake = makeFake({ 1: "failed" });
    const out = await runBatch(g, {
      concurrency: 2,
      process: fake.process,
      seedCompleted: [2],
    });
    expect(out.failed).toEqual([1]);
    expect(out.completed).toEqual([2]); // resume correctness: not re-cascaded
  });
});

// ---------------------------------------------------------------------------
// Structured event log (issue #19): the scheduler is the source of ticket
// start/end + cascade transitions. Lifecycle step + provider.switch events
// live in lifecycle/paseo and are tested there.
// ---------------------------------------------------------------------------

describe("runBatch — structured event log", () => {
  test("each processed ticket emits ticket.start then ticket.end(done) with durationMs", async () => {
    const g = buildGraph([ticket(1), ticket(2), ticket(3)]);
    const sink = new RecordingSink();
    await runBatch(g, { concurrency: 3, process: makeFake().process, events: sink });

    for (const n of [1, 2, 3]) {
      const ev = sink.of(n);
      const startIdx = ev.findIndex((e) => e.type === EVT.TICKET_START);
      const endIdx = ev.findIndex((e) => e.type === EVT.TICKET_END);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      const end = ev[endIdx]!;
      expect(end.data?.status).toBe("done");
      expect(typeof end.data?.durationMs).toBe("number");
      expect(end.data!.durationMs as number).toBeGreaterThanOrEqual(0);
    }
  });

  test("a failed ticket cascades ticket.cascade(failed, from=[root]) to dependents", async () => {
    // 1 fails -> 2 (dep on 1) and 3 (dep on 2) cascade. Each must emit
    // ticket.cascade (never ticket.start/ticket.end) with from linking to its
    // immediate terminal blocker.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const sink = new RecordingSink();
    await runBatch(g, {
      concurrency: 3,
      process: makeFake({ 1: "failed" }).process,
      events: sink,
    });

    // root cause: processed -> ticket.end(failed)
    const oneEnd = sink.of(1).find((e) => e.type === EVT.TICKET_END);
    expect(oneEnd?.data?.status).toBe("failed");

    // 2 cascades from 1; 3 cascades from 2.
    const two = sink.of(2).find((e) => e.type === EVT.TICKET_CASCADE);
    expect(two?.data?.status).toBe("failed");
    expect(two?.data?.from).toEqual([1]);
    expect(sink.of(2).some((e) => e.type === EVT.TICKET_START)).toBe(false);

    const three = sink.of(3).find((e) => e.type === EVT.TICKET_CASCADE);
    expect(three?.data?.status).toBe("failed");
    expect(three?.data?.from).toEqual([2]);
  });

  test("a skipped ticket cascades ticket.cascade(skipped) to dependents", async () => {
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const sink = new RecordingSink();
    await runBatch(g, {
      concurrency: 2,
      process: makeFake({ 1: "skipped" }).process,
      events: sink,
    });
    expect(sink.of(1).find((e) => e.type === EVT.TICKET_END)?.data?.status).toBe("skipped");
    const two = sink.of(2).find((e) => e.type === EVT.TICKET_CASCADE);
    expect(two?.data?.status).toBe("skipped");
    expect(two?.data?.from).toEqual([1]);
  });

  test("seeded terminal tickets emit nothing (already persisted on a prior run)", async () => {
    // Resumed run: 1 already failed. 2 cascades at startup; 1 itself emits
    // neither start nor end (the resume contract: don't re-report seeded state).
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const sink = new RecordingSink();
    await runBatch(g, {
      concurrency: 2,
      process: makeFake().process,
      seedFailed: [1],
      events: sink,
    });
    expect(sink.of(1)).toEqual([]);
    expect(sink.of(2).find((e) => e.type === EVT.TICKET_CASCADE)?.data?.from).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// #20 — abort in-flight dependents on cascade failure.
//
// Under the scheduler's strict frontier a dependent can only be in-flight once
// *all* its blockers are `completed`, so a failing blocker can never have a
// genuinely in-flight dependent through runBatch's normal flow. The abort
// branch is forward-compat for when dependents can overlap blockers; the pure
// {@link planCascade} is the surface that proves it correct, so it is unit-
// tested directly. The runBatch tests below prove the applier wires the plan to
// opts.abort (and that the mark path never accidentally aborts).
// ---------------------------------------------------------------------------

describe("planCascade — mark vs abort decision (#20)", () => {
  const sets = (over: Partial<{ completed: number[]; failed: number[]; skipped: number[]; inflight: number[] }> = {}) => ({
    completed: new Set(over.completed ?? []),
    failed: new Set(over.failed ?? []),
    skipped: new Set(over.skipped ?? []),
    inflight: new Set(over.inflight ?? []),
  });

  test("a not-yet-started dependent plans a MARK with the blocker's status", () => {
    // 1 failed -> 2 (depends on 1), not started. Plan marks 2 failed from [1].
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const plan = planCascade(g, new Set([1]), "failed", sets({ failed: [1] }));
    expect(plan).toEqual([{ dep: 2, kind: "mark", status: "failed", from: [1] }]);
  });

  test("an in-flight dependent plans an ABORT recorded cascade-skipped", () => {
    // 1 failed -> 2 (depends on 1), 2 currently in-flight. Plan aborts 2.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const plan = planCascade(g, new Set([1]), "failed", sets({ failed: [1], inflight: [2] }));
    expect(plan).toEqual([{ dep: 2, kind: "abort", status: "skipped", from: [1] }]);
  });

  test("a skipped blocker cascades skip (mark), never abort for a not-started dependent", () => {
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const plan = planCascade(g, new Set([1]), "skipped", sets({ skipped: [1] }));
    expect(plan).toEqual([{ dep: 2, kind: "mark", status: "skipped", from: [1] }]);
  });

  test("transitive `from` links the immediately-doomed blocker (2 mark from [1], 3 mark from [2])", () => {
    // Proves the local-mirror: each dep is recorded before the next dep's `from`
    // is read, so 3 (depends on 2) reports from [2] not [].
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const plan = planCascade(g, new Set([1]), "failed", sets({ failed: [1] }));
    expect(plan).toEqual([
      { dep: 2, kind: "mark", status: "failed", from: [1] },
      { dep: 3, kind: "mark", status: "failed", from: [2] },
    ]);
  });

  test("an aborted dependent dooms its own dependents (3 mark from [2] now skipped)", () => {
    // 1 failed -> 2 in-flight (aborted -> skipped) -> 3 (depends on 2). 3 is
    // doomed by the now-skipped 2, so its from is [2]. Confirms the abort path
    // feeds the local mirror just like the mark path.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const plan = planCascade(g, new Set([1]), "failed", sets({ failed: [1], inflight: [2] }));
    expect(plan).toEqual([
      { dep: 2, kind: "abort", status: "skipped", from: [1] },
      { dep: 3, kind: "mark", status: "failed", from: [2] },
    ]);
  });

  test("first-wins: an already-terminal dependent is never re-decided", () => {
    // 1 failed this pass; 2 already completed last run (seeded). 2 keeps done.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const plan = planCascade(g, new Set([1]), "failed", sets({ failed: [1], completed: [2] }));
    expect(plan).toEqual([]);
  });

  test("first-wins: an in-flight dependent already skipped is not re-aborted", () => {
    // 1 failed; 2 in-flight but already cascade-skipped (e.g. doomed by another
    // blocker that settled first). A second failing blocker must not re-abort.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const plan = planCascade(g, new Set([1]), "failed", sets({ failed: [1], inflight: [2], skipped: [2] }));
    expect(plan).toEqual([]);
  });

  test("a seed with no dependents plans nothing", () => {
    const g = buildGraph([ticket(1), ticket(2)]); // independent
    expect(planCascade(g, new Set([1]), "failed", sets({ failed: [1] }))).toEqual([]);
  });
});

describe("runBatch — in-flight abort wiring (#20)", () => {
  test("opts.abort is never called for a not-started cascade (mark path only)", async () => {
    // 1 fails -> 2 (not started) cascades failed. With an abort hook wired, the
    // mark path must NOT invoke it: 2 was never in flight, so there's nothing
    // to kill. Guards against the applier mis-routing mark -> abort.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const aborted: number[] = [];
    await runBatch(g, {
      concurrency: 2,
      process: makeFake({ 1: "failed" }).process,
      abort: async (n) => {
        aborted.push(n);
      },
    });
    expect(aborted).toEqual([]);
  });

  test("without an abort hook, a failing blocker still cascades (pre-#20 behaviour)", async () => {
    // No abort wired: in-flight dependents (none reachable today, but the
    // guard) are left to settle, and not-started dependents cascade as before.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const out = await runBatch(g, { concurrency: 3, process: makeFake({ 1: "failed" }).process });
    expect(out.failed).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// applyCascadePlan — the applier side of the cascade. planCascade (the pure
// decision) is covered above; these tests prove the SIDE-EFFECT machinery that
// runBatch's strict frontier can't reach today: an abort action removes the
// dependent from the in-flight race (the no-double-report guard), records it
// cascade-skipped with a typed reason, fires the kill, and emits the close
// events. This is the seam #29 (frontier relaxation) makes reachable in prod.
// ---------------------------------------------------------------------------

describe("applyCascadePlan — abort side-effect machinery (#20)", () => {
  test("an abort action deletes the dependent from the race, records cascade-skipped, and fires the kill", () => {
    // Dep 2 is in-flight, doomed by failed blocker 1. The plan says abort 2.
    const plan: CascadeAction[] = [
      { dep: 2, kind: "abort", status: "skipped", from: [1] },
    ];
    const sets = {
      completed: new Set<number>(),
      failed: new Set<number>([1]),
      skipped: new Set<number>(),
    };
    // 2 is in the in-flight race map — the precondition #29 will make live.
    const inflight = new Map<number, unknown>([[2, Promise.resolve({ number: 2, status: "done" })]]);
    const startedAt = new Map<number, number>([[2, Date.now() - 50]]);
    const settled: Array<{ n: number; status: TicketStatus; reason?: string }> = [];
    const aborted: number[] = [];
    const sink = new RecordingSink();

    applyCascadePlan(plan, sets, inflight, startedAt, {
      onSettle: (n, status, reason) => settled.push({ n, status, reason }),
      abort: async (n) => {
        aborted.push(n);
      },
      events: sink,
    });

    // no-double-report: 2 is gone from the race map → its orphaned promise
    // (still pending above) can never win a later Promise.race / re-settle.
    expect(inflight.has(2)).toBe(false);
    // recorded cascade-skipped synchronously, before the kill is awaited
    expect([...sets.skipped]).toEqual([2]);
    expect(settled).toEqual([{ n: 2, status: "skipped", reason: "cascade-abort" }]);
    // the dispatch kill was fired
    expect(aborted).toEqual([2]);
    // events: cascade + end both stamped cascade-abort; end carries durationMs
    const cascade = sink.of(2).find((e) => e.type === EVT.TICKET_CASCADE);
    expect(cascade?.data).toMatchObject({ status: "skipped", from: [1], reason: "cascade-abort" });
    const end = sink.of(2).find((e) => e.type === EVT.TICKET_END);
    expect(end?.data).toMatchObject({ status: "skipped", reason: "cascade-abort" });
    expect(typeof end?.data?.durationMs).toBe("number");
    // startedAt entry closed + removed (no dangling lifecycle pair)
    expect(startedAt.has(2)).toBe(false);
  });

  test("an abort action for a dependent no longer in-flight is a no-op (lost race)", () => {
    // 2 already settled naturally and left the race before the cascade ran —
    // the applier must not re-record it or fire a redundant kill.
    const plan: CascadeAction[] = [{ dep: 2, kind: "abort", status: "skipped", from: [1] }];
    const sets = { completed: new Set<number>(), failed: new Set<number>([1]), skipped: new Set<number>() };
    const inflight = new Map<number, unknown>(); // 2 already gone
    let settled = false;
    let aborted = false;
    applyCascadePlan(plan, sets, inflight, new Map(), {
      onSettle: () => {
        settled = true;
      },
      abort: async () => {
        aborted = true;
      },
      events: new RecordingSink(),
    });
    expect(settled).toBe(false);
    expect(aborted).toBe(false);
    expect(sets.skipped.has(2)).toBe(false);
  });

  test("an abort action with no kill hook leaves the dependent in flight (pre-#20 behaviour)", () => {
    // No abort wired: the applier must not touch the race map or record a
    // status — the dependent settles naturally via its own promise.
    const plan: CascadeAction[] = [{ dep: 2, kind: "abort", status: "skipped", from: [1] }];
    const sets = { completed: new Set<number>(), failed: new Set<number>([1]), skipped: new Set<number>() };
    const inflight = new Map<number, unknown>([[2, Promise.resolve()]]);
    let settled = false;
    applyCascadePlan(plan, sets, inflight, new Map(), {
      onSettle: () => {
        settled = true;
      },
      events: new RecordingSink(),
    });
    expect(inflight.has(2)).toBe(true); // untouched
    expect(settled).toBe(false);
    expect(sets.skipped.has(2)).toBe(false);
  });

  test("a mark action records the blocker's status with no reason and never fires the kill", () => {
    const plan: CascadeAction[] = [{ dep: 2, kind: "mark", status: "failed", from: [1] }];
    const sets = { completed: new Set<number>(), failed: new Set<number>([1]), skipped: new Set<number>() };
    const settled: Array<{ n: number; status: TicketStatus; reason?: string }> = [];
    let aborted = false;
    const sink = new RecordingSink();
    applyCascadePlan(plan, sets, new Map(), new Map(), {
      onSettle: (n, status, reason) => settled.push({ n, status, reason }),
      abort: async () => {
        aborted = true;
      },
      events: sink,
    });
    expect([...sets.failed]).toEqual([1, 2]);
    expect(settled).toEqual([{ n: 2, status: "failed" }]); // no reason on a natural cascade
    expect(aborted).toBe(false);
    expect(sink.of(2).find((e) => e.type === EVT.TICKET_CASCADE)?.data).toMatchObject({
      status: "failed",
      from: [1],
    });
  });
});

// Transient retry integration (issue #21): the cli wraps processTicket in
// runWithRetry and hands the composed function to runBatch as `process`. The
// scheduler itself never sees intermediate transient attempts — they're
// absorbed inside runWithRetry — so this composes exactly the cli wiring and
// asserts the two end-to-end behaviours the issue cares about:
//   1. a transient failure that later succeeds completes (no cascade), and
//   2. a terminal failure (or exhausted transient budget) still cascades.
// Each attempt yields so concurrent tickets genuinely overlap.
// ---------------------------------------------------------------------------

describe("runBatch — transient retry integration (issue #21)", () => {
  /** Builds a `process` fn = runWithRetry over a per-ticket outcome script.
   *  `script[n]` is the list of (status, reason?) outcomes returned by
   *  successive attempts; the ticket keeps retrying while they're transient
   *  failed, stopping on the first done/skipped/terminal. */
  function retriableProcess(
    script: Record<number, Array<{ status: RetryableOutcome["status"]; reason?: FailureReason }>>,
    maxRetries: number,
    settled?: Array<[number, TicketStatus]>,
    attempts?: Record<number, number>,
  ) {
    const idx: Record<number, number> = {};
    return async (n: number): Promise<TicketStatus> => {
      const outcome = await runWithRetry(
        async () => {
          await Promise.resolve(); // yield so concurrent tickets overlap
          const seq = script[n] ?? [{ status: "done" as const }];
          const step = seq[idx[n] = (idx[n] ?? 0)] ?? seq[seq.length - 1]!;
          idx[n]++;
          return retryableOutcome(step.status, step.reason);
        },
        {
          maxRetries,
          baseDelayMs: 0, // no real waiting in tests
          maxDelayMs: 0,
          sleep: async () => {},
          events: NULL_SINK,
          onAttempt: (a, o) => {
            if (attempts) attempts[n] = a;
          },
        },
      );
      settled?.push([n, outcome.status]);
      return outcome.status;
    };
  }

  test("transient CI flake retried then succeeds: completes, dependents still run", async () => {
    // #1 flakes once (ci-failed) then merges on attempt 2; #2 depends on #1.
    // The scheduler sees #1 settle `done` — it never learns about the flake —
    // so #2 runs normally instead of being cascaded-skipped.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const settled: Array<[number, TicketStatus]> = [];
    const attempts: Record<number, number> = {};
    const process = retriableProcess(
      { 1: [{ status: "failed", reason: "ci-failed" }, { status: "done" }] },
      3,
      settled,
      attempts,
    );
    const out = await runBatch(g, { concurrency: 2, process });
    expect(out.completed).toEqual([1, 2]);
    expect(out.failed).toEqual([]);
    expect(attempts[1]).toBe(2); // flaked once, succeeded on the retry
    expect(attempts[2]).toBe(1);
  });

  test("terminal review-issues is NOT retried: cascades immediately", async () => {
    // #1 fails terminally (review-issues) on the first attempt; runWithRetry
    // returns it at once, the scheduler cascades #2/#3 as failed.
    const g = buildGraph([ticket(1), ticket(2, [1]), ticket(3, [2])]);
    const attempts: Record<number, number> = {};
    const process = retriableProcess(
      { 1: [{ status: "failed", reason: "review-issues" }] },
      3,
      undefined,
      attempts,
    );
    const out = await runBatch(g, { concurrency: 3, process });
    expect(out.failed).toEqual([1, 2, 3]);
    expect(attempts[1]).toBe(1); // terminal → no retry budget spent
  });

  test("transient budget exhausted: still cascades after maxRetries", async () => {
    // #1 keeps CI-failing; after maxRetries+1 attempts it's declared terminal
    // and cascades to #2. Proves retries don't suppress the eventual cascade.
    const g = buildGraph([ticket(1), ticket(2, [1])]);
    const attempts: Record<number, number> = {};
    const process = retriableProcess(
      { 1: [{ status: "failed", reason: "ci-failed" }] }, // always flakes
      2, // → up to 3 total attempts
      undefined,
      attempts,
    );
    const out = await runBatch(g, { concurrency: 2, process });
    expect(out.failed).toEqual([1, 2]);
    expect(attempts[1]).toBe(3); // 1 initial + 2 retries, then cascade
  });

  test("retried ticket emits ticket.end(done) once and NO cascade for it", async () => {
    // Event-trace check: a transient-then-success ticket settles done exactly
    // once (the flaky attempt is internal to runWithRetry, so the scheduler
    // emits one ticket.start/ticket.end(done) and zero ticket.cascade).
    const g = buildGraph([ticket(1)]);
    const sink = new RecordingSink();
    const process = retriableProcess(
      { 1: [{ status: "failed", reason: "rate-limited" }, { status: "done" }] },
      3,
    );
    await runBatch(g, { concurrency: 1, process, events: sink });
    const one = sink.of(1);
    expect(one.filter((e) => e.type === EVT.TICKET_START)).toHaveLength(1);
    expect(one.filter((e) => e.type === EVT.TICKET_END)).toHaveLength(1);
    expect(one.find((e) => e.type === EVT.TICKET_END)?.data?.status).toBe("done");
    expect(one.some((e) => e.type === EVT.TICKET_CASCADE)).toBe(false);
  });
});
