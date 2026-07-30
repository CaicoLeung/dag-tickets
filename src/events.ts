/**
 * Structured event log for dag-tickets runs.
 *
 * Each run appends a JSONL event stream at
 * `.scratch/dag-tickets/<run-id>/events.jsonl` — ticket start/end, provider
 * switches, per-step durations, settle status, and cascade transitions — so a
 * long unattended batch has a machine-readable post-mortem alongside the human
 * stderr lines. The human logger ({@link Logger}) is unchanged; events are a
 * strictly additive second channel.
 *
 * Design:
 *  - {@link EventSink} is the domain seam — a shared channel like {@link Logger},
 *    not a port split. It is DEFINED in ports.ts (beside Logger); the lifecycle,
 *    scheduler, and agent adapter emit through it. This module holds only the
 *    file-backed adapter ({@link JsonlEventLog}); tests pass {@link NULL_SINK}
 *    (also from ports.ts) or the {@link RecordingSink} fake exported below.
 *  - Writes are promise-serialized in emit order and mkdir-safe. Graceful
 *    termination (throw / exit / SIGTERM) is covered by a try/finally `flush()`
 *    at the call site, so the on-disk trace is complete and in-order. A hard
 *    kill (SIGKILL) can drop staged-but-unflushed lines and truncate the
 *    in-flight one; the surviving prefix stays ordered because appends are
 *    line-atomic and serialized.
 *  - runId / ts / seq are auto-stamped; callers supply only the discriminating
 *    `type`, an optional ticket number, and optional structured `data`.
 *
 * See docs/agents (issue #19) for the canonical event vocabulary.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventSink, Logger } from "./ports.ts";
import { resolveUnder } from "./paths.ts";

/** Where a run's event stream lives. Sibling of `state.json`. */
export function eventsPath(runId: string): string {
  return `.scratch/dag-tickets/${runId}/events.jsonl`;
}

/** 0.2.0 feedback A1: where a run's per-step agent output logs live. Sibling
 *  directory of `events.jsonl` / `state.json` (`<runId>/logs/`). Each dispatch
 *  writes `<n>-<step>.log` here. */
export function logsPath(runId: string): string {
  return `.scratch/dag-tickets/${runId}/logs`;
}

/**
 * Canonical event names. Using the constants (not bare strings) keeps the
 * post-mortem vocabulary grep-able and typo-proof across the three emitters.
 */
export const EVT = {
  RUN_START: "run.start",
  RUN_END: "run.end",
  /** 0.3.0 feedback D3: emitted by the signal/crash exit path (RunExit) before
   *  the final flush, so a consumer of events.jsonl sees a bounded trace on
   *  interrupt instead of an unbounded "in flight" tail. Distinct from RUN_END
   *  (which marks clean completion) so a reader can tell an interrupted run
   *  from a finished one. */
  RUN_INTERRUPTED: "run.interrupted",
  TICKET_START: "ticket.start",
  TICKET_END: "ticket.end",
  TICKET_CASCADE: "ticket.cascade",
  TICKET_RETRY: "ticket.retry",
  PROVIDER_SWITCH: "provider.switch",
  STEP_START: "step.start",
  STEP_END: "step.end",
  PR_CREATED: "pr.created",
  CI_RESULT: "ci.result",
  MERGE: "merge",
  TICKET_RECONCILE: "ticket.reconcile",
} as const;

/**
 * One line in the JSONL stream. `data` is the type-specific payload; every
 * other field is envelope. `seq` is monotonic within a run AND continues across
 * resume: `ensure()` scans any pre-existing file and seeds `seq` past its max,
 * so a resumed run appends with strictly increasing seq (no duplicates in one
 * file). `ts` and the resume runId are the secondary ordering/disambiguation.
 */
export interface EventEnvelope {
  ts: string;
  runId: string;
  seq: number;
  type: string;
  /** Present when the event is scoped to a ticket. */
  ticket?: number;
  /** Type-specific payload. */
  data?: Record<string, unknown>;
}

/**
 * Append-only JSONL event log.
 *
 * Append (never overwrite) so resume and concurrent ticket pipelines both
 * extend one coherent file. `ensure()` pre-creates the directory; `emit()` is
 * also self-healing (mkdir on first append) so an emit before `ensure()` — e.g.
 * a provider switch during setup — is still recorded.
 */
export class JsonlEventLog implements EventSink {
  private seq = 0;
  private readonly full: string;
  private chain: Promise<void> = Promise.resolve();
  private ensured = false;
  private writeFailed = false;

  /**
   * @param log Optional human logger. A persistently failing event log would
   *    otherwise die silently; the first write failure surfaces one `warn`
   *    here (consistent with the shared-Logger seam) so an operator notices the
   *    post-mortem channel is broken.
   */
  constructor(
    private readonly runId: string,
    cwd?: string,
    private readonly log?: Logger,
  ) {
    this.full = resolveUnder(eventsPath(runId), cwd);
  }

  /**
   * Create the parent directory once and seed `seq` past any pre-existing
   * file's max, so a resumed run (same file) keeps seq strictly increasing.
   * Safe to call multiple times. The cli always awaits this before the first
   * emit, so resume-seq continuity holds for real runs.
   */
  async ensure(): Promise<void> {
    if (this.ensured) return;
    await mkdir(dirname(this.full), { recursive: true });
    this.seq = await this.maxSeqInFile();
    this.ensured = true;
  }

  /**
   * Best-effort scan of an existing file's `seq` values; returns max+1 (or 0
   * when the file is missing/empty/all-malformed). Missing file → 0 (fresh
   * run); a truncated tail line is ignored, not fatal.
   */
  private async maxSeqInFile(): Promise<number> {
    let prev: string;
    try {
      prev = await readFile(this.full, "utf8");
    } catch {
      return 0; // no prior file — fresh run starts at 0
    }
    let max = -1;
    for (const raw of prev.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as { seq?: unknown };
        if (typeof e.seq === "number" && e.seq > max) max = e.seq;
      } catch {
        /* malformed line — ignore (resilient to a truncated tail) */
      }
    }
    return max + 1;
  }

  emit(type: string, ticket: number | undefined, data?: Record<string, unknown>): void {
    const e: EventEnvelope = {
      ts: new Date().toISOString(),
      runId: this.runId,
      seq: this.seq++,
      type,
      ...(ticket !== undefined ? { ticket } : {}),
      ...(data ? { data } : {}),
    };
    const line = JSON.stringify(e) + "\n";
    // Serialize appends in emit order; mkdir on first write keeps emit
    // self-sufficient even if ensure() was skipped or raced.
    this.chain = this.chain
      .then(async () => {
        if (!this.ensured) {
          try {
            await mkdir(dirname(this.full), { recursive: true });
            this.ensured = true;
          } catch {
            /* directory creation is best-effort; append will surface real errors */
          }
        }
        await appendFile(this.full, line, "utf8");
      })
      .catch((e) => {
        // A failed write must never break the run — the stderr log still
        // carries it. Surface the first failure once via the human logger so
        // an operator notices the post-mortem channel is broken.
        if (!this.writeFailed) {
          this.writeFailed = true;
          this.log?.(
            "warn",
            `event log write failed (${this.full}): ${(e as Error).message}; events.jsonl may be incomplete`,
          );
        }
      });
  }

  /**
   * Resolve every staged append. Tests use this to observe a coherent file;
   * the cli wraps the run in try/finally `flush()` so graceful termination
   * (throw / exit / SIGTERM) still leaves a complete, ordered trace.
   */
  async flush(): Promise<void> {
    await this.chain;
  }
}

/**
 * Capturing fake for tests: records every emitted envelope in order. Exported
 * here (beside the seam's other test affordances) so the event-asserting test
 * files share one definition instead of drifting copies. {@link types} and
 * {@link of} cover the two convenience shapes the copies had grown.
 */
export class RecordingSink implements EventSink {
  readonly events: Array<{ type: string; ticket?: number; data?: Record<string, unknown> }> = [];
  emit(type: string, ticket: number | undefined, data?: Record<string, unknown>): void {
    this.events.push({ type, ticket, data });
  }
  /** Event types in emit order — convenient for ordering assertions. */
  types(): string[] {
    return this.events.map((e) => e.type);
  }
  /** Events scoped to one ticket — convenient for per-ticket assertions. */
  of(n: number): Array<{ type: string; ticket?: number; data?: Record<string, unknown> }> {
    return this.events.filter((e) => e.ticket === n);
  }
}
