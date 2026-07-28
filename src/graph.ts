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
  /** #29: frontier relaxation. When provided, an in-flight (present in
   *  `running`) blocker `blocker` may satisfy a dependent `dep` without being
   *  `completed`. Absent (or returning `false`) → strict frontier: a blocker
   *  satisfies only by being `completed` or out-of-batch (current behaviour).
   *  The policy is caller-owned (the scheduler builds it from ticket kinds +
   *  branch state) so `frontier` stays pure and unit-testable. */
  canOverlap?: (dep: Ticket, blocker: Ticket) => boolean,
): number[] {
  const ready: number[] = [];
  for (const t of graph.byNumber.values()) {
    if (completed.has(t.number)) continue;
    if (running.has(t.number)) continue;
    if (failed.has(t.number)) continue;
    const satisfied = t.blockedBy.every((b) => {
      if (completed.has(b) || !graph.byNumber.has(b)) return true;
      // #29: a real, not-yet-completed blocker can still satisfy this dependent
      // if it is genuinely in flight and the caller's overlap policy allows it.
      // `running` is the caller's in-flight set; a skipped blocker folded into
      // it never reaches here because its dependents are cascade-skipped first.
      if (!running.has(b)) return false;
      return canOverlap?.(t, graph.byNumber.get(b)!) ?? false;
    });
    if (satisfied) ready.push(t.number);
  }

  // `running` already folds in skipped tickets (see the scheduler), so the
  // union below is exactly the set of tickets that are done or in flight —
  // i.e. no longer pending dependents a frontier ticket could unblock.
  const done = new Set<number>([...completed, ...running, ...failed]);

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
