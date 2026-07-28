import type { Ticket } from "./types.ts";

/**
 * The dependency graph over a batch of tickets.
 *
 * Edges come from each ticket's `blockedBy`. A ticket is on the **frontier**
 * when every one of its blockers is satisfied. A blocker is satisfied when it
 * is `completed` (merged/done in this run) OR it is not part of this batch
 * (already closed before the run, or external) — the graph cannot wait on
 * tickets it wasn't asked to process.
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
 * batch, merging them into each ticket's `blockedBy`. Normalization strips all
 * non-alphanumerics so dashes, spacing, and case can't defeat a match.
 *
 * Title refs that match nothing in the batch are left as out-of-batch
 * (satisfied) — they point at closed/external work.
 */
export function resolveTitleEdges(
  tickets: Ticket[],
  titleRefsByNumber: Map<number, string[]>,
): Ticket[] {
  const byNorm = new Map<string, number>();
  for (const t of tickets) byNorm.set(normKey(t.title), t.number);
  return tickets.map((t) => {
    const refs = titleRefsByNumber.get(t.number) ?? [];
    const extra: number[] = [];
    for (const r of refs) {
      const hit = byNorm.get(normKey(r));
      if (hit !== undefined && hit !== t.number) extra.push(hit);
    }
    if (extra.length === 0) return t;
    const merged = [...new Set([...t.blockedBy, ...extra])].sort((a, b) => a - b);
    return { ...t, blockedBy: merged };
  });
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Tickets eligible to start now: not completed, not running, not failed, and
 * with every in-batch blocker completed.
 *
 * Out-of-batch blockers are treated as satisfied (they're closed/external).
 */
export function frontier(
  graph: Graph,
  completed: Set<number>,
  running: Set<number>,
  failed: Set<number>,
): number[] {
  const ready: number[] = [];
  for (const t of graph.byNumber.values()) {
    if (completed.has(t.number)) continue;
    if (running.has(t.number)) continue;
    if (failed.has(t.number)) continue;
    const satisfied = t.blockedBy.every((b) => completed.has(b) || !graph.byNumber.has(b));
    if (satisfied) ready.push(t.number);
  }
  return ready.sort((a, b) => a - b);
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
