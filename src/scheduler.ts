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

/** Terminal status a cascade propagates from a settled blocker. */
export type CascadeStatus = "failed" | "skipped";

/**
 * One cascade decision for a doomed dependent, produced by {@link planCascade}
 * and applied by {@link runBatch}. Splitting the pure decision from its side
 * effects (onSettle / events / dispatch kill) lets the in-flight-abort path
 * (#20) be unit-tested directly: under the scheduler's strict frontier a
 * dependent can only be in-flight once *all* its blockers are `completed`, so a
 * failing blocker can never have a genuinely in-flight dependent — the abort
 * branch is forward-compat for when dependents can overlap blockers, and the
 * pure planner is the surface that proves it correct.
 */
export interface CascadeAction {
  dep: number;
  /**
   * - `"mark"`: dependent hasn't started → record `status` terminal.
   * - `"abort"`: dependent is in-flight → kill its dispatch, free its
   *   concurrency slot, and record it cascade-skipped (#20).
   */
  kind: "mark" | "abort";
  /**
   * Status to persist. `"mark"` → the blocker's status (a not-started
   * dependent inherits the failure mode it would have hit). `"abort"` →
   * `"skipped"`: the dependent was preempted mid-work, so it never settled on
   * its own merits — `skipped` is the honest record, distinct from `failed`.
   */
  status: CascadeStatus | "skipped";
  /** Terminal blockers that doomed this dependent — for the post-mortem trace. */
  from: number[];
}

/**
 * Pure cascade planner: for every dependent transitively doomed by `seed`
 * (terminal-blocker status `status`), decide whether to MARK it terminal
 * (not-yet-started) or ABORT it (in-flight). Pure over the input sets —
 * {@link runBatch} owns the side effects (status mutation, onSettle, events,
 * the dispatch kill). First-wins: a dependent already terminal
 * (completed/failed/skipped) is never re-decided.
 */
export function planCascade(
  graph: Graph,
  seed: Set<number>,
  status: CascadeStatus,
  ctx: {
    completed: Set<number>;
    failed: Set<number>;
    skipped: Set<number>;
    /** Tickets with a live dispatch promise — candidates for abort. */
    inflight: Set<number>;
  },
): CascadeAction[] {
  const out: CascadeAction[] = [];
  // Local mirror of the terminal sets as they'll stand once this cascade
  // applies, updated per dependent. A transitive dependent's `from` must include
  // a blocker cascaded earlier in THIS pass (2 fails → 3's from is [2]), which
  // only holds if each dep is recorded before the next one's `from` is read.
  // Mirroring locally keeps the planner pure (it never mutates the caller's sets).
  const fail = new Set(ctx.failed);
  const skip = new Set(ctx.skipped);
  const terminal = (n: number) => ctx.completed.has(n) || fail.has(n) || skip.has(n);
  for (const dep of cascadeDependents(graph, ctx.completed, seed)) {
    // first-wins: an already-terminal dependent keeps its status (whichever
    // blocker settled first cascaded first). This also covers a dependent
    // aborted earlier this run — it's now in `skip`, so a second failing
    // blocker can't re-abort it.
    if (terminal(dep)) continue;
    const from = (graph.byNumber.get(dep)?.blockedBy ?? []).filter(
      (b) => fail.has(b) || skip.has(b),
    );
    if (ctx.inflight.has(dep)) {
      out.push({ dep, kind: "abort", status: "skipped", from });
      skip.add(dep); // an aborted dependent settles cascade-skipped
    } else {
      out.push({ dep, kind: "mark", status, from });
      (status === "failed" ? fail : skip).add(dep);
    }
  }
  return out;
}

/**
 * DAG-aware bounded concurrency pool.
 *
 * Repeatedly: take the frontier (open, unblocked, unclaimed tickets), launch
 * up to `concurrency` of them, wait for the next one to finish, record its
 * outcome, and recompute. A ticket that settles `failed` or `skipped` cascades
 * that status to its not-yet-started dependents so the run can't hang on a
 * doomed branch. In-flight dependents — when an `abort` hook is wired — are
 * killed outright (dispatch stopped, worktree cleaned, recorded
 * cascade-skipped) instead of burning a full implement→review→fix→CI cycle on a
 * guaranteed-broken result (#20); without a hook they're left to settle on
 * their own (the pre-#20 behaviour).
 */
export async function runBatch(
  graph: Graph,
  opts: {
    concurrency: number;
    /** Process one ticket -> terminal status. */
    process: (number: number) => Promise<TicketStatus>;
    /**
     * Abort an in-flight ticket: stop its agent dispatch and clean its
     * worktree. Called only for a running dependent of a settled
     * failed/skipped blocker (#20). Must be safe to call on a ticket whose
     * dispatch already finished (lost race) and must not throw — the scheduler
     * records the dependent cascade-skipped regardless of what the aborted
     * promise later resolves to. Optional: when absent, in-flight dependents
     * are left to settle on their own so focused scheduler tests that don't
     * model a real kill stay green.
     */
    abort?: (number: number) => Promise<void>;
    /** Pre-seeded from resumed state. */
    seedCompleted?: Iterable<number>;
    seedFailed?: Iterable<number>;
    /** Pre-seeded from resumed state (skipped up-front, e.g. unknown kind). */
    seedSkipped?: Iterable<number>;
    /** Called as each ticket settles, for logging/state persistence. The
     *  optional `reason` carries a marker for non-natural settles — currently
     *  `"cascade-abort"` when an in-flight dependent is killed by the cascade
     *  (#20), so a resumed run can distinguish it from an unknown-kind skip. */
    onSettle?: (number: number, status: TicketStatus, reason?: string) => void;
    /** Machine-readable event channel (issue #19). Optional so the many
     *  scheduler tests that don't assert events can omit it; resolved to
     *  NULL_SINK once at the top of runBatch (no per-site `?.`). */
    events?: EventSink;
  },
): Promise<BatchResult> {
  const completed = new Set<number>(opts.seedCompleted ?? []);
  const failed = new Set<number>(opts.seedFailed ?? []);
  const skipped = new Set<number>(opts.seedSkipped ?? []);
  // In-flight tickets keyed by number → their dispatch promise. Deleting a
  // record is the #20 double-report guard: an aborted dependent is removed from
  // this map the instant it's recorded cascade-skipped, so its later natural
  // resolution can never win `Promise.race` and re-enter the settle path. (No
  // `aborted` flag is needed — the delete IS the protection; see the abort
  // branch in applyCascade.)
  const inflight = new Map<number, Promise<{ number: number; status: TicketStatus }>>();
  // Resolve once: the event channel is optional on opts (most scheduler tests
  // omit it) but guaranteed from here on — no per-site `?.` below.
  const events = opts.events ?? NULL_SINK;
  // Launch timestamps, read by both the settle path and the abort path to
  // stamp durationMs. Declared before applyCascade so the abort closure never
  // races the temporal-dead-zone of a later `const`.
  const startedAt = new Map<number, number>();

  // Apply a cascade plan: MARK not-yet-started dependents terminal (existing
  // first-wins behaviour) and ABORT in-flight ones (#20). The settle (status
  // mutation + onSettle) is recorded synchronously BEFORE the dispatch kill is
  // fired, so a run killed mid-cascade still persists the doomed branch without
  // waiting for resume to self-heal it. The kill itself is fire-and-forget:
  // its promise resolves into the void (the record is already deleted from
  // `inflight`, so it never re-enters the settle path → no double-report).
  const applyCascade = (status: CascadeStatus, seed: Set<number>): void => {
    const plan = planCascade(graph, seed, status, {
      completed,
      failed,
      skipped,
      inflight: new Set(inflight.keys()),
    });
    for (const a of plan) {
      if (a.kind === "abort") {
        // No kill hook (focused scheduler tests): leave the dependent in flight
        // to settle on its own — the pre-#20 behaviour. Status stays unset; the
        // promise's natural resolution drives the settle.
        if (!opts.abort) continue;
        if (!inflight.has(a.dep)) continue; // lost the race / already removed
        // Free the slot + exclude from the race set so the killed dispatch
        // can't double-settle. THIS delete is the #20 no-double-report guard:
        // the orphaned promise resolves into the void (it can't win the race).
        inflight.delete(a.dep);
        // cascade-skipped: the dependent never ran to an outcome of its own, so
        // 'skipped' (not the blocker's status) is the honest record. `reason`
        // persists to state so a resumed run can tell a cascade-abort apart from
        // an unknown-kind skip.
        skipped.add(a.dep);
        opts.onSettle?.(a.dep, "skipped", "cascade-abort");
        events.emit(EVT.TICKET_CASCADE, a.dep, {
          status: "skipped",
          from: a.from,
          reason: "cascade-abort",
        });
        const started = startedAt.get(a.dep);
        // Close the start↔end pair at the abort decision (the effective
        // lifecycle ended here); the underlying process cleanup is an
        // implementation detail of the kill below.
        events.emit(EVT.TICKET_END, a.dep, {
          status: "skipped",
          reason: "cascade-abort",
          ...(started !== undefined ? { durationMs: Date.now() - started } : {}),
        });
        startedAt.delete(a.dep);
        // Kill the dispatch + clean the worktree without awaiting: the settle
        // is already persisted, so a killed run records it even if the kill is
        // still in flight. Errors are swallowed — the dependent is terminal here.
        void Promise.resolve(opts.abort(a.dep)).catch(() => {});
      } else {
        // not-yet-started dependent: inherit the blocker's status (existing).
        const acc = a.status === "failed" ? failed : skipped;
        acc.add(a.dep);
        opts.onSettle?.(a.dep, a.status);
        events.emit(EVT.TICKET_CASCADE, a.dep, { status: a.status, from: a.from });
      }
    }
  };

  // A blocker that settled failed/skipped before this run still dooms its
  // not-yet-completed dependents — cascade at startup so a resumed run mirrors
  // in-run settlements (otherwise dependents of a seeded terminal blocker are
  // silently dropped).
  applyCascade("failed", failed);
  applyCascade("skipped", skipped);

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
    // An aborted ticket was already removed from `inflight` by applyCascade, so
    // it can never be the one that won this race — no guard needed here. The
    // `inflight.delete` inside applyCascade IS the no-double-report mechanism.

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
    startedAt.delete(settled.number);
    // Persist cascaded dependents after the root cause, so a killed run records
    // the doomed branch without waiting for resume to self-heal it.
    if (settled.status === "failed") applyCascade("failed", failed);
    else if (settled.status === "skipped") applyCascade("skipped", skipped);
  }

  return {
    completed: [...completed].sort((a, b) => a - b),
    failed: [...failed].sort((a, b) => a - b),
    skipped: [...skipped].sort((a, b) => a - b),
  };
}
