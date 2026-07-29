import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVT,
  eventsPath,
  JsonlEventLog,
  type EventEnvelope,
} from "../src/events.ts";
import { NULL_SINK, type Logger } from "../src/ports.ts";

/** A fresh temp cwd per test so each run's events.jsonl is isolated. */
async function tmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dt-events-"));
}

/** Parse the JSONL file back into typed envelopes. */
async function readEvents(cwd: string, runId: string): Promise<EventEnvelope[]> {
  const text = await Bun.file(join(cwd, eventsPath(runId))).text();
  const out: EventEnvelope[] = [];
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as EventEnvelope);
    } catch {
      /* skip malformed — mirrors maxSeqInFile */
    }
  }
  return out;
}

/**
 * Poll events.jsonl until at least `count` lines land (bounded). Used to
 * assert the #41 contract — per-step visibility WITHOUT an explicit flush():
 * the write stream auto-drains each line to disk, so a reader tailing mid-run
 * sees it. Bounded so a regression that re-batches writes to run-end fails
 * fast instead of hanging.
 */
async function pollEvents(
  cwd: string,
  runId: string,
  count: number,
  timeoutMs = 1000,
): Promise<EventEnvelope[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lines: EventEnvelope[] = [];
    try {
      lines = await readEvents(cwd, runId);
    } catch {
      /* file not created yet — the first write has not landed */
    }
    if (lines.length >= count) return lines;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${count} events in ${runId}; saw ${lines.length}`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("eventsPath", () => {
  test("lives next to state.json under the run scratch dir", () => {
    expect(eventsPath("frontier-2026")).toBe(".scratch/dag-tickets/frontier-2026/events.jsonl");
  });
});

describe("NULL_SINK", () => {
  test("emit is a no-op that never throws", () => {
    expect(() => NULL_SINK.emit("anything", 1, { x: 1 })).not.toThrow();
  });
});

describe("JsonlEventLog — append, not overwrite", () => {
  test("two emits produce two lines (resume/overlap extend one file)", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("run-a", cwd);
    await log.ensure();
    log.emit(EVT.RUN_START, undefined, { n: 1 });
    log.emit(EVT.RUN_END, undefined, { n: 2 });
    await log.flush();
    const lines = await readEvents(cwd, "run-a");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.type).toBe(EVT.RUN_START);
    expect(lines[1]!.type).toBe(EVT.RUN_END);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("JsonlEventLog — envelope stamping", () => {
  test("runId/ts/seq auto-stamped; ticket+data omitted when absent", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("run-b", cwd);
    await log.ensure();
    log.emit(EVT.RUN_START, undefined, { target: "frontier" });
    await log.flush();
    const [e] = await readEvents(cwd, "run-b");
    expect(e).toBeDefined();
    const ev = e!;
    expect(ev.runId).toBe("run-b");
    expect(ev.seq).toBe(0);
    expect(ev.type).toBe(EVT.RUN_START);
    expect(ev.ticket).toBeUndefined();
    expect(ev.data).toEqual({ target: "frontier" });
    expect(typeof ev.ts).toBe("string");
    expect(Number.isFinite(Date.parse(ev.ts))).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  test("seq is monotonic across emits and ticket is included when given", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("run-c", cwd);
    await log.ensure();
    log.emit(EVT.TICKET_START, 7);
    log.emit(EVT.TICKET_END, 7, { status: "done", durationMs: 12 });
    await log.flush();
    const [a, b] = await readEvents(cwd, "run-c");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.seq).toBe(0);
    expect(b!.seq).toBe(1);
    expect(a!.ticket).toBe(7);
    expect(b!.ticket).toBe(7);
    expect(b!.data).toEqual({ status: "done", durationMs: 12 });
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("JsonlEventLog — self-healing directory", () => {
  test("emit before ensure() still records the line (mkdir on first append)", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("run-d", cwd);
    // Intentionally skip ensure().
    log.emit(EVT.TICKET_START, 1);
    await log.flush();
    const lines = await readEvents(cwd, "run-d");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe(EVT.TICKET_START);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("JsonlEventLog — per-emit durability (issue #41)", () => {
  test("each emit reaches disk without an explicit flush (per-step visibility, #41)", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("run-perstep", cwd);
    await log.ensure();
    // Emits with NO flush() afterwards. The write stream auto-drains each line
    // to disk, so a reader tailing mid-run — a dashboard, scheduler, or resume
    // check — must already see every line. This is the structured-monitoring
    // contract from issue #41: per-step events must not wait until run end.
    log.emit(EVT.RUN_START, undefined, { target: "frontier" });
    log.emit(EVT.TICKET_START, 7);
    log.emit(EVT.STEP_START, 7, { step: "implement" });
    log.emit(EVT.STEP_END, 7, { step: "implement", durationMs: 5 });
    log.emit(EVT.MERGE, 7, { strategy: "squash", ok: true });
    // Poll (no flush) — under a design that batches writes to run-end this times out.
    const lines = await pollEvents(cwd, "run-perstep", 5);
    expect(lines.map((l) => l.type)).toEqual([
      EVT.RUN_START,
      EVT.TICKET_START,
      EVT.STEP_START,
      EVT.STEP_END,
      EVT.MERGE,
    ]);
    // Order holds even without an explicit drain.
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
    await rm(cwd, { recursive: true, force: true });
  });

  test("run.start alone is visible without a later flush", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("run-firstline", cwd);
    await log.ensure();
    log.emit(EVT.RUN_START, undefined, { target: "frontier" });
    // No flush, no further emits. The reporter's symptom was seeing ONLY
    // run.start; the fix guarantees even a single emit reaches disk via the
    // auto-flushing stream, so the very first line is visible at once.
    const [first] = await pollEvents(cwd, "run-firstline", 1);
    expect(first?.type).toBe(EVT.RUN_START);
    await rm(cwd, { recursive: true, force: true });
  });

});

describe("JsonlEventLog — order coherence", () => {
  test("a rapid burst is serialized in emit order, not append-completion order", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("run-e", cwd);
    await log.ensure();
    for (let i = 0; i < 50; i++) log.emit(EVT.TICKET_START, i);
    await log.flush();
    const lines = await readEvents(cwd, "run-e");
    expect(lines).toHaveLength(50);
    // seq must equal emit order — the promise chain guarantees this.
    expect(lines.map((l) => l.seq)).toEqual([...Array(50).keys()]);
    expect(lines.map((l) => l.ticket)).toEqual([...Array(50).keys()]);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("JsonlEventLog — seq continues across resume", () => {
  test("a fresh JsonlEventLog on an existing file seeds seq past its max", async () => {
    const cwd = await tmpCwd();
    const first = new JsonlEventLog("resume-run", cwd);
    await first.ensure();
    first.emit(EVT.RUN_START, undefined, {});
    first.emit(EVT.TICKET_START, 1);
    await first.flush();
    expect((await readEvents(cwd, "resume-run")).map((e) => e.seq)).toEqual([0, 1]);

    // New process, same run dir/file: seq must CONTINUE (not reset to 0), so the
    // shared append-only file stays monotonic for any replay tool keying on seq.
    const resumed = new JsonlEventLog("resume-run", cwd);
    await resumed.ensure();
    resumed.emit(EVT.TICKET_END, 1, { status: "done" });
    await resumed.flush();

    const after = await readEvents(cwd, "resume-run");
    expect(after).toHaveLength(3);
    expect(after[2]!.seq).toBe(2);
    expect(after.map((e) => e.seq)).toEqual([0, 1, 2]);
    await rm(cwd, { recursive: true, force: true });
  });

  test("a missing prior file seeds seq 0 (fresh run, not an error)", async () => {
    const cwd = await tmpCwd();
    const log = new JsonlEventLog("fresh-run", cwd);
    await log.ensure();
    log.emit(EVT.RUN_START, undefined, {});
    await log.flush();
    const [e] = await readEvents(cwd, "fresh-run");
    expect(e!.seq).toBe(0);
    await rm(cwd, { recursive: true, force: true });
  });

  test("a malformed line is ignored when seeding seq (partially-flushed write)", async () => {
    const cwd = await tmpCwd();
    const first = new JsonlEventLog("trunc-run", cwd);
    await first.ensure();
    first.emit(EVT.RUN_START, undefined, {}); // seq 0, valid
    await first.flush();
    // Simulate a corrupted-but-line-bounded entry (a partially-flushed write
    // that still terminated the line). maxSeqInFile must skip it, not crash.
    await appendFile(join(cwd, eventsPath("trunc-run")), '{"ts":"x","runId":"trunc-run","seq":99,"type":"ru');
    await appendFile(join(cwd, eventsPath("trunc-run")), "\n");
    const resumed = new JsonlEventLog("trunc-run", cwd);
    await resumed.ensure();
    resumed.emit(EVT.RUN_END, undefined, {});
    await resumed.flush();
    const after = await readEvents(cwd, "trunc-run");
    // Malformed line skipped by the reader; valid prefix max seq (0) seeds next at 1.
    expect(after).toHaveLength(2);
    expect(after[1]!.seq).toBe(1);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("JsonlEventLog — write-failure surfacing", () => {
  test("the first persistent write failure warns once via the logger (not per emit)", async () => {
    // Make the target parent a regular file so mkdir + append both fail.
    const blocker = join(tmpdir(), `dt-block-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await appendFile(blocker, "x");
    const warned: Array<[string, string]> = [];
    const log: Logger = (level, msg) => warned.push([level, msg]);
    const el = new JsonlEventLog("run-f", blocker, log);
    el.emit(EVT.RUN_START, undefined, {});
    el.emit(EVT.RUN_END, undefined, {});
    await el.flush();
    // Never breaks the run, and surfaces exactly one warn across two failed emits.
    const warns = warned.filter(([lvl]) => lvl === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]![1]).toContain("event log write failed");
    await rm(blocker, { recursive: true, force: true });
  });
});
