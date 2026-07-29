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
 *  - Each emit writes its line through an append-mode write stream that
 *    auto-flushes (issue #41): `stream.write()` hands the line to libuv and
 *    returns at once — it does NOT block the JS event loop — so a reader
 *    tailing the file mid-run (a dashboard, scheduler, or resume check) sees
 *    every step/ticket event as it happens, not only at run end. A single
 *    writer serializes lines in emit order, so burst-ordering and resume-seq
 *    hold without a promise chain. `flush()` drains pending writes so a
 *    graceful exit (the cli's try/finally + signal-exit wiring) leaves a
 *    complete trace; it is not an fsync — a hard kill or power loss could
 *    still lose buffered / unwritten data, an acceptable trade for an
 *    infrequent post-mortem channel.
 *  - runId / ts / seq are auto-stamped; callers supply only the discriminating
 *    `type`, an optional ticket number, and optional structured `data`.
 *
 * See docs/agents (issue #19) for the canonical event vocabulary.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventSink, Logger } from "./ports.ts";

/** Where a run's event stream lives. Sibling of `state.json`. */
export function eventsPath(runId: string): string {
  return `.scratch/dag-tickets/${runId}/events.jsonl`;
}

/**
 * Canonical event names. Using the constants (not bare strings) keeps the
 * post-mortem vocabulary grep-able and typo-proof across the three emitters.
 */
export const EVT = {
  RUN_START: "run.start",
  RUN_END: "run.end",
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
  private ensured = false;
  private writeFailed = false;
  /** Lazy append-mode stream; opened on first emit. */
  private stream: WriteStream | null = null;
  /** Resolves once every write issued so far has flushed to the OS. */
  private drained: Promise<void> = Promise.resolve();

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
    const rel = eventsPath(runId);
    this.full = cwd ? `${cwd.replace(/\/$/, "")}/${rel}` : rel;
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
    // #41: per-step visibility WITHOUT blocking the event loop. write() hands
    // the line to libuv and returns at once; the stream auto-flushes each line
    // to disk, so a reader tailing mid-run (a dashboard, scheduler, or resume
    // check) sees it without a run-end flush. The write callback resolves
    // when the line reaches the OS, so flush() can await it. mkdir on first
    // write keeps emit self-sufficient even if ensure() was skipped or raced.
    try {
      if (!this.ensured) {
        mkdirSync(dirname(this.full), { recursive: true });
        this.ensured = true;
      }
      const s = this.openIfNeeded();
      const written = new Promise<void>((resolve, reject) => {
        s.write(line, "utf8", (err) => (err ? reject(err) : resolve()));
      });
      // Chain so flush() awaits all writes in emit order; a rejected write
      // must not break the chain for later writes (each surfaces its own
      // failure once via surface()).
      this.drained = this.drained.then(() => written, () => written);
      this.drained.catch(() => {
        /* rejection surfaced per-write via the stream 'error' handler */
      });
    } catch (err) {
      this.surface(err as Error);
    }
  }

  /**
   * Lazy-open the append stream. Open / async write errors arrive on the
   * 'error' event (not via throw); surface the first once via the logger.
   */
  private openIfNeeded(): WriteStream {
    if (this.stream) return this.stream;
    const s = createWriteStream(this.full, { flags: "a", encoding: "utf8" });
    s.on("error", (err) => this.surface(err));
    this.stream = s;
    return s;
  }

  /**
   * Surface the first persistent write failure once via the human logger (not
   * per emit) — a failed write must never break the run; the stderr log still
   * carries the line, and the operator gets one `warn` that the post-mortem
   * channel is broken.
   */
  private surface(err: Error): void {
    if (this.writeFailed) return;
    this.writeFailed = true;
    this.log?.(
      "warn",
      `event log write failed (${this.full}): ${err.message}; events.jsonl may be incomplete`,
    );
  }

  /**
   * Drain every write issued so far to the OS. The stream auto-flushes each
   * line as it is written, so flush() is only needed to observe a coherent
   * file (tests) or to leave a complete trace on graceful exit — the cli's
   * try/finally and the signal-exit wiring both await it.
   */
  async flush(): Promise<void> {
    await this.drained;
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
