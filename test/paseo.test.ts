import { test, expect, describe } from "bun:test";
import {
  isConnectionError,
  isRateLimited,
  PaseoAgent,
  runWithFallback,
  type ProviderPrefs,
} from "../src/paseo.ts";
import type {
  BranchPort,
  Dispatcher,
  DispatchOpts,
  DispatchResult,
  Logger,
} from "../src/ports.ts";
import type { Ticket } from "../src/types.ts";
import { EVT, RecordingSink } from "../src/events.ts";
import { NULL_SINK } from "../src/ports.ts";

describe("isRateLimited", () => {
  test("detects the real claude 429 quota string from the field", () => {
    const out =
      "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. " +
      "Your limit will reset at 2026-07-27 23:32:13][20260727232718912c36341c0842a6]";
    expect(isRateLimited(out)).toBe(true);
  });

  test("detects bare 429", () => {
    expect(isRateLimited("HTTP 429 Too Many Requests")).toBe(true);
  });

  test("detects 'rate limit' / 'rate-limit'", () => {
    expect(isRateLimited("rate limit exceeded")).toBe(true);
    expect(isRateLimited("rate-limit hit")).toBe(true);
  });

  test("detects quota language", () => {
    expect(isRateLimited("quota exceeded for the day")).toBe(true);
  });

  test("does not flag normal agent output", () => {
    expect(isRateLimited("REVIEW_VERDICT: CLEAN")).toBe(false);
    expect(isRateLimited("All 12 tests pass. Implementation complete.")).toBe(false);
    expect(isRateLimited("")).toBe(false);
  });

  test("does not false-positive on unrelated numbers", () => {
    expect(isRateLimited("Fixed 3 issues in 1429 lines")).toBe(false);
  });
});

describe("isConnectionError", () => {
  test("detects a relay ECONNRESET (the issue #39 failure mode)", () => {
    const out =
      "Error: Command timed out after 60s\npaseo run failed: fetch failed: " +
      "Error: connect ECONNRESET 203.0.113.10:443";
    expect(isConnectionError(out)).toBe(true);
  });

  test("detects bare errno codes", () => {
    expect(isConnectionError("write ECONNRESET")).toBe(true);
    expect(isConnectionError("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
    expect(isConnectionError("write EPIPE")).toBe(true);
  });

  test("detects 'stream closed' / 'stream ended' (relay SSE teardown)", () => {
    expect(isConnectionError("error: stream closed unexpectedly")).toBe(true);
    expect(isConnectionError("the response stream ended early")).toBe(true);
    expect(isConnectionError("stream aborted by the relay")).toBe(true);
  });

  test("detects undici 'fetch failed' / 'socket hang up'", () => {
    expect(isConnectionError("TypeError: fetch failed")).toBe(true);
    expect(isConnectionError("Error: socket hang up")).toBe(true);
  });

  test("detects human-readable 'connection reset/refused/closed'", () => {
    expect(isConnectionError("Connection reset by peer")).toBe(true);
    expect(isConnectionError("connect: connection refused")).toBe(true);
    expect(isConnectionError("remote connection closed")).toBe(true);
  });

  test("does not flag normal agent output", () => {
    expect(isConnectionError("REVIEW_VERDICT: CLEAN")).toBe(false);
    expect(isConnectionError("All 12 tests pass. Implementation complete.")).toBe(false);
    expect(isConnectionError("")).toBe(false);
  });

  test("does not false-positive on a rate-limit string (distinct classification)", () => {
    // A 429 / quota message is a rate limit, NOT a transport error — the two
    // must stay distinguishable so the post-mortem reason is correct.
    expect(isConnectionError("429 usage limit reached")).toBe(false);
    expect(isConnectionError("rate limit exceeded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PaseoAgent unit tests — dispatch is injected via a fake Dispatcher, so the
// adapter's load-bearing mappings (ImplResult.reason, the adapter-originated
// unknown verdict, the onRateLimited side effects) are exercised without
// spawning a real `paseo run`.
// ---------------------------------------------------------------------------

const PREFS: ProviderPrefs = {
  impl: "codex/impl",
  review: "claude/review",
  research: "codex/research",
  triage: "claude/triage",
};

function ticket(n = 11): Ticket {
  return {
    number: n,
    title: "Inject dispatch",
    url: `https://example.com/${n}`,
    body: "body",
    labels: ["ready-for-agent"],
    state: "open",
    blockedBy: [],
    kind: "implement",
  };
}

/** Recording BranchPort. commitCount defaults to 3 (happy path); override per-branch. */
class FakeBranch implements BranchPort {
  cleaned: string[] = [];
  deleted: string[] = [];
  fetched: string[] = [];
  /** Bases passed to commitCount, in call order (proves resolution to origin/<base>). */
  commitCountBases: string[] = [];
  counts: Record<string, number> = {};
  /** Per-(base,branch) overrides; key `${base}..${branch}`. Used to prove the
   *  same branch reports a different count under a stale local `main` than under
   *  the fetched `origin/main`, so commit-count MUST compare against origin/<base>. */
  countsByBase: Record<string, number> = {};
  /** Flip to false to simulate an offline / failed fetch. */
  fetchOk = true;
  async cleanBranch(branch: string): Promise<void> {
    this.cleaned.push(branch);
  }
  async deleteBranch(branch: string): Promise<void> {
    this.deleted.push(branch);
  }
  async ensureBaseRefFresh(base: string): Promise<boolean> {
    this.fetched.push(base);
    return this.fetchOk;
  }
  async commitCount(base: string, branch: string): Promise<number> {
    this.commitCountBases.push(base);
    return this.countsByBase[`${base}..${branch}`] ?? this.counts[branch] ?? 3;
  }
  rebased: Array<{ branch: string; oldBase: string; newBase: string }> = [];
  /** Flip to false to simulate a conflicting rebase. */
  rebaseOk = true;
  async rebaseOnto(branch: string, oldBase: string, newBase: string): Promise<boolean> {
    this.rebased.push({ branch, oldBase, newBase });
    return this.rebaseOk;
  }
  /** Scripted tips: ref → SHA. An absent ref returns null ("not pushed yet"). */
  tips: Record<string, string> = {};
  fetchedTips: string[] = [];
  async resolveRemoteTip(ref: string): Promise<string | null> {
    this.fetchedTips.push(ref);
    return this.tips[ref] ?? null;
  }
}

function capturingLog(): { log: Logger; lines: [string, string, number | undefined][] } {
  const lines: [string, string, number | undefined][] = [];
  const log: Logger = (level, msg, n) => lines.push([level, msg, n]);
  return { log, lines };
}

/** True iff a captured log line at `level` matches `re`. */
function logged(
  lines: [string, string, number | undefined][],
  level: string,
  re: RegExp,
): boolean {
  return lines.some(([lvl, msg]) => lvl === level && re.test(msg));
}

/**
 * Fake Dispatcher whose `dispatch` pops scripted results; `dispatchWithFallback`
 * runs the REAL {@link runWithFallback} loop over this.dispatch, so rate-limit
 * retries + onSwitch fire exactly as in prod (single source of truth).
 */
class ScriptedDispatcher implements Dispatcher {
  queue: DispatchResult[] = [];
  calls: DispatchOpts[] = [];
  async dispatch(_prompt: string, opts: DispatchOpts): Promise<DispatchResult> {
    this.calls.push(opts);
    return (
      this.queue.shift() ?? {
        ok: true,
        output: "",
        timedOut: false,
        rateLimited: false, connectionError: false,
      }
    );
  }
  async dispatchWithFallback(
    prompt: string,
    opts: DispatchOpts,
    fallbacks: string[],
    onSwitch?: (next: string) => Promise<void>,
  ): Promise<DispatchResult> {
    return runWithFallback(
      (p, o) => this.dispatch(p, o),
      prompt,
      opts,
      fallbacks,
      onSwitch,
    );
  }
}

describe("PaseoAgent.implement — dispatch result → ImplResult.reason", () => {
  // Empty fallback list isolates the reason map from the fallback loop: the
  // first (and only) dispatch result becomes the final dispatchWithFallback
  // outcome, so each reason maps 1:1 to the scripted DispatchResult.
  function agent(d: ScriptedDispatcher) {
    const cap = capturingLog();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], cap.log, undefined, 1000, d);
    return { a, ...cap };
  }

  test("rate-limited dispatch → reason 'rate-limited'", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "429 usage limit", timedOut: false, rateLimited: true, connectionError: false }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "rate-limited" });
  });

  test("timed-out dispatch (not rate-limited) → reason 'timeout'", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "", timedOut: true, rateLimited: false, connectionError: false }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "timeout" });
  });

  test("failed dispatch (neither) → reason 'failed'", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "boom", timedOut: false, rateLimited: false, connectionError: false }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "failed" });
  });

  test("connection-error dispatch (ECONNRESET in output) → reason 'connection-error' (transient, issue #39)", async () => {
    // A relay transport blip makes `paseo run` exit non-zero even though the
    // paseo daemon auto-recovers. The output carries the errno; the adapter
    // surfaces a transient `connection-error` so the ticket backs off and
    // retries instead of cascading as a hard `implement-failed`.
    const d = new ScriptedDispatcher();
    d.queue = [
      {
        ok: false,
        output: "paseo run failed: fetch failed: Error: connect ECONNRESET 203.0.113.10:443",
        timedOut: false,
        rateLimited: false,
        connectionError: true,
      },
    ];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "connection-error" });
  });

  test("rate-limit beats connection-error when both flags are set (fallback loop owns rate-limit)", async () => {
    // Precedence: rate-limited is decided first because dispatchWithFallback
    // already retried it across providers; a connection-error is the fallback
    // only when it isn't rate-limiting. Both are transient, so the retry
    // decision is unchanged — this just pins the post-mortem label.
    const d = new ScriptedDispatcher();
    d.queue = [
      { ok: false, output: "429 usage limit; fetch failed: ECONNRESET", timedOut: false, rateLimited: true, connectionError: true },
    ];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "rate-limited" });
  });

  test("ok dispatch but zero commits → reason 'empty'", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false }];
    const branch = new FakeBranch();
    branch.counts["b1"] = 0;
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    const r = await a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "empty" });
  });

  test("ok dispatch with commits → ok:true", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: true, commits: 3 });
  });
});

describe("PaseoAgent.review", () => {
  test("failed dispatch → { kind: 'unknown' } and a warn is logged", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "agent exploded", timedOut: false, rateLimited: false, connectionError: false }];
    const cap = capturingLog();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], cap.log, undefined, 1000, d);
    const v = await a.review(ticket(), "b1", "main");
    expect(v.kind).toBe("unknown");
    expect(v.issueCount).toBe(0);
    // adapter-originated unknown path: the warn restored in 6273b5c must fire.
    expect(logged(cap.lines, "warn", /review agent failed/)).toBe(true);
  });

  test("timeout failure still logs the (timeout) suffix", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "", timedOut: true, rateLimited: false, connectionError: false }];
    const cap = capturingLog();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], cap.log, undefined, 1000, d);
    const v = await a.review(ticket(), "b1", "main");
    expect(v.kind).toBe("unknown");
    expect(logged(cap.lines, "warn", /review agent failed \(timeout\)/)).toBe(true);
  });

  test("ok dispatch with REVIEW_VERDICT: CLEAN → parsed clean", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [
      { ok: true, output: "Looks good.\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false },
    ];
    const cap = capturingLog();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], cap.log, undefined, 1000, d);
    const v = await a.review(ticket(), "b1", "main");
    expect(v.kind).toBe("clean");
    expect(v.issueCount).toBe(0);
  });
});

describe("PaseoAgent.onRateLimited (exercised via review)", () => {
  test("rate-limited primary retried on a fallback: logs the switch + cleans the branch", async () => {
    const d = new ScriptedDispatcher();
    // primary rate-limited, then the single fallback succeeds (CLEAN verdict).
    d.queue = [
      { ok: false, output: "429 usage limit reached", timedOut: false, rateLimited: true, connectionError: false },
      { ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false },
    ];
    const branch = new FakeBranch();
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, ["claude/opus"], cap.log, undefined, 1000, d);
    const v = await a.review(ticket(), "b1", "main");

    // The fallback succeeded, so the verdict was parsed (not unknown).
    expect(v.kind).toBe("clean");
    // onRateLimited emitted the provider-switch warn and freed the branch.
    // review() also cleans on entry, so two cleans proves onRateLimited fired.
    expect(logged(cap.lines, "warn", /review rate-limited; retrying on claude\/opus/)).toBe(true);
    expect(branch.cleaned).toEqual(["b1", "b1"]);
  });
});

describe("runWithFallback — the real dispatch fallback loop", () => {
  const baseOpts = (provider: string): DispatchOpts => ({
    provider,
    title: "t",
    slug: "s",
    branchMode: "checkout-branch",
  });

  test("onSwitch fires for each fallback while rate-limited, stops at first success", async () => {
    const calls: string[] = [];
    const switches: string[] = [];
    // primary + "a" stay rate-limited; "b" succeeds; "c" must never be tried.
    const dispatchFn = async (_p: string, opts: DispatchOpts): Promise<DispatchResult> => {
      calls.push(opts.provider);
      const rl = opts.provider === "primary" || opts.provider === "a";
      return { ok: !rl, output: opts.provider, timedOut: false, rateLimited: rl, connectionError: false };
    };
    const result = await runWithFallback(
      dispatchFn,
      "p",
      baseOpts("primary"),
      ["a", "b", "c"],
      async (next) => {
        switches.push(next);
      },
    );
    expect(calls).toEqual(["primary", "a", "b"]); // "c" never dispatched
    expect(switches).toEqual(["a", "b"]); // onSwitch before each retry
    expect(result.ok).toBe(true);
    expect(result.rateLimited).toBe(false);
  });

  test("all fallbacks rate-limited → ok forced false, every fallback tried", async () => {
    const switches: string[] = [];
    const dispatchFn = async (_p: string, _opts: DispatchOpts): Promise<DispatchResult> => ({
      ok: false,
      output: "429",
      timedOut: false,
      rateLimited: true, connectionError: false,
    });
    const result = await runWithFallback(
      dispatchFn,
      "p",
      baseOpts("primary"),
      ["a", "b"],
      async (next) => {
        switches.push(next);
      },
    );
    expect(switches).toEqual(["a", "b"]);
    expect(result.ok).toBe(false);
    expect(result.rateLimited).toBe(true);
  });

  test("primary reappearing in the fallback list is skipped (fb === opts.provider)", async () => {
    const calls: string[] = [];
    const dispatchFn = async (_p: string, opts: DispatchOpts): Promise<DispatchResult> => {
      calls.push(opts.provider);
      return { ok: false, output: "", timedOut: false, rateLimited: true, connectionError: false };
    };
    await runWithFallback(dispatchFn, "p", baseOpts("primary"), ["primary", "a"], async () => {});
    // "primary" dispatched once (initial); never re-dispatched as a fallback.
    expect(calls).toEqual(["primary", "a"]);
  });

  test("first success with no rate-limiting calls no fallback and no onSwitch", async () => {
    const switches: string[] = [];
    const calls: string[] = [];
    const dispatchFn = async (_p: string, opts: DispatchOpts): Promise<DispatchResult> => {
      calls.push(opts.provider);
      return { ok: true, output: "done", timedOut: false, rateLimited: false, connectionError: false };
    };
    const result = await runWithFallback(
      dispatchFn,
      "p",
      baseOpts("primary"),
      ["a", "b"],
      async (next) => {
        switches.push(next);
      },
    );
    expect(calls).toEqual(["primary"]);
    expect(switches).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Base-ref freshness before branch-off (#15). A dependent ticket that starts
// after its blocker merged in the same run must branch off a base that
// contains that merge. The adapter's contract: before every branch-off it
// fetches origin/<base> (so a same-run squash-merge is visible) and resolves
// the branch-off base + commit-count to origin/<base>; if the fetch fails the
// ticket FAILS (reason 'stale-base') rather than silently composing on a stale
// tip. checkout-branch steps (review/fix) are NOT branch-offs and must not fetch.
// ---------------------------------------------------------------------------

describe("PaseoAgent — base ref fetch before branch-off (#15)", () => {
  test("implement fetches origin/<base> once and resolves branch-off + commitCount to it", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false }];
    const branch = new FakeBranch();
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    const r = await a.implement(ticket(), "b1", "main");

    expect(r.ok).toBe(true);
    // fetched the bare base exactly once, before the dispatch
    expect(branch.fetched).toEqual(["main"]);
    // branch-off base is the resolved origin/main, not the stale local main
    expect(d.calls[0]?.branchMode).toBe("branch-off");
    expect(d.calls[0]?.base).toBe("origin/main");
    expect(d.calls[0]?.newBranch).toBe("b1");
    // commit-count compared against the fetched origin/main so an empty impl
    // isn't masked by a stale local main (and real commits aren't over-counted)
    expect(branch.commitCountBases).toEqual(["origin/main"]);
  });

  test("singleShot fetches origin/<base> and resolves branch-off to it", async () => {
    const d = new ScriptedDispatcher();
    const branch = new FakeBranch();
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    const r = await a.singleShot("triage", ticket(), "b1", "main");

    expect(r.ok).toBe(true);
    expect(branch.fetched).toEqual(["main"]);
    expect(d.calls[0]?.branchMode).toBe("branch-off");
    expect(d.calls[0]?.base).toBe("origin/main");
  });

  test("review (checkout-branch) does NOT fetch — it is not a branch-off", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "REVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false }];
    const branch = new FakeBranch();
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    await a.review(ticket(), "b1", "main");

    expect(branch.fetched).toEqual([]);
    expect(d.calls[0]?.branchMode).toBe("checkout-branch");
  });

  test("implement fetch fail FAILS the ticket (stale-base) — no silent stale branch-off", async () => {
    // AC#1/#2: a base we couldn't refresh is not safe to branch off. Proceeding
    // would silently compose on pre-merge code — the exact failure #15 prevents.
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false }];
    const branch = new FakeBranch();
    branch.fetchOk = false; // simulate offline / unreachable remote
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    const r = await a.implement(ticket(), "b1", "main");

    // hard fail, not a degraded proceed
    expect(r).toEqual({ ok: false, commits: 0, reason: "stale-base" });
    expect(logged(cap.lines, "warn", /could not fetch origin\/main/)).toBe(true);
    // the agent was never dispatched, and commit-count never ran (no branch-off)
    expect(d.calls).toEqual([]);
    expect(branch.commitCountBases).toEqual([]);
  });

  test("regression: empty impl is still detected when local main is stale (commit-count must use origin/<base>)", async () => {
    // The agent produced zero commits, so the branch sits at origin/main.
    // A stale LOCAL main (behind origin/main) would make `main..b1` report the
    // gap commits as if they were the agent's — masking the empty impl. Counting
    // against the fetched origin/main reports 0, so empty is correctly detected.
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false }];
    const branch = new FakeBranch();
    branch.countsByBase[`origin/main..b1`] = 0; // truth: no agent commits vs fetched tip
    branch.countsByBase[`main..b1`] = 5; // stale local main would over-count
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    const r = await a.implement(ticket(), "b1", "main");

    expect(r).toEqual({ ok: false, commits: 0, reason: "empty" });
    // proves the count was taken against origin/main, not the stale local main
    expect(branch.commitCountBases).toEqual(["origin/main"]);
  });
});

// ---------------------------------------------------------------------------
// Structured event log (issue #19): the agent adapter emits provider.switch on
// every rate-limit fallback. The human warn line is unchanged; this is the
// machine-readable twin.
// ---------------------------------------------------------------------------

const NOOP_LOG: Logger = () => {};

describe("PaseoAgent — provider.switch event", () => {
  test("review fallback emits provider.switch {skill:review, from, to, reason}", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [
      { ok: false, output: "429 usage limit reached", timedOut: false, rateLimited: true, connectionError: false },
      { ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false },
    ];
    const sink = new RecordingSink();
    const a = new PaseoAgent(
      new FakeBranch(),
      PREFS,
      ["claude/opus"],
      NOOP_LOG,
      undefined,
      1000,
      d,
      sink,
    );
    const v = await a.review(ticket(), "b1", "main");
    expect(v.kind).toBe("clean"); // fallback succeeded
    const sw = sink.events.find((e) => e.type === EVT.PROVIDER_SWITCH);
    expect(sw).toBeDefined();
    expect(sw!.ticket).toBe(11);
    expect(sw!.data).toEqual({
      skill: "review",
      from: "claude/review",
      to: "claude/opus",
      reason: "rate-limited",
    });
  });

  test("implement fallback emits provider.switch {skill:implement, from, to}", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [
      { ok: false, output: "429 quota exceeded", timedOut: false, rateLimited: true, connectionError: false },
      // second dispatch on the fallback succeeds with commits (FakeBranch counts=3)
      { ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false },
    ];
    const sink = new RecordingSink();
    const a = new PaseoAgent(
      new FakeBranch(),
      PREFS,
      ["omp/zai"],
      NOOP_LOG,
      undefined,
      1000,
      d,
      sink,
    );
    const r = await a.implement(ticket(), "b1", "main");
    expect(r.ok).toBe(true);
    const sw = sink.events.find((e) => e.type === EVT.PROVIDER_SWITCH);
    expect(sw).toBeDefined();
    expect(sw!.data).toEqual({
      skill: "implement",
      from: "codex/impl",
      to: "omp/zai",
      reason: "rate-limited",
    });
  });

  test("no rate-limiting emits no provider.switch", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false }];
    const sink = new RecordingSink();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], NOOP_LOG, undefined, 1000, d, sink);
    await a.review(ticket(), "b1", "main");
    expect(sink.events.some((e) => e.type === EVT.PROVIDER_SWITCH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #20 — PaseoAgent.abort: kill the running agent for a ticket + clean its
// worktree when a cascade dooms it. stopAgent is injected (the constructor's
// last param) so the kill is unit-testable without `paseo ls|stop`; the branch
// clean reuses the tested BranchPort.cleanBranch.
// ---------------------------------------------------------------------------

describe("PaseoAgent.abort (#20)", () => {
  test("stops the agent for the ticket number and cleans its branch worktree", async () => {
    const stopped: number[] = [];
    const branch = new FakeBranch();
    const cap = capturingLog();
    const a = new PaseoAgent(
      branch,
      PREFS,
      [],
      cap.log,
      undefined,
      1000,
      new ScriptedDispatcher(),
      NULL_SINK,
      async (n) => {
        stopped.push(n);
      },
    );
    await a.abort(ticket(11));
    // stopAgent invoked with the ticket number (the dispatch kill)
    expect(stopped).toEqual([11]);
    // worktree for the ticket's branch cleaned (branchFor(11, "Inject dispatch"))
    expect(branch.cleaned).toEqual(["loop/11-inject-dispatch"]);
    // one human warn line so an operator sees the abort in stderr
    expect(logged(cap.lines, "warn", /cascade-abort/)).toBe(true);
  });

  test("a failing stopAgent is swallowed — the branch is still cleaned, abort never throws", async () => {
    // The scheduler has already recorded the dependent cascade-skipped, so a
    // kill that fails must not propagate; the worktree clean still runs.
    const branch = new FakeBranch();
    const cap = capturingLog();
    const a = new PaseoAgent(
      branch,
      PREFS,
      [],
      cap.log,
      undefined,
      1000,
      new ScriptedDispatcher(),
      NULL_SINK,
      async () => {
        throw new Error("paseo stop exploded");
      },
    );
    await expect(a.abort(ticket(11))).resolves.toBeUndefined();
    expect(branch.cleaned).toEqual(["loop/11-inject-dispatch"]); // clean still ran
  });

  test("a failing cleanBranch is swallowed — abort never throws", async () => {
    // A missing/stale worktree (lost race) must not surface as a throw.
    const branch = new FakeBranch();
    branch.cleanBranch = async () => {
      throw new Error("worktree busy");
    };
    const a = new PaseoAgent(
      branch,
      PREFS,
      [],
      NOOP_LOG,
      undefined,
      1000,
      new ScriptedDispatcher(),
      NULL_SINK,
      async () => {},
    );
    await expect(a.abort(ticket(11))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #29 — PaseoAgent.reconcile: rebase an overlapped dependent onto its merged
// blocker. ensureBaseRefFresh reuses the #15 freshness gate; the rebase itself
// reuses the tested BranchPort.rebaseOnto. Never throws — conflict / fetch
// failure surface as a ReconcileResult the caller fails the dependent on.
// ---------------------------------------------------------------------------

describe("PaseoAgent.reconcile (#29)", () => {
  test("fetches the base and rebases the dependent's branch onto the merged tip", async () => {
    const branch = new FakeBranch();
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, new ScriptedDispatcher());
    const out = await a.reconcile(ticket(11), "abc123", "main");
    expect(out).toEqual({ ok: true });
    // #15 freshness gate ran against the bare base.
    expect(branch.fetched).toEqual(["main"]);
    // rebase replayed commits abc123..branch onto origin/main.
    expect(branch.rebased).toEqual([
      { branch: "loop/11-inject-dispatch", oldBase: "abc123", newBase: "origin/main" },
    ]);
    expect(logged(cap.lines, "ok", /overlap-reconcile/)).toBe(true);
  });

  test("a conflicting rebase returns {ok:false, reason:'overlap-rebase'} and never throws", async () => {
    const branch = new FakeBranch();
    branch.rebaseOk = false;
    const a = new PaseoAgent(branch, PREFS, [], NOOP_LOG, undefined, 1000, new ScriptedDispatcher());
    const out = await a.reconcile(ticket(11), "abc123", "main");
    expect(out).toEqual({ ok: false, reason: "overlap-rebase" });
  });

  test("a failed base fetch returns {ok:false, reason:'stale-base'} — refuses a stale rebase", async () => {
    const branch = new FakeBranch();
    branch.fetchOk = false;
    const a = new PaseoAgent(branch, PREFS, [], NOOP_LOG, undefined, 1000, new ScriptedDispatcher());
    const out = await a.reconcile(ticket(11), "abc123", "main");
    expect(out).toEqual({ ok: false, reason: "stale-base" });
    expect(branch.rebased).toEqual([]); // rebase never attempted on a stale base
  });
});
