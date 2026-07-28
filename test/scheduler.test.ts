import { test, expect, describe } from "bun:test";
import { runBatch } from "../src/scheduler.ts";
import { buildGraph } from "../src/graph.ts";
import type { Ticket, TicketStatus } from "../src/types.ts";

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
