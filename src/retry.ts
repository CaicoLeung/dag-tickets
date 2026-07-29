/**
 * Batch retry with exponential backoff (issue #21).
 *
 * A ticket that fails for a *transient* reason (CI flake, momentary
 * rate-limit, merge race, a fetch that failed because the host was offline)
 * is retried with exponential backoff up to `--max-ticket-retries` additional
 * attempts before being declared terminal and cascading to its dependents.
 * A *terminal* failure (review still has issues after the fix-loop, the agent
 * produced no commits) is never retried — retrying the whole ticket won't
 * change the outcome, so it cascades immediately, exactly as before.
 *
 * Where this sits in the pipeline:
 *  - The scheduler ({@link runBatch}) stays pure: it launches a ticket, awaits
 *    a terminal status, and cascades on `failed`/`skipped`. It never sees the
 *    intermediate transient attempts — they're absorbed here, so a cascade only
 *    fires once the retry budget is genuinely exhausted.
 *  - The lifecycle ({@link processTicket}) processes one ticket exactly once
 *    and returns a {@link RetryableOutcome} (status + structured `reason`). It
 *    owns the transient/terminal *label*; this module owns the *policy* that
 *    decides which labels are worth retrying and how long to back off.
 *
 * Retry re-runs the *whole* ticket lifecycle (implement → review → PR → CI →
 * merge). Surgical resume (re-check just CI, re-run just the merge) is the job
 * of the cancel-semantics work this issue is blocked by; until then a fresh
 * attempt is correct — the adapter cleans the worktree/branch before each
 * step — and the orphaned PR from a failed attempt is left for a human.
 *
 * Backoff is AWS "full jitter": `delay = random() * min(cap, base * 2^(n-1))`.
 * Full jitter (over equal/exponential) spreads a fleet of simultaneously-failed
 * tickets so they don't stampede the provider on recovery. `random` and `sleep`
 * are injectable so the loop is deterministic under test.
 */
import type { FailureReason } from "./types.ts";
import { EVT } from "./events.ts";
import { NULL_SINK } from "./ports.ts";
import type { EventSink, Logger } from "./ports.ts";

/**
 * The transient failure reasons — the retry policy's source of truth. A reason
 * is retryable iff it appears here. Kept as a frozen Set (not a switch) so the
 * exhaustive test in retry.test.ts can assert it matches the transient labels
 * in the {@link FailureReason} union exactly: adding a new transient reason
 * without registering it here would silently make it terminal.
 */
export const TRANSIENT_REASONS: ReadonlySet<FailureReason> = Object.freeze(
  new Set<FailureReason>([
    "ci-failed",
    "rate-limited",
    "stale-base",
    "merge-race",
    "agent-timeout",
    "connection-error",
  ]),
);

/** True iff `reason` is a transient cause worth a backoff-and-retry. */
export function isTransient(reason: FailureReason | undefined): boolean {
  return reason !== undefined && TRANSIENT_REASONS.has(reason);
}

/**
 * Pure exponential cap (no jitter): `min(maxMs, baseMs * 2^(attempt-1))`.
 *
 * `attempt` is the 1-based number of the attempt that *just failed* — the
 * backoff is computed for the upcoming retry. Extracted and exported so the
 * growth curve is unit-testable independently of the loop's timing.
 */
export function computeBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const raw = baseMs * 2 ** (attempt - 1);
  return Math.min(maxMs, raw);
}

/** The shape a single attempt must return so the loop can classify it.
 *
 *  Defined here (not imported from lifecycle.ts) so this module has no runtime
 *  dependency on the lifecycle — `TicketOutcome` satisfies it structurally, and
 *  the unit tests pass a minimal stand-in. `reason` is optional: a bare
 *  `failed` with no reason is treated as terminal (we can't prove it's
 *  transient, so we don't burn retry budget on an unknown cause). */
export interface RetryableOutcome {
  status: "done" | "failed" | "skipped";
  reason?: FailureReason;
}

/**
 * The retry *policy*: the budget and its backoff curve. The three values
 * always travel together (a retry budget + the timing of its waits), so they
 * get one type — this is the "policy" the module doc says this module owns,
 * named separately from the injectable seams (sleep/random/events/log) in
 * {@link RetryOpts}. Built once at the cli and threaded to every call site
 * without re-spelling the trio.
 */
export interface RetryPolicy {
  /** Additional attempts after the first. 0 disables retry entirely. */
  maxRetries: number;
  /** Backoff base (delay for the first retry, pre-jitter). */
  baseDelayMs: number;
  /** Backoff cap (pre-jitter). */
  maxDelayMs: number;
}

export interface RetryOpts extends RetryPolicy {
  /** Injectable sleeper — tests resolve immediately and record the delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for full jitter. Default {@link Math.random}. */
  random?: () => number;
  /** Human channel — one `warn` per retry so an operator sees the backoff. */
  log?: Logger;
  /** Structured channel — one `ticket.retry` per retry for the post-mortem. */
  events?: EventSink;
  /** Scopes the emitted event + log line to this ticket. */
  ticketNumber?: number;
  /** Fires after every attempt (intermediate failures AND the final outcome)
   *  with the running 1-based count — the cli uses it to persist `attempts`
   *  between retries so a killed run records how far it got. */
  onAttempt?: (attempt: number, outcome: RetryableOutcome) => void | Promise<void>;
  /** Resume anchor (issue #21): the 1-based number of the next attempt to run.
   *  Defaults to 1 (a fresh ticket). A ticket killed mid-backoff is persisted
   *  `running` with the attempt count of the pass that just failed; on resume
   *  the cli passes `that count + 1` here so the loop's `attempt` numbering is
   *  cumulative across both runs. Because the budget check is `attempt >
   *  maxRetries`, a cumulative count means the configured cap is enforced
   *  across resume — a resumed ticket can't silently gain a fresh full budget. */
  startAttempt?: number;
}

/**
 * Run `run` with exponential backoff until it returns a non-retryable outcome.
 *
 * - `done` / `skipped` stop immediately (success / not-applicable).
 * - `failed` + terminal reason stops immediately (cascades).
 * - `failed` + transient reason backs off and retries, until `maxRetries`
 *   additional attempts are spent — the last transient failure is then returned
 *   as terminal (the caller cascades on it).
 *
 * Returns the final outcome with `attempts` (1-based total) attached.
 */
export async function runWithRetry<T extends RetryableOutcome>(
  run: (attempt: number) => Promise<T>,
  opts: RetryOpts,
): Promise<T & { attempts: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const events = opts.events ?? NULL_SINK;

  // startAttempt carries the cumulative count across a resume: the loop's
  // `attempt` starts at startAttempt (not 1), so numbering and the maxRetries
  // cap both span the original run + the resumed one.
  let attempt = (opts.startAttempt ?? 1) - 1;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    attempt++;
    const outcome = await run(attempt);
    await opts.onAttempt?.(attempt, outcome);

    const stop =
      outcome.status !== "failed" || // done / skipped — terminal-success
      !isTransient(outcome.reason) || // terminal failure — cascade
      attempt > opts.maxRetries; // transient but budget exhausted — cascade
    if (stop) return { ...outcome, attempts: attempt };

    // Transient + budget remaining → full-jitter backoff, then retry.
    const cap = computeBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs);
    const delayMs = Math.round(random() * cap);
    const nextAttempt = attempt + 1;
    events.emit(EVT.TICKET_RETRY, opts.ticketNumber, {
      attempt: nextAttempt,
      delayMs,
      reason: outcome.reason,
    });
    opts.log?.(
      "warn",
      `attempt ${attempt} failed (${outcome.reason}); retry ${nextAttempt}/${opts.maxRetries + 1} in ${delayMs}ms`,
      opts.ticketNumber,
    );
    await sleep(delayMs);
  }
}
