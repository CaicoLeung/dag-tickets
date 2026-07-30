import { test, expect } from "bun:test";
import { parseArgs, stopInFlightAgents, RunExit, routeActionable, listRuns, gc } from "../src/cli.ts";
import type { Logger } from "../src/ports.ts";

test("--version / -V set the version flag", () => {
  expect(parseArgs(["--version"]).version).toBe(true);
  expect(parseArgs(["-V"]).version).toBe(true);
});

test("version flag defaults to false", () => {
  expect(parseArgs([]).version).toBe(false);
  expect(parseArgs(["--frontier"]).version).toBe(false);
});

test("unknown argument still throws regardless of version flag", () => {
  expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
});

// 0.3.0 review follow-up (Spec #2 edge): --thinking is typed + validated at the
// edge so an unknown id fails loudly (A1's whole point) instead of being
// forwarded to `paseo run --thinking <bogus>` and rejected late or silently
// downgrading reasoning.
test("--thinking accepts a recognised level", () => {
  for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    expect(parseArgs(["--thinking", lvl]).thinking).toBe(lvl);
  }
});

test("--thinking rejects an unknown id loudly", () => {
  expect(() => parseArgs(["--thinking", "bogus"])).toThrow(/--thinking must be one of/);
  expect(() => parseArgs(["--thinking", "maxim"])).toThrow(/--thinking must be one of/); // typo, not max
});

test("--thinking defaults to undefined (paseo's provider default applies)", () => {
  expect(parseArgs([]).thinking).toBeUndefined();
});

test("--fallback-provider accepts a single provider", () => {
  expect(parseArgs(["--fallback-provider", "claude/sonnet"]).fallbackProviders).toEqual([
    "claude/sonnet",
  ]);
});

test("--fallback-provider splits comma-separated list", () => {
  expect(
    parseArgs(["--fallback-provider", "claude/sonnet, omp/zai/glm-5.2"]).fallbackProviders,
  ).toEqual(["claude/sonnet", "omp/zai/glm-5.2"]);
});

test("--fallback-provider is repeatable and accumulates", () => {
  expect(
    parseArgs([
      "--fallback-provider",
      "claude/sonnet",
      "--fallback-provider",
      "omp/zai/glm-5.2",
    ]).fallbackProviders,
  ).toEqual(["claude/sonnet", "omp/zai/glm-5.2"]);
});

test("fallbackProviders defaults to empty", () => {
  expect(parseArgs([]).fallbackProviders).toEqual([]);
});

// --category-label / --skip-label (ADR-0001): add to the orphan-detection /
// intentional-skip sets. Same shape as --fallback-provider (comma-split, trim,
// repeatable) but defaults to empty here — the defaults live in
// DEFAULT_ROUTING and are merged at buildRouting() time.

test("--category-label accepts a single role", () => {
  expect(parseArgs(["--category-label", "bug"]).categoryLabels).toEqual(["bug"]);
});

test("--category-label splits a comma-separated list and trims whitespace", () => {
  expect(parseArgs(["--category-label", "bug, enhancement , type-bug"]).categoryLabels).toEqual([
    "bug",
    "enhancement",
    "type-bug",
  ]);
});

test("--category-label is repeatable and accumulates across flags", () => {
  expect(
    parseArgs(["--category-label", "bug", "--category-label", "enhancement,flaw"]).categoryLabels,
  ).toEqual(["bug", "enhancement", "flaw"]);
});

test("--category-label filters empty segments (trailing/leading/double commas)", () => {
  expect(parseArgs(["--category-label", ",bug,,enhancement,"]).categoryLabels).toEqual([
    "bug",
    "enhancement",
  ]);
});

test("--skip-label mirrors --category-label: single, comma-split, repeatable", () => {
  expect(parseArgs(["--skip-label", "needs-info"]).skipLabels).toEqual(["needs-info"]);
  expect(parseArgs(["--skip-label", "needs-info, wontfix"]).skipLabels).toEqual([
    "needs-info",
    "wontfix",
  ]);
  expect(
    parseArgs(["--skip-label", "needs-info", "--skip-label", "wontfix,blocked"]).skipLabels,
  ).toEqual(["needs-info", "wontfix", "blocked"]);
});

test("--category-label=value and --skip-label=value forms are accepted (= splicing)", () => {
  expect(parseArgs(["--category-label=bug,enhancement"]).categoryLabels).toEqual([
    "bug",
    "enhancement",
  ]);
  expect(parseArgs(["--skip-label=wontfix"]).skipLabels).toEqual(["wontfix"]);
});

test("categoryLabels / skipLabels default to empty", () => {
  expect(parseArgs([]).categoryLabels).toEqual([]);
  expect(parseArgs([]).skipLabels).toEqual([]);
});

// --max-ticket-retries (issue #21): transient whole-ticket retry budget.
test("--max-ticket-retries sets the transient retry budget", () => {
  expect(parseArgs(["--max-ticket-retries", "5"]).maxTicketRetries).toBe(5);
});

test("--max-ticket-retries 0 disables retry", () => {
  expect(parseArgs(["--max-ticket-retries", "0"]).maxTicketRetries).toBe(0);
});

test("--max-ticket-retries ignores non-positive / non-numeric and keeps the default", () => {
  // num() rejects <=0 and NaN, so the default (2) is retained — no crash.
  expect(parseArgs(["--max-ticket-retries", "abc"]).maxTicketRetries).toBe(2);
  expect(parseArgs(["--max-ticket-retries", "-1"]).maxTicketRetries).toBe(2);
});

test("--max-ticket-retries defaults to 2", () => {
  expect(parseArgs([]).maxTicketRetries).toBe(2);
});

test("--max-ticket-retries=value form is accepted (= splicing)", () => {
  expect(parseArgs(["--max-ticket-retries=4"]).maxTicketRetries).toBe(4);
});

// --ci-watch-timeout-minutes: ceiling on `gh pr checks --watch` so a stuck
// check can't starve a concurrency slot. Becomes a transient ci-failed on
// timeout (retried with backoff). 0 disables the bound.
test("--ci-watch-timeout-minutes defaults to 30", () => {
  expect(parseArgs([]).ciWatchTimeoutMinutes).toBe(30);
});

test("--ci-watch-timeout-minutes sets the ceiling", () => {
  expect(parseArgs(["--ci-watch-timeout-minutes", "60"]).ciWatchTimeoutMinutes).toBe(60);
});

test("--ci-watch-timeout-minutes 0 disables the bound (no ceiling)", () => {
  // 0 is valid (indefinite watch) — distinct from --concurrency's num() which
  // rejects non-positive values.
  expect(parseArgs(["--ci-watch-timeout-minutes", "0"]).ciWatchTimeoutMinutes).toBe(0);
});

test("--ci-watch-timeout-minutes ignores non-numeric / negative, keeps default", () => {
  expect(parseArgs(["--ci-watch-timeout-minutes", "abc"]).ciWatchTimeoutMinutes).toBe(30);
  expect(parseArgs(["--ci-watch-timeout-minutes", "-5"]).ciWatchTimeoutMinutes).toBe(30);
});

test("--ci-watch-timeout-minutes=value form is accepted (= splicing)", () => {
  expect(parseArgs(["--ci-watch-timeout-minutes=45"]).ciWatchTimeoutMinutes).toBe(45);
});

// ---------------------------------------------------------------------------
// #40 — stopInFlightAgents: exit-cleanup helper. Pins the guard + swallow
// contract so a regression that removes the guard (or the try/catch) fails CI
// instead of silently swallowing a TypeError on a fake AgentPort that doesn't
// implement the optional stopInFlight.
// ---------------------------------------------------------------------------

test("stopInFlightAgents is a no-op when no agent is wired (dry-run / pre-dispatch)", async () => {
  // A missing agent must be a clean no-op, not a swallowed TypeError — the
  // honest reading of AgentPort.stopInFlight's optional contract.
  await expect(stopInFlightAgents(undefined, [11])).resolves.toBeUndefined();
});

test("stopInFlightAgents honours stopInFlight's optional contract — absent method is a no-op", async () => {
  // A fake AgentPort that doesn't implement stopInFlight must not crash (the
  // pre-#40 behaviour the optional contract promises). Without the guard this
  // would be a silently-swallowed TypeError.
  const agent: { stopInFlight?(n: Iterable<number>): Promise<void> } = {};
  await expect(stopInFlightAgents(agent, [11])).resolves.toBeUndefined();
});

test("stopInFlightAgents calls stopInFlight with the live ticket set when present", async () => {
  const stopped: number[][] = [];
  const agent = {
    stopInFlight: async (n: Iterable<number>) => {
      stopped.push([...n]);
    },
  };
  await stopInFlightAgents(agent, new Set([11, 12]));
  expect(stopped).toEqual([[11, 12]]);
});

test("stopInFlightAgents swallows a throwing stopInFlight — never throws", async () => {
  // A per-run stop failure must not block the exit/cleanup that follows.
  const agent = {
    stopInFlight: async () => {
      throw new Error("paseo stop exploded");
    },
  };
  await expect(stopInFlightAgents(agent, [11])).resolves.toBeUndefined();
});

// Note: empty-set handling lives in PaseoAgent.stopInFlight (covered in
// paseo.test.ts), not here — the helper's job is guard + swallow, and it
// correctly delegates stopInFlight([]) whenever the method exists.

// ---------------------------------------------------------------------------
// #40 — RunExit: the exit-path coordinator. Pins "every catchable exit calls
// cleanup (stop → flush → release) and exits with the right code" so a
// regression that drops a handler registration, a cleanup step, or the detach
// fails here instead of orphaning agents in an unattended run. process.exit is
// injected as a recorder so the test process isn't terminated.
// ---------------------------------------------------------------------------

const SILENT_LOG: Logger = () => {};

/** Fakes that record cleanup-step order + the exit code, without touching the
 *  real process. `releaseThrowing` flips release to throw (resilience test). */
function fakeDeps(releaseThrowing = false) {
  const calls: string[] = [];
  const exits: number[] = [];
  return {
    calls,
    exits,
    deps: {
      stop: async () => {
        calls.push("stop");
      },
      flush: async () => {
        calls.push("flush");
      },
      release: async () => {
        calls.push("release");
        if (releaseThrowing) throw new Error("release boom");
      },
      log: SILENT_LOG,
      exit: (code: number) => {
        exits.push(code);
      },
    },
  };
}

/** Drain the async cleanExit chain (stop/flush/release are microtasks; exit fires
 *  in .finally). One macrotask is enough: every step before exit() is a
 *  microtask, and microtasks drain before setTimeout fires. */
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

test("RunExit SIGINT runs stop→flush→release in order then exits 130", async () => {
  const { calls, exits, deps } = fakeDeps();
  new RunExit(deps).onSignal("SIGINT");
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]); // order is load-bearing
  expect(exits).toEqual([130]); // 128 + 2
});

test("RunExit SIGTERM exits 143", async () => {
  const { exits, deps } = fakeDeps();
  new RunExit(deps).onSignal("SIGTERM");
  await settled();
  expect(exits).toEqual([143]); // 128 + 15
});

test("RunExit uncaughtException runs full cleanup then exits 1", async () => {
  const { calls, exits, deps } = fakeDeps();
  new RunExit(deps).onUncaught();
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]);
  expect(exits).toEqual([1]);
});

test("RunExit unhandledRejection exits 1 with full cleanup", async () => {
  const { calls, exits, deps } = fakeDeps();
  new RunExit(deps).onRejection();
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]);
  expect(exits).toEqual([1]);
});

test("RunExit still exits when release throws — cleanup must not block exit", async () => {
  // A failing lock release must not swallow the exit. The outer .catch eats the
  // rejection; .finally still fires exit().
  const { calls, exits, deps } = fakeDeps(true);
  new RunExit(deps).onUncaught();
  await settled();
  expect(calls).toEqual(["stop", "flush", "release"]); // release was attempted
  expect(exits).toEqual([1]); // exit still happened
});

test("RunExit.register adds all 4 listeners and detach removes them", () => {
  const g = new RunExit(fakeDeps().deps);
  const evs = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;
  const before = evs.map((e) => process.listenerCount(e));
  try {
    g.register();
    const added = evs.map((e, i) => process.listenerCount(e) - before[i]!);
    expect(added).toEqual([1, 1, 1, 1]); // exactly one handler per exit path
  } finally {
    g.detach();
  }
  const after = evs.map((e, i) => process.listenerCount(e) - before[i]!);
  expect(after).toEqual([0, 0, 0, 0]); // detach restored baseline
});

// 0.3.0 feedback D3 — RunExit emits a terminal run.interrupted event before the
// flush so an interrupted run leaves a bounded trace (a terminal marker after
// the last step.*), not an unbounded "in flight" tail.
test("RunExit SIGINT runs stop→emitInterrupt→flush→release when emitInterrupt is wired", async () => {
  const calls: string[] = [];
  const exits: number[] = [];
  const deps = {
    stop: async () => {
      calls.push("stop");
    },
    emitInterrupt: () => {
      calls.push("emitInterrupt");
    },
    flush: async () => {
      calls.push("flush");
    },
    release: async () => {
      calls.push("release");
    },
    log: SILENT_LOG,
    exit: (code: number) => {
      exits.push(code);
    },
  };
  new RunExit(deps).onSignal("SIGINT");
  await settled();
  // emitInterrupt fires AFTER stop (agents gone) and BEFORE flush (lands in trace).
  expect(calls).toEqual(["stop", "emitInterrupt", "flush", "release"]);
  expect(exits).toEqual([130]);
});

test("RunExit emitInterrupt throwing is swallowed — exit still fires", async () => {
  // A failing event emit must not block the flush/release/exit that follows.
  const calls: string[] = [];
  const exits: number[] = [];
  const deps = {
    stop: async () => {
      calls.push("stop");
    },
    emitInterrupt: () => {
      calls.push("emitInterrupt");
      throw new Error("emit boom");
    },
    flush: async () => {
      calls.push("flush");
    },
    release: async () => {
      calls.push("release");
    },
    log: SILENT_LOG,
    exit: (code: number) => {
      exits.push(code);
    },
  };
  new RunExit(deps).onUncaught();
  await settled();
  expect(calls).toEqual(["stop", "emitInterrupt", "flush", "release"]); // all attempted
  expect(exits).toEqual([1]); // exit still happened
});

// 0.2.0 feedback B1 — explicit CLI numbers bypass the routing label gate.
import type { Ticket } from "../src/types.ts";
const t = (n: number, kind: Ticket["kind"]): Ticket => ({
  number: n,
  title: `T${n}`,
  url: "",
  body: "",
  labels: [],
  state: "open",
  blockedBy: [],
  kind,
});

test("routeActionable: a frontier run drops unknown-kind tickets", () => {
  const out = routeActionable([t(1, "implement"), t(2, "unknown"), t(3, "skip")], false);
  expect(out.map((x) => x.number)).toEqual([1]);
});

test("routeActionable: an explicit-number run promotes unknown → implement (warn, don't skip)", () => {
  const out = routeActionable([t(1, "implement"), t(2, "unknown"), t(3, "skip")], true);
  expect(out.map((x) => x.number)).toEqual([1, 2]);
  expect(out[1]?.kind).toBe("implement"); // promoted
});

test("routeActionable: explicit never promotes an intentional skip", () => {
  const out = routeActionable([t(1, "skip"), t(2, "unknown")], true);
  expect(out.map((x) => x.number)).toEqual([2]);
});

test("parseArgs: --preflight (A2) + auto-merge default off (C2)", () => {
  expect(parseArgs(["--preflight"]).preflight).toBe(true);
  expect(parseArgs([]).preflight).toBe(false);
  // C2: auto-merge is opt-in now — bare autoMerge flag is false until --auto-merge.
  expect(parseArgs([]).autoMerge).toBe(false);
  expect(parseArgs(["--auto-merge"]).autoMerge).toBe(true);
  expect(parseArgs(["--no-auto-merge"]).noAutoMerge).toBe(true);
});

test("parseArgs: D2/D3 subcommands (gc / --ls-runs / --force / --no-merged-check)", () => {
  expect(parseArgs(["--ls-runs"]).lsRuns).toBe(true);
  expect(parseArgs(["gc"]).gc).toBe(true);
  expect(parseArgs(["gc", "--force"]).gcForce).toBe(true);
  expect(parseArgs(["--no-merged-check"]).noMergedCheck).toBe(true);
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback D2/D3 — listRuns reads .scratch run state; gc removes stale
// dag-* worktrees. Hermetic: a temp scratch dir for listRuns, a temp git repo
// with a linked dag-12 worktree for gc.
// ---------------------------------------------------------------------------
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/shell.ts";

test("listRuns (D2): summarises prior run state files, skips unreadable ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "dag-ls-"));
  const cwd = root; // scratchDir(cwd) = root/.scratch/dag-tickets
  const state = (tickets: object) => ({
    runId: "r",
    target: "frontier",
    startedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    tickets,
  });
  await mkdir(join(cwd, ".scratch/dag-tickets/run-a"), { recursive: true });
  await writeFile(
    join(cwd, ".scratch/dag-tickets/run-a/state.json"),
    JSON.stringify(state({ "1": { status: "done" }, "2": { status: "failed" } })),
  );
  // a run dir with no state.json (killed before first settle) — must be skipped
  await mkdir(join(cwd, ".scratch/dag-tickets/run-b"), { recursive: true });

  const code = await listRuns(cwd);
  expect(code).toBe(0);
});

test("listRuns (D2): empty/missing scratch dir reports no runs, exit 0", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dag-ls-empty-"));
  expect(await listRuns(cwd)).toBe(0);
});

test("gc (D3): removes stale dag-* linked worktrees", async () => {
  const GENV = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const mainRepo = await mkdtemp(join(tmpdir(), "dag-gc-main-"));
  const g = (args: string[]) => run(["git", ...args], { cwd: mainRepo, env: GENV });
  await g(["init", "-b", "main", "."]);
  await writeFile(join(mainRepo, "a.txt"), "x\n");
  await g(["add", "-A"]);
  await g(["commit", "-m", "init"]);
  // a linked worktree whose dir is dag-12 (the stale layout a fail leaves behind)
  await g(["worktree", "add", "--detach", join(mainRepo, "dag-12")]);
  // a dag-preflight-* worktree left behind by the A2 preflight check — gc must
  // reclaim it too, otherwise preflight leaks one worktree per run. Two
  // features (A2 creates, D3 cleans) must compose.
  await g(["worktree", "add", "--detach", join(mainRepo, "dag-preflight-codex-gpt-5-4")]);
  // a non-dag worktree that must NOT be touched
  await g(["worktree", "add", "--detach", join(mainRepo, "other-wt")]);

  const code = await gc(mainRepo, true);
  expect(code).toBe(0);
  const list = await g(["worktree", "list", "--porcelain"]);
  expect(list.stdout).not.toContain("dag-12");
  expect(list.stdout).not.toContain("dag-preflight-codex-gpt-5-4");
  expect(list.stdout).toContain("other-wt"); // untouched
});

// ---------------------------------------------------------------------------
// 0.2.0 review fixes: `ls-runs` is a true positional subcommand now (spec #55
// framed it as one); and listRuns orders by startedAt, not the formatted row.
// ---------------------------------------------------------------------------

/** Capture process.stdout (listRuns prints its table there) into a buffer. */
function captureStdout(): { restore: () => void; text: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((chunk: unknown) => {
    buf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = orig;
    },
    text: () => buf,
  };
}

test("parseArgs: `ls-runs` is a positional subcommand (D2 form fix, #55)", () => {
  // The spec framed ls-runs as a subcommand (like `gc`); the original PR shipped
  // it as a `--ls-runs` flag. Both forms now work.
  expect(parseArgs(["ls-runs"]).lsRuns).toBe(true);
  expect(parseArgs(["--ls-runs"]).lsRuns).toBe(true); // alias retained
  // It is NOT mistaken for an issue number.
  expect(parseArgs(["ls-runs"]).numbers).toEqual([]);
});

test("listRuns (D2): orders runs by startedAt, not the formatted row", async () => {
  // An arbitrary --run-id isn't timestamp-suffixed, so the old
  // `rows.sort().reverse()` (which sorted formatted strings) mis-ordered.
  // Seed two runs whose NAMES sort opposite to their TIMESTAMPS and assert
  // newest-first follows the timestamp.
  const cwd = await mkdtemp(join(tmpdir(), "dag-ls-sort-"));
  const state = (startedAt: string, tickets: object) => ({
    runId: "r",
    target: "frontier",
    startedAt,
    updatedAt: startedAt,
    tickets,
  });
  await mkdir(join(cwd, ".scratch/dag-tickets/zzz-name"), { recursive: true });
  await writeFile(
    join(cwd, ".scratch/dag-tickets/zzz-name/state.json"),
    JSON.stringify(state("2026-07-29T00:00:00.000Z", { "1": { status: "done" } })),
  );
  await mkdir(join(cwd, ".scratch/dag-tickets/aaa-name"), { recursive: true });
  await writeFile(
    join(cwd, ".scratch/dag-tickets/aaa-name/state.json"),
    JSON.stringify(state("2026-07-30T00:00:00.000Z", { "2": { status: "done" } })),
  );
  const cap = captureStdout();
  try {
    expect(await listRuns(cwd)).toBe(0);
  } finally {
    cap.restore();
  }
  const out = cap.text();
  // aaa-name (newer timestamp) appears BEFORE zzz-name, despite the reverse
  // lexicographic name order — proving the sort is on startedAt.
  expect(out.indexOf("aaa-name")).toBeLessThan(out.indexOf("zzz-name"));
});
