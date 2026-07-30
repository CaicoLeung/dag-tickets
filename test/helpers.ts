import { expect } from "bun:test";
import { buildGraph } from "../src/graph.ts";
import type { Graph } from "../src/graph.ts";
import type { FailureReason, Ticket } from "../src/types.ts";
import type { RetryableOutcome } from "../src/retry.ts";
import { OverlapCoordinator } from "../src/cli.ts";

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

/** Minimal {@link RetryableOutcome} builder for the retry + scheduler suites: a
 *  status plus an optional reason, without re-spelling the conditional spread at
 *  every call site (the two suites used to inline it independently). */
export function retryableOutcome(
  status: RetryableOutcome["status"],
  reason?: FailureReason,
): RetryableOutcome {
  return { status, ...(reason ? { reason } : {}) };
}

/**
 * The canonical fan-in fixture for frontier-ordering tests: #2 blocks five
 * dependents (#3–#7), #1 blocks none. Shared by the graph (unit: `frontier`)
 * and scheduler (integration: `runBatch`) suites so the two cannot drift apart
 * — a change to the fixture updates both coverage paths at once.
 */
export function fanInHeavyGraph(): Graph {
  return buildGraph([
    ticket(1),
    ticket(2),
    ticket(3, [2]),
    ticket(4, [2]),
    ticket(5, [2]),
    ticket(6, [2]),
    ticket(7, [2]),
  ]);
}

/** Flush the microtask queue so an async lifecycle reaches its next await
 *  (e.g. `waitForBlockers` registering a waiter) before an assertion reads it.
 *  Shared by the lifecycle and scheduler overlap suites so both agree on the
 *  flush primitive — previously each inlined `new Promise(r => setTimeout(r, 0))`
 *  (#31 review: duplicated microtask-flush idiom). */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Probe that `coord`'s createPr-gate on blocker `n` is STILL held after one
 *  microtask flush: a waiter registered now must NOT resolve (i.e. `n` is absent
 *  from the `awaitOne` short-circuit `settled` set). Collapses the duplicated
 *  `Promise.race([waitForBlockers, tick])` scaffold both overlap tests inlined
 *  to assert the #31 race guard (#31 review: duplicated "late-waiter hangs"
 *  probe). The positive counterpart (gate RELEASED) stays inline at its call
 *  site — it asserts the opposite and would need a different helper. */
export async function assertGateStillHeld(
  coord: OverlapCoordinator,
  n: number,
): Promise<void> {
  let resolved = false;
  await Promise.race([
    coord.waitForBlockers([n]).then(() => {
      resolved = true;
    }),
    tick(),
  ]);
  expect(resolved).toBe(false);
}
