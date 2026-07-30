import type { Ticket } from "./types.ts";

/**
 * The dependency graph over a batch of tickets.
 *
 * Edges come from each ticket's `blockedBy`. A ticket is on the **frontier**
 * when every one of its blockers is satisfied. A blocker is satisfied when it
 * is `completed` (merged/done in this run), OR it is not part of this batch
 * (already closed before the run, or external) — the graph cannot wait on
 * tickets it wasn't asked to process. Under frontier relaxation (#29) an
 * in-flight blocker may also satisfy a dependent when the caller's
 * `canOverlap` policy permits it (see {@link frontier}).
 */
export interface Graph {
  byNumber: Map<number, Ticket>;
  /** reverse adjacency: a -> tickets that a blocks. */
  blocks: Map<number, Set<number>>;
}

export class CycleError extends Error {
  constructor(public readonly cycle: number[]) {
    super(`Dependency cycle among tickets: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
  }
}

export function buildGraph(tickets: Ticket[]): Graph {
  const byNumber = new Map<number, Ticket>();
  for (const t of tickets) byNumber.set(t.number, t);

  const blocks = new Map<number, Set<number>>();
  for (const t of tickets) blocks.set(t.number, new Set());
  for (const t of tickets) {
    for (const b of t.blockedBy) {
      if (byNumber.has(b)) {
        blocks.get(b)!.add(t.number);
      }
    }
  }

  // 0.2.0 feedback C1: symmetrise `coordinateWith` so a one-directional body
  // reference ("Coordinate with #464" on #466 only) still yields mutual
  // exclusion at scheduling time. Only in-batch peers are kept (out-of-batch
  // numbers are external/closed and can't conflict). The symmetrised set is
  // written back onto each ticket so the scheduler reads one normalised source.
  const coord = new Map<number, Set<number>>();
  for (const t of tickets) coord.set(t.number, new Set(t.coordinateWith ?? []));
  for (const t of tickets) {
    for (const peer of t.coordinateWith ?? []) {
      if (byNumber.has(peer) && peer !== t.number) coord.get(peer)!.add(t.number);
    }
  }
  for (const [n, peers] of coord) {
    const sorted = [...peers].sort((a, b) => a - b);
    byNumber.set(n, { ...byNumber.get(n)!, coordinateWith: sorted });
  }

  detectCycles(byNumber);
  return { byNumber, blocks };
}

/**
 * Resolve title-based "Blocked by" references to issue numbers within the
 * batch, merging them into each ticket's `blockedBy`.
 *
 * Two tiers: an exact (case-insensitive) title match wins first; the
 * normalized match (all non-alphanumerics stripped) is a fallback so dashes,
 * spacing, and minor punctuation can't defeat a reference. The exact pass
 * exists because `normKey` is aggressive — "Fix login bug" and "Fix-login-bug"
 * both collapse to "fixloginbug", so without it two same-prefix tickets would
 * cross-link via whichever entry survived the normalized map.
 *
 * Title refs that match nothing in the batch are left as out-of-batch
 * (satisfied) — they point at closed/external work.
 */
export function resolveTitleEdges(
  tickets: Ticket[],
  titleRefsByNumber: Map<number, string[]>,
): Ticket[] {
  const byExact = new Map<string, number>();
  const byNorm = new Map<string, number>();
  for (const t of tickets) {
    byExact.set(exactKey(t.title), t.number);
    byNorm.set(normKey(t.title), t.number);
  }
  return tickets.map((t) => {
    const refs = titleRefsByNumber.get(t.number) ?? [];
    const extra: number[] = [];
    for (const r of refs) {
      const hit = byExact.get(exactKey(r)) ?? byNorm.get(normKey(r));
      if (hit !== undefined && hit !== t.number) extra.push(hit);
    }
    if (extra.length === 0) return t;
    const merged = [...new Set([...t.blockedBy, ...extra])].sort((a, b) => a - b);
    return { ...t, blockedBy: merged };
  });
}

/** Exact-match key: lowercased + trimmed, structure (spaces/dashes) intact. */
function exactKey(s: string): string {
  return s.toLowerCase().trim();
}

/** Normalized key: lowercased with every run of non-alphanumerics removed. */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * #29: the single in-flight blocker `dep` may overlap, or `undefined` when
 * overlap is unsafe. Overlap composes a dependent onto ONE blocker's head and
 * later rebases onto that one blocker's merge — so it is only well-defined when
 * the dependent has EXACTLY one not-yet-completed blocker, that blocker is
 * genuinely in flight, and `canOverlap` admits it. With two or more in-flight
 * blockers (fan-in) the dependent could only branch from one head, leaving the
 * others uncompensated, so it returns `undefined` (strict).
 *
 * Shared by {@link frontier} (the ready decision) and the scheduler (the
 * LaunchInfo it hands to `process`) so the two never disagree on who overlapped
 * whom — the previous inline `find(first-in-flight)` at the launch site could
 * diverge from frontier's per-blocker check and pick a different blocker.
 */
export function overlapBlockerFor(
  dep: Ticket,
  graph: Graph,
  running: Set<number>,
  canOverlap?: (dep: Ticket, blocker: Ticket) => boolean,
): number | undefined {
  // Only real, in-flight, in-batch blockers can satisfy via overlap.
  const inflight = dep.blockedBy.filter((b) => running.has(b) && graph.byNumber.has(b));
  if (inflight.length !== 1) return undefined;
  const b = inflight[0]!;
  return canOverlap?.(dep, graph.byNumber.get(b)!) ? b : undefined;
}

/**
 * Tickets eligible to start now: not completed, not running, not failed, and
 * with every in-batch blocker completed — or, under frontier relaxation
 * (#29), with every blocker either completed or overlap-permitted while
 * still in flight.
 *
 * Out-of-batch blockers are treated as satisfied (they're closed/external).
 *
 * The frontier is ordered to minimize total run wall-time: a ticket that
 * unblocks more still-pending dependents launches first (fan-in), tie-broken
 * by the longest remaining downstream chain (critical-path depth). Issue
 * number ascending is the final, deterministic tie-break so equal-weight
 * tickets keep a stable, human-predictable order. The scheduler launches in
 * this order, so the same weighting drives real dispatch and `--dry-run`.
 */
export function frontier(
  graph: Graph,
  completed: Set<number>,
  running: Set<number>,
  failed: Set<number>,
  /** #29: frontier relaxation. Absent → strict frontier (current behaviour):
   *  a blocker satisfies a dependent only by being `completed` or out-of-batch.
   *  When provided, a dependent may additionally satisfy via ONE in-flight
   *  blocker admitted by `canOverlap` (see {@link overlapBlockerFor}). `inflight`
   *  lists overlap-launched dependents still in flight, excluded from the
   *  weighting `done` snapshot below so they keep counting toward their
   *  blocker's fan-in / critical-depth weight until it settles — otherwise
   *  launching a dependent early would silently shrink its blocker's priority
   *  and could reorder the remaining frontier. They're still excluded from
   *  `ready`, so they're never re-launched. */
  overlap?: {
    canOverlap?: (dep: Ticket, blocker: Ticket) => boolean;
    inflight?: Set<number>;
  },
): number[] {
  const ready: number[] = [];
  for (const t of graph.byNumber.values()) {
    if (completed.has(t.number)) continue;
    if (running.has(t.number)) continue;
    if (failed.has(t.number)) continue;
    // #29: overlap is admitted for at most ONE in-flight blocker — the single
    // head the dependent can branch from and later rebase onto. Fan-in with two
    // or more in-flight blockers stays strict (can't compose onto one head
    // without losing the others). overlapBlockerFor is shared with the scheduler
    // so the ready decision and the LaunchInfo never disagree.
    const overlapBlocker = overlap
      ? overlapBlockerFor(t, graph, running, overlap.canOverlap)
      : undefined;
    const satisfied = t.blockedBy.every((b) => {
      if (completed.has(b) || !graph.byNumber.has(b)) return true;
      if (!running.has(b)) return false;
      return b === overlapBlocker;
    });
    if (satisfied) ready.push(t.number);
  }

  // `running` already folds in skipped tickets (see the scheduler), so the
  // union below is exactly the set of tickets that are done or in flight —
  // i.e. no longer pending dependents a frontier ticket could unblock.
  const done = new Set<number>([...completed, ...running, ...failed]);
  // #29 (decision #4): an overlap-launched dependent is in `running` but must
  // still weigh as a pending dependent of its blocker (see `overlap.inflight`).
  if (overlap?.inflight) for (const n of overlap.inflight) done.delete(n);

  // Direct dependents of `n` that still need to run — the shared edge-walk
  // both weighting keys derive from.
  const pendingDependents = (n: number): number[] => {
    const out: number[] = [];
    for (const dep of graph.blocks.get(n) ?? []) if (!done.has(dep)) out.push(dep);
    return out;
  };

  // Longest chain of still-pending dependents below `n` (memoized for the
  // lifetime of this call, where `done` is a fixed snapshot).
  const depth = new Map<number, number>();
  const criticalDepth = (n: number): number => {
    const cached = depth.get(n);
    if (cached !== undefined) return cached;
    let max = 0;
    for (const dep of pendingDependents(n)) max = Math.max(max, 1 + criticalDepth(dep));
    depth.set(n, max);
    return max;
  };

  return ready.sort((a, b) => {
    const fanDelta = pendingDependents(b).length - pendingDependents(a).length;
    if (fanDelta !== 0) return fanDelta; // higher fan-in first
    const depthDelta = criticalDepth(b) - criticalDepth(a);
    if (depthDelta !== 0) return depthDelta; // deeper critical path first
    return a - b; // stable deterministic tie-break
  });
}

/**
 * Every ticket that can never become ready because it (transitively) depends
 * on a ticket in `seed` — a terminal blocker that won't produce a mergeable
 * result (failed or skipped). Computed as the closure of reverse-adjacency
 * (`blocks`) edges from the seed set. The driver assigns each of these the
 * seed's status in one pass so the run can't hang on a doomed branch.
 *
 * Pure over status: it only answers "which dependents are blocked by `seed`?",
 * leaving the caller to decide what to mark them.
 */
export function cascadeDependents(
  graph: Graph,
  completed: Set<number>,
  seed: Set<number>,
): number[] {
  const doomed = new Set<number>();
  const stack: number[] = [...seed];
  while (stack.length > 0) {
    const f = stack.pop()!;
    for (const blocked of graph.blocks.get(f) ?? new Set<number>()) {
      if (completed.has(blocked) || doomed.has(blocked)) continue;
      doomed.add(blocked);
      stack.push(blocked);
    }
  }
  return [...doomed].sort((a, b) => a - b);
}

/** Depth-first cycle detection over `blockedBy` edges, restricted to the batch. */
function detectCycles(byNumber: Map<number, Ticket>): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();
  for (const n of byNumber.keys()) color.set(n, WHITE);

  const visit = (u: number, path: number[]): void => {
    color.set(u, GRAY);
    path.push(u);
    const deps = byNumber.get(u)!.blockedBy.filter((b) => byNumber.has(b));
    for (const v of deps) {
      const c = color.get(v)!;
      if (c === GRAY) {
        // Found a back-edge: reconstruct the cycle from the path.
        const start = path.indexOf(v);
        const cycle = path.slice(start).concat(v);
        throw new CycleError(cycle);
      }
      if (c === WHITE) visit(v, path);
    }
    path.pop();
    color.set(u, BLACK);
  };

  for (const n of byNumber.keys()) {
    if (color.get(n) === WHITE) visit(n, []);
  }
}
