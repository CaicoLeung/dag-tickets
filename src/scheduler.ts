import type { Graph } from "./graph.ts";
import { frontier, cascadeFailures } from "./graph.ts";
import type { TicketStatus } from "./types.ts";

export interface BatchResult {
  completed: number[];
  failed: number[];
  /** Tickets skipped up-front (unknown kind) — not retried. */
  skipped: number[];
}

/**
 * DAG-aware bounded concurrency pool.
 *
 * Repeatedly: take the frontier (open, unblocked, unclaimed tickets), launch
 * up to `concurrency` of them, wait for the next one to finish, record its
 * outcome, and recompute. A failed ticket cascades failure to its not-yet-
 * started dependents so the run can't hang on a doomed branch; dependents
 * already in flight are left to settle on their own.
 */
export async function runBatch(
  graph: Graph,
  opts: {
    concurrency: number;
    /** Process one ticket -> terminal status. */
    process: (number: number) => Promise<TicketStatus>;
    /** Pre-seeded from resumed state. */
    seedCompleted?: Iterable<number>;
    seedFailed?: Iterable<number>;
    /** Called as each ticket settles, for logging/state persistence. */
    onSettle?: (number: number, status: TicketStatus) => void;
  },
): Promise<BatchResult> {
  const completed = new Set<number>(opts.seedCompleted ?? []);
  const failed = new Set<number>(opts.seedFailed ?? []);
  // A blocker that failed before this run still dooms its not-yet-completed
  // dependents — cascade at startup so a resumed run mirrors in-run failures
  // (otherwise dependents of a seeded failure are silently dropped).
  for (const dep of cascadeFailures(graph, completed, failed)) failed.add(dep);
  const skipped = new Set<number>();
  const inflight = new Map<number, Promise<{ number: number; status: TicketStatus }>>();

  const launch = (n: number): void => {
    const p = Promise.resolve(n)
      .then(opts.process)
      .then((status) => ({ number: n, status }))
      .catch(() => ({ number: n, status: "failed" as TicketStatus }));
    inflight.set(n, p);
  };

  for (;;) {
    // Skipped tickets are terminal but sit in none of completed/failed; without
    // excluding them here, frontier re-offers them every pass → infinite relaunch.
    const ready = frontier(graph, completed, new Set([...inflight.keys(), ...skipped]), failed);
    while (inflight.size < opts.concurrency && ready.length > 0) {
      launch(ready.shift()!);
    }

    if (inflight.size === 0) break; // nothing running, nothing launchable → done

    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.number);

    if (settled.status === "skipped") {
      skipped.add(settled.number);
    } else if (settled.status === "done") {
      completed.add(settled.number);
    } else {
      // failed — cascade to not-yet-started dependents only.
      failed.add(settled.number);
      for (const dep of cascadeFailures(graph, completed, failed)) {
        if (!inflight.has(dep)) failed.add(dep);
      }
    }
    opts.onSettle?.(settled.number, settled.status);
  }

  return {
    completed: [...completed].sort((a, b) => a - b),
    failed: [...failed].sort((a, b) => a - b),
    skipped: [...skipped].sort((a, b) => a - b),
  };
}
