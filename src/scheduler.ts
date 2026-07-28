import type { Graph } from "./graph.ts";
import { frontier, cascadeDependents } from "./graph.ts";
import type { TicketStatus } from "./types.ts";
import { EVT } from "./events.ts";
import type { EventSink } from "./ports.ts";
import { NULL_SINK } from "./ports.ts";

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
 * outcome, and recompute. A ticket that settles `failed` or `skipped` cascades
 * that status to its not-yet-started dependents so the run can't hang on a
 * doomed branch; dependents already in flight are left to settle on their own.
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
    /** Pre-seeded from resumed state (skipped up-front, e.g. unknown kind). */
    seedSkipped?: Iterable<number>;
    /** Called as each ticket settles, for logging/state persistence. */
    onSettle?: (number: number, status: TicketStatus) => void;
    /** Machine-readable event channel (issue #19). Optional so the many
     *  scheduler tests that don't assert events can omit it; resolved to
     *  NULL_SINK once at the top of runBatch (no per-site `?.`). */
    events?: EventSink;
  },
): Promise<BatchResult> {
  const completed = new Set<number>(opts.seedCompleted ?? []);
  const failed = new Set<number>(opts.seedFailed ?? []);
  const skipped = new Set<number>(opts.seedSkipped ?? []);
  const inflight = new Map<number, Promise<{ number: number; status: TicketStatus }>>();
  // Resolve once: the event channel is optional on opts (most scheduler tests
  // omit it) but guaranteed from here on — no per-site `?.` below.
  const events = opts.events ?? NULL_SINK;

  // Cascade a terminal-blocker status (failed | skipped) from every settled
  // ticket of that status to its not-yet-started dependents, persisting each
  // cascaded dependent via onSettle so a killed run records it immediately
  // rather than recovering only on the next resume. In-flight dependents are
  // left to settle on their own; a dependent already terminal (completed /
  // failed / skipped) keeps its status — the first cascade to reach it wins.
  // Within a run that is genuinely first-wins (whichever blocker settles
  // first cascades first); on a resumed run the startup passes below are
  // ordered failed-then-skipped, so a ticket doomed by both settles `failed`.
  // Neither status breaks the run, and there is no double-report.
  const cascade = (status: "failed" | "skipped", seed: Set<number>): void => {
    const acc = status === "failed" ? failed : skipped;
    for (const dep of cascadeDependents(graph, completed, seed)) {
      if (inflight.has(dep) || completed.has(dep) || failed.has(dep) || skipped.has(dep)) continue;
      acc.add(dep);
      opts.onSettle?.(dep, status);
      // Record which terminal blocker(s) doomed this dependent so the post-
      // mortem trace links the cascade to its root cause.
      const from = (graph.byNumber.get(dep)?.blockedBy ?? []).filter(
        (b) => failed.has(b) || skipped.has(b),
      );
      events.emit(EVT.TICKET_CASCADE, dep, { status, from });
    }
  };

  // A blocker that settled failed/skipped before this run still dooms its
  // not-yet-completed dependents — cascade at startup so a resumed run mirrors
  // in-run settlements (otherwise dependents of a seeded terminal blocker are
  // silently dropped).
  cascade("failed", failed);
  cascade("skipped", skipped);

  const startedAt = new Map<number, number>();
  const launch = (n: number): void => {
    startedAt.set(n, Date.now());
    events.emit(EVT.TICKET_START, n);
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
    }
    opts.onSettle?.(settled.number, settled.status);
    const endData: Record<string, unknown> = { status: settled.status };
    const started = startedAt.get(settled.number);
    if (started !== undefined) endData.durationMs = Date.now() - started;
    events.emit(EVT.TICKET_END, settled.number, endData);
    // Persist cascaded dependents after the root cause, so a killed run records
    // the doomed branch without waiting for resume to self-heal it.
    if (settled.status === "failed") cascade("failed", failed);
    else if (settled.status === "skipped") cascade("skipped", skipped);
  }

  return {
    completed: [...completed].sort((a, b) => a - b),
    failed: [...failed].sort((a, b) => a - b),
    skipped: [...skipped].sort((a, b) => a - b),
  };
}
