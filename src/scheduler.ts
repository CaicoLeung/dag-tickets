import type { Graph } from "./graph.ts";
import { frontier, cascadeDependents } from "./graph.ts";
import type { SettleReason, Ticket, TicketStatus } from "./types.ts";
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

/** Terminal ticket sets — shared shape between {@link planCascade},
 *  {@link applyCascadePlan} and {@link runBatch}'s closed-over state, so the
 *  three never drift on the `completed/failed/skipped` triple. */
export interface TerminalSets {
  completed: Set<number>;
  failed: Set<number>;
  skipped: Set<number>;
}

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
  ctx: TerminalSets & {
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
 * The single source of the cascade-abort marker. Emitted on `onSettle`'s
 * `reason`, persisted on `TicketState.skipReason`, and stamped into the
 * `TICKET_CASCADE` / `TICKET_END` event data. Typed as {@link SettleReason}
 * here so the vocabulary is pinned at every site that consumes it.
 */
const CASCADE_ABORT: SettleReason = "cascade-abort";

/** Side-effect channels {@link applyCascadePlan} fires as it applies a plan. */
export interface CascadeHooks {
  onSettle?: (number: number, status: TicketStatus, reason?: SettleReason) => void;
  abort?: (number: number) => Promise<void>;
  events: EventSink;
}

/**
 * Apply a cascade {@link planCascade|plan}: MARK not-yet-started dependents
 * terminal (existing first-wins behaviour) and ABORT in-flight ones (#20).
 *
 * Exported (not a runBatch-internal closure) so the no-double-report machinery
 * is unit-testable directly: under the scheduler's strict frontier a doomed
 * dependent can never be genuinely in-flight, so {@link runBatch}'s own flow
 * never reaches the abort branch — its correctness is proven here, and it goes
 * live in prod once the frontier lets dependents overlap in-flight blockers
 * (#29). The settle (status mutation + onSettle) is recorded synchronously
 * BEFORE the dispatch kill is fired, so a run killed mid-cascade still persists
 * the doomed branch. The kill is fire-and-forget: its promise resolves into the
 * void because the record is already deleted from `inflight` (the delete IS the
 * no-double-report guard — the orphaned promise can't win a later race).
 *
 * @param plan from {@link planCascade}; applied in order so a transitive
 *   dependent's `from` (computed in the planner's local mirror) stays consistent.
 * @param sets mutable terminal sets; failed/skipped gain the doomed dependents.
 * @param inflight mutable in-flight map; aborted dependents are deleted (race guard).
 * @param startedAt mutable launch timestamps; aborted dependents' entries closed + removed.
 * @param hooks side-effect channels.
 */
export function applyCascadePlan(
  plan: CascadeAction[],
  sets: TerminalSets,
  inflight: Map<number, unknown>,
  startedAt: Map<number, number>,
  hooks: CascadeHooks,
): void {
  for (const a of plan) {
    if (a.kind === "abort") {
      // No kill hook (focused scheduler tests): leave the dependent in flight
      // to settle on its own — the pre-#20 behaviour.
      if (!hooks.abort) continue;
      if (!inflight.has(a.dep)) continue; // lost the race / already removed
      // Free the slot + exclude from the race set so the killed dispatch can't
      // double-settle. THIS delete is the #20 no-double-report guard.
      inflight.delete(a.dep);
      sets.skipped.add(a.dep);
      hooks.onSettle?.(a.dep, "skipped", CASCADE_ABORT);
      hooks.events.emit(EVT.TICKET_CASCADE, a.dep, {
        status: "skipped",
        from: a.from,
        reason: CASCADE_ABORT,
      });
      const started = startedAt.get(a.dep);
      hooks.events.emit(EVT.TICKET_END, a.dep, {
        status: "skipped",
        reason: CASCADE_ABORT,
        ...(started !== undefined ? { durationMs: Date.now() - started } : {}),
      });
      startedAt.delete(a.dep);
      // Kill without awaiting: the settle is already persisted, so a killed run
      // records it even if the kill is still in flight. Errors swallowed.
      void Promise.resolve(hooks.abort(a.dep)).catch(() => {});
    } else {
      const acc = a.status === "failed" ? sets.failed : sets.skipped;
      acc.add(a.dep);
      hooks.onSettle?.(a.dep, a.status);
      hooks.events.emit(EVT.TICKET_CASCADE, a.dep, { status: a.status, from: a.from });
    }
  }
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
    /** #29: frontier relaxation policy. When provided, a dependent `dep` may
     *  become ready while one of its blockers `blocker` is still in flight
     *  (rather than waiting for `completed`). Injected (not built internally)
     *  so the scheduler stays decoupled from ticket-kind / branch-state policy:
     *  the cli builds it from routing kinds + "blocker head pushed" signals.
     *  Absent → strict frontier (current behaviour). */
    canOverlap?: (dep: Ticket, blocker: Ticket) => boolean;
    /** Pre-seeded from resumed state. */
    seedCompleted?: Iterable<number>;
    seedFailed?: Iterable<number>;
    /** Pre-seeded from resumed state (skipped up-front, e.g. unknown kind). */
    seedSkipped?: Iterable<number>;
    /** Called as each ticket settles, for logging/state persistence. The
     *  optional `reason` carries a {@link SettleReason} marker for non-natural
     *  settles — currently `"cascade-abort"` when an in-flight dependent is
     *  killed by the cascade (#20), so a resumed run can distinguish it from an
     *  unknown-kind skip. */
    onSettle?: (number: number, status: TicketStatus, reason?: SettleReason) => void;
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
  // #29: dependents currently in flight that were launched while a blocker was
  // still in flight (overlap launches). Passed to frontier so weighting keeps
  // their blocker's fan-in / critical-depth weight until it settles; cleared on
  // settle + cascade-abort. The caller-owned `opts.canOverlap` gates who joins.
  const overlapInflight = new Set<number>();

  // Thin wrapper over the exported, unit-tested {@link applyCascadePlan}: plan
  // the cascade from `seed`, then apply it against this run's live state. The
  // planner is pure; the applier owns every side effect (set mutation, onSettle,
  // events, the dispatch kill) and is tested in isolation because runBatch's
  // strict frontier can't produce an in-flight doomed dependent (#29 changes that).
  const applyCascade = (status: CascadeStatus, seed: Set<number>): void => {
    const plan = planCascade(graph, seed, status, {
      completed,
      failed,
      skipped,
      inflight: new Set(inflight.keys()),
    });
    applyCascadePlan(plan, { completed, failed, skipped }, inflight, startedAt, {
      onSettle: opts.onSettle,
      abort: opts.abort,
      events,
    });
  };

  // A blocker that settled failed/skipped before this run still dooms its
  // not-yet-completed dependents — cascade at startup so a resumed run mirrors
  // in-run settlements (otherwise dependents of a seeded terminal blocker are
  // silently dropped).
  applyCascade("failed", failed);
  applyCascade("skipped", skipped);

  const launch = (n: number): void => {
    // #29: a launch counts as an overlap launch when one of its blockers is
    // still in flight — i.e. it became ready via `canOverlap`, not by
    // completion. Membership drives the weighting exclusion in `frontier`.
    const t = graph.byNumber.get(n);
    if (opts.canOverlap && t?.blockedBy.some((b) => inflight.has(b))) overlapInflight.add(n);
    startedAt.set(n, Date.now());
    events.emit(EVT.TICKET_START, n);
    const p = Promise.resolve(n)
      .then(opts.process)
      .then((status) => ({ number: n, status }))
      .catch(() => ({ number: n, status: "failed" as TicketStatus }));
    inflight.set(n, p);
  };

  for (;;) {
    // Launch greedily, recomputing the frontier after each launch. Without the
    // recompute, #29 overlap can't trigger: a dependent only becomes overlap-
    // ready once its blocker is in flight, which happens mid-pass — a single
    // pre-pass frontier call would miss it and leave the chain serial. Under
    // the strict frontier (no `canOverlap`) the recompute is a cheap no-op: a
    // just-launched blocker satisfies no dependent by completion, so the
    // recomputed `ready` is empty and the loop exits after one launch.
    while (inflight.size < opts.concurrency) {
      const ready = frontier(
        graph,
        completed,
        new Set([...inflight.keys(), ...skipped]),
        failed,
        opts.canOverlap,
        overlapInflight,
      );
      if (ready.length === 0) break;
      launch(ready[0]);
    }

    if (inflight.size === 0) break; // nothing running, nothing launchable → done

    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.number);
    overlapInflight.delete(settled.number);
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
    // #29: drop overlap-launched dependents that left the race this pass —
    // either settled naturally (above) or cascade-aborted (applyCascade deletes
    // from `inflight`). Once out of flight they weigh as terminal, not pending.
    for (const n of [...overlapInflight]) {
      if (!inflight.has(n)) overlapInflight.delete(n);
    }
  }

  return {
    completed: [...completed].sort((a, b) => a - b),
    failed: [...failed].sort((a, b) => a - b),
    skipped: [...skipped].sort((a, b) => a - b),
  };
}
