/**
 * Shared helpers for the gh/paseo e2e shims.
 *
 * Both shims are installed as standalone executables on a temp PATH, so they
 * must be self-contained at runtime — but they share the exact same I/O
 * helpers, default mutable-state shape, and a concurrency guard. Keeping those
 * in one module (sibling to gh.js/paseo.js) stops the three copies from
 * drifting. The harness installs this file alongside the two shim executables
 * so `import ... from "./util.ts"` resolves whether run from source or from
 * the temp bin.
 *
 * Typed (.ts) so the harness reader shares one typed view of the state shape;
 * the plain-JS shims import it too (bun transpiles .ts on import at runtime).
 *
 * Self-contained at runtime: Bun globals only.
 */

export interface ShimState {
  prCounter: number;
  /** PR numbers that gh pr merge recorded (assertion surface for "merged"). */
  merged: number[];
  /** prNumber -> head branch ("loop/<n>-<slug>"); proves a real PR was opened. */
  prHeads: Record<string, string>;
  /** prNumber -> ticket number, derived from the head branch, so per-ticket
   *  checks/merge behaviour can be keyed off the ticket without parsing argv. */
  prTickets: Record<string, number>;
  /** prNumber -> merge strategy flag gh received (proves --merge-strategy). */
  mergedStrategies: Record<string, string>;
  /** issue numbers gh issue close recorded (proves post-merge close). */
  closed: number[];
  /** Review verdict pointer (cumulative across the fix-loop's review rounds). */
  reviewIdx: Record<string, number>;
  /** ticket -> verdict text currently served stably by `paseo logs`. */
  currentVerdict: Record<string, string>;
  /** ticket -> bool: a primary-provider dispatch already emitted a 429, so the
   *  next (fallback) dispatch proceeds normally (drives the rate-limit loop). */
  rateLimitedHit: Record<string, boolean>;
  /** ticket -> nth `gh pr checks --watch` call this run (drives a per-ticket
   *  checks sequence so a transient-then-pass CI outcome is scriptable). */
  checksIdx: Record<string, number>;
  /** ticket -> bool: a `stuckChecksFirst` ticket has already burned its one
   *  stuck (timeout-killed) --watch, so the retry's --watch falls through to
   *  the normal scripted outcome. Latched BEFORE the stuck sleep because the
   *  timeout kill can't write it. */
  stuckHit: Record<string, boolean>;
  /** ticket -> provider string the paseo shim last received (proves
   *  --provider / --review-provider override wiring through real argv). */
  providers: Record<string, Record<string, string>>;
  /** Overlap-choreography release latch: while false, a held blocker's
   *  `pr checks --watch` blocks; a dependent's implement flips it true, so the
   *  blocker can only settle AFTER the dependent has overlap-launched and run
   *  its implement — removing the settle-before-launch race. */
  dependentLaunched: boolean;
}

/** The mutable per-run scratch the shims read/write via DAG_E2E_STATE.
 *  Every field has a default so a test that doesn't care about it gets sane
 *  behaviour (and the shape is defined ONCE — harness + gh + paseo share it). */
export const DEFAULT_STATE: ShimState = Object.freeze({
  prCounter: 1000,
  merged: [],
  prHeads: {},
  prTickets: {},
  mergedStrategies: {},
  closed: [],
  reviewIdx: {},
  currentVerdict: {},
  rateLimitedHit: {},
  checksIdx: {},
  stuckHit: {},
  providers: {},
  dependentLaunched: false,
});

/** Read+parse a JSON file, returning `fallback` on any error/missing/env-unset. */
export async function readJson<T>(p: string | undefined, fb: T): Promise<T> {
  if (!p) return fb;
  try {
    return JSON.parse(await Bun.file(p).text()) as T;
  } catch {
    return fb;
  }
}

/** Write `v` as pretty JSON to `p` (no-op if `p` is undefined). */
export async function writeJson(p: string | undefined, v: unknown): Promise<void> {
  if (p) await Bun.write(p, JSON.stringify(v, null, 2));
}

/** Merge `defaults` under the on-disk state so a field added after a state file
 *  was written still resolves (forwards-compat between shim revisions). */
export function withDefaults(state: Partial<ShimState>, defaults: ShimState = DEFAULT_STATE): ShimState {
  return { ...defaults, ...state };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Serialise a read-modify-write of the shared state file across the two shim
 * *processes* (gh + paseo run as concurrent real subprocesses under
 * concurrency > 1). Without this, two simultaneous `gh pr create` calls race:
 * both read prCounter=1000, both write 1001, and a PR number is lost.
 *
 * Exclusion is an atomic O_EXCL create of `<state>.lock` (the `wx` flag), with
 * a bounded spin so a crashed holder doesn't deadlock the test. The lock file
 * is removed in `finally`; a crash mid-write leaves it behind but the spin
 * reclaims it (the file just needs unlinking, which the next acquirer does).
 */
export async function withStateLock<T>(
  statePath: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!statePath) return fn(); // no state file → nothing to guard
  const { writeFile, unlink } = await import("node:fs/promises");
  const lock = `${statePath}.lock`;
  let acquired = false;
  for (let i = 0; i < 400; i++) {
    // 400 × 5ms = up to 2s of bounded waiting; plenty for a test's RMW.
    try {
      await writeFile(lock, "", { flag: "wx" });
      acquired = true;
      break;
    } catch {
      await sleep(5);
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await unlink(lock);
      } catch {
        /* a racing acquirer may have reclaimed+removed it — fine */
      }
    }
  }
}

/** Parse the ticket number out of a `loop/<n>-<slug>` head branch. Returns 0
 *  when it doesn't match (so callers can branch on "unknown"). */
export function ticketFromHead(head: string | undefined): number {
  const m = /^loop\/(\d+)-/.exec(head ?? "");
  return m ? parseInt(m[1]!, 10) : 0;
}
