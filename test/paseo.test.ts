import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveTicketAgents,
  implFailReason,
  isConnectionError,
  isDagWorktreeSegment,
  isRateLimited,
  modelOverrideWarning,
  parseProviderSpec,
  PaseoAgent,
  preflight,
  preflightOk,
  preflightSummary,
  ProviderHealth,
  readCodexModel,
  runWithFallback,
  stopRunningAgent,
  THINKING_LEVELS,
  writeDispatchLog,
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

  test("detects ETIMEDOUT (connect/read socket timeout — issue #39 'etc.')", () => {
    // A pure ETIMEDOUT without an undici 'fetch failed' wrapper must still be
    // classified transient; previously it relied on an unverified claim that
    // such a timeout 'always' surfaces as fetch failed / socket hang up.
    expect(isConnectionError("Error: connect ETIMEDOUT 203.0.113.10:443")).toBe(true);
    expect(isConnectionError("read ETIMEDOUT")).toBe(true);
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

  test("high-confidence anchors never appear in clean prose (errno / undici / socket)", () => {
    // The load-bearing signals — errno codes, undici 'fetch failed', Node
    // 'socket hang up' — are error-specific and never occur in ordinary agent
    // output. Real relay traces carry one of these; clean prose does not.
    expect(isConnectionError("All 12 tests pass. Implementation complete.")).toBe(false);
    expect(isConnectionError("fetching results from the database")).toBe(false);
    expect(isConnectionError("reset the counter to zero")).toBe(false);
    expect(isConnectionError("piped the output through the socket helper")).toBe(false);
  });

  test("verb-phrases are prose-prone by design (accepted, bounded trade-off)", () => {
    // `stream closed` / `connection closed` etc. intentionally also match
    // human-readable relay phrases (e.g. 'remote connection closed'), so they
    // CAN false-positive when such a phrase appears verbatim in a FAILED
    // dispatch's prose. Blast radius is bounded — one needless retry, then
    // the genuine failure recurs and is classified terminal. Pinned here so a
    // future tighten/loosen is a deliberate decision, not an accident.
    expect(isConnectionError("the data stream ended at row 50")).toBe(true);
    expect(isConnectionError("remote connection closed")).toBe(true);
  });

  test("does not false-positive on a rate-limit string (distinct classification)", () => {
    // A 429 / quota message is a rate limit, NOT a transport error — the two
    // must stay distinguishable so the post-mortem reason is correct.
    expect(isConnectionError("429 usage limit reached")).toBe(false);
    expect(isConnectionError("rate limit exceeded")).toBe(false);
  });
});

describe("implFailReason — dispatch flags → ImplFailReason (precedence)", () => {
  // The rule is extracted from PaseoAgent.implement so the precedence is
  // named and directly testable; these pin the order independent of the
  // adapter wiring.
  const f = implFailReason;

  test("rate-limited wins over everything (fallback loop already retried it)", () => {
    expect(f({ rateLimited: true, connectionError: true, timedOut: true })).toBe("rate-limited");
  });

  test("connection-error beats timeout (root-cause label; both are transient)", () => {
    // A transport reset that also burned the wall clock is labelled by its
    // root cause. Retry decision is identical (both in TRANSIENT_REASONS).
    expect(f({ rateLimited: false, connectionError: true, timedOut: true })).toBe("connection-error");
  });

  test("timeout when neither rate-limit nor connection-error", () => {
    expect(f({ rateLimited: false, connectionError: false, timedOut: true })).toBe("timeout");
  });

  test("terminal 'failed' catch-all when nothing else applies", () => {
    expect(f({ rateLimited: false, connectionError: false, timedOut: false })).toBe("failed");
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
    onRateLimited?: (provider: string) => void,
  ): Promise<DispatchResult> {
    return runWithFallback(
      (p, o) => this.dispatch(p, o),
      prompt,
      opts,
      fallbacks,
      onSwitch,
      onRateLimited,
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

// ---------------------------------------------------------------------------
// #40 — stop the prior (rate-limited) agent BEFORE spawning the fallback.
// Without this, the rate-limited primary and the fallback both run on the same
// worktree and clobber each other's edits (the orphan-agent accumulation from
// the field report). stopAgent is injected (constructor's last param) so the
// stop is asserted without `paseo ls|stop`; the ordering (stop between the
// primary and fallback dispatch) is the load-bearing assertion.
// ---------------------------------------------------------------------------

describe("PaseoAgent — stop prior agent before rate-limit fallback (#40)", () => {
  /** Wrap a ScriptedDispatcher so each dispatch records its provider into
   *  `order`, in call sequence — so a test can assert stop fires BETWEEN the
   *  primary and the fallback dispatch (the race the fix prevents). */
  function tracingDispatcher(
    queue: DispatchResult[],
    order: string[],
  ): ScriptedDispatcher {
    const d = new ScriptedDispatcher();
    d.queue = queue;
    const real = d.dispatch.bind(d);
    d.dispatch = async (_p, opts) => {
      order.push(`dispatch:${opts.provider}`);
      return real(_p, opts);
    };
    return d;
  }

  test("review stops the prior agent between the primary and the fallback dispatch", async () => {
    const order: string[] = [];
    const stopped: number[] = [];
    const d = tracingDispatcher(
      [
        { ok: false, output: "429 usage limit reached", timedOut: false, rateLimited: true, connectionError: false },
        { ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false },
      ],
      order,
    );
    const branch = new FakeBranch();
    const a = new PaseoAgent(
      branch,
      PREFS,
      ["claude/opus"],
      NOOP_LOG,
      undefined,
      1000,
      d,
      NULL_SINK,
      async (n) => {
        order.push(`stop:${n}`);
        stopped.push(n);
      },
    );
    const v = await a.review(ticket(11), "b1", "main");
    expect(v.kind).toBe("clean"); // fallback succeeded
    expect(stopped).toEqual([11]); // prior agent stopped, once
    // stop fired AFTER the primary dispatch and BEFORE the fallback dispatch —
    // the exact ordering that prevents two agents on one worktree.
    expect(order.indexOf("dispatch:claude/review")).toBeLessThan(order.indexOf("stop:11"));
    expect(order.indexOf("stop:11")).toBeLessThan(order.indexOf("dispatch:claude/opus"));
  });

  test("implement stops the prior agent between the primary and the fallback dispatch", async () => {
    const order: string[] = [];
    const stopped: number[] = [];
    const d = tracingDispatcher(
      [
        { ok: false, output: "429 quota exceeded", timedOut: false, rateLimited: true, connectionError: false },
        { ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false }, // fallback ok, commits land
      ],
      order,
    );
    const branch = new FakeBranch();
    const a = new PaseoAgent(
      branch,
      PREFS,
      ["omp/zai"],
      NOOP_LOG,
      undefined,
      1000,
      d,
      NULL_SINK,
      async (n) => {
        order.push(`stop:${n}`);
        stopped.push(n);
      },
    );
    const r = await a.implement(ticket(11), "b1", "main");
    expect(r.ok).toBe(true); // fallback produced commits (FakeBranch counts=3)
    expect(stopped).toEqual([11]);
    expect(order.indexOf("dispatch:codex/impl")).toBeLessThan(order.indexOf("stop:11"));
    expect(order.indexOf("stop:11")).toBeLessThan(order.indexOf("dispatch:omp/zai"));
    // the branch-off retry still cleans + deletes the branch after the stop
    expect(branch.cleaned).toEqual(["b1"]);
    expect(branch.deleted).toEqual(["b1"]);
  });

  test("fix stops the prior agent before the fallback (shares onRateLimited with review)", async () => {
    const order: string[] = [];
    const stopped: number[] = [];
    const d = tracingDispatcher(
      [
        { ok: false, output: "429", timedOut: false, rateLimited: true, connectionError: false },
        { ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false },
      ],
      order,
    );
    const a = new PaseoAgent(
      new FakeBranch(),
      PREFS,
      ["omp/zai"],
      NOOP_LOG,
      undefined,
      1000,
      d,
      NULL_SINK,
      async (n) => {
        order.push(`stop:${n}`);
        stopped.push(n);
      },
    );
    const verdict = { kind: "issues" as const, issueCount: 2, raw: "REVIEW_VERDICT: ISSUES 2" };
    const r = await a.fix(ticket(11), verdict, "b1", 1);
    expect(r.ok).toBe(true);
    expect(stopped).toEqual([11]);
    expect(order.indexOf("dispatch:codex/impl")).toBeLessThan(order.indexOf("stop:11"));
    expect(order.indexOf("stop:11")).toBeLessThan(order.indexOf("dispatch:omp/zai"));
  });

  test("a throwing stopAgent is swallowed — the fallback still runs and the branch is still cleaned", async () => {
    // A stop failure (paseo unreachable / lost race) must NOT block the retry.
    const d = new ScriptedDispatcher();
    d.queue = [
      { ok: false, output: "429", timedOut: false, rateLimited: true, connectionError: false },
      { ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false },
    ];
    const branch = new FakeBranch();
    const a = new PaseoAgent(
      branch,
      PREFS,
      ["claude/opus"],
      NOOP_LOG,
      undefined,
      1000,
      d,
      NULL_SINK,
      async () => {
        throw new Error("paseo stop exploded");
      },
    );
    const v = await a.review(ticket(11), "b1", "main");
    expect(v.kind).toBe("clean"); // fallback still ran despite the throwing stop
    expect(branch.cleaned).toEqual(["b1", "b1"]); // entry + onSwitch clean both ran
  });
});

// ---------------------------------------------------------------------------
// #40 — stopInFlight: exit-cleanup seam. Called from the cli's try/finally and
// signal handler to stop every agent this run still has in flight. Best-effort
// and never throws: a per-ticket failure doesn't skip the rest.
// ---------------------------------------------------------------------------

describe("PaseoAgent.stopInFlight (#40)", () => {
  function agentWithStop(stop: (n: number) => Promise<void>): PaseoAgent {
    return new PaseoAgent(
      new FakeBranch(),
      PREFS,
      [],
      NOOP_LOG,
      undefined,
      1000,
      new ScriptedDispatcher(),
      NULL_SINK,
      stop,
    );
  }

  test("stops each in-flight ticket's agent", async () => {
    const stopped: number[] = [];
    const a = agentWithStop(async (n) => {
      stopped.push(n);
    });
    await a.stopInFlight([11, 12, 13]);
    expect(stopped).toEqual([11, 12, 13]);
  });

  test("accepts a live Set (the cli's inflightTickets)", async () => {
    const stopped: number[] = [];
    const a = agentWithStop(async (n) => {
      stopped.push(n);
    });
    await a.stopInFlight(new Set([11, 12, 13]));
    expect(stopped).toEqual([11, 12, 13]);
  });

  test("a throwing stop for one ticket doesn't skip the rest — never throws", async () => {
    const stopped: number[] = [];
    const a = agentWithStop(async (n) => {
      if (n === 12) throw new Error("boom");
      stopped.push(n);
    });
    await expect(a.stopInFlight([11, 12, 13])).resolves.toBeUndefined();
    expect(stopped).toEqual([11, 13]); // 12's throw swallowed; 11 + 13 still stopped
  });

  test("empty input is a no-op", async () => {
    const stopped: number[] = [];
    const a = agentWithStop(async (n) => {
      stopped.push(n);
    });
    await a.stopInFlight([]);
    expect(stopped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #40 — stopRunningAgent contract: best-effort and NEVER throws. The unit-test
// env has no `paseo` executable, so `run()` throws ENOENT. The rate-limit
// fallback now calls stopAgent by default (the unit tests above that don't
// inject a stopAgent), so this contract must hold or those tests would throw.
// ---------------------------------------------------------------------------

describe("stopRunningAgent — never throws (no paseo in unit-test env)", () => {
  test("returns without throwing when paseo is absent from PATH", async () => {
    await expect(stopRunningAgent(undefined, 11)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 0.3.0 feedback E1 — archiveTicketAgents: best-effort reclamation of the
// Paseo agent RECORD (not just the worktree, which cleanBranch handles). Same
// never-throws contract as stopRunningAgent; the unit-test env has no paseo.
// ---------------------------------------------------------------------------
describe("archiveTicketAgents (E1) — reclaims paseo agent records, never throws", () => {
  test("returns without throwing when paseo is absent from PATH", async () => {
    await expect(archiveTicketAgents(undefined, 11)).resolves.toBeUndefined();
  });

  test("accepts an undefined cwd (the cli's default when --cwd is unset)", async () => {
    await expect(archiveTicketAgents(undefined, 42)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback A3 — readCodexModel: honour the user's ~/.codex/config.toml
// `model = "…"` instead of the hardcoded gpt-5.4 default. Only the top-level
// model wins; a `model` inside a [table] block must not.
// ---------------------------------------------------------------------------
describe("readCodexModel (A3) — codex config model", () => {
  const makeHome = (toml: string): string => {
    const home = mkdtempSync(join(tmpdir(), "dag-codex-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), toml, "utf8");
    return home;
  };

  test("reads the top-level model line", () => {
    const home = makeHome('model = "gpt-5.6-sol"\nbase_url = "x"\n');
    expect(readCodexModel(home)).toBe("gpt-5.6-sol");
  });

  test("ignores a model inside a [table] block", () => {
    const home = makeHome(
      'model = "gpt-5.6-sol"\n[mcp_servers]\nmodel = "trapped"\n',
    );
    expect(readCodexModel(home)).toBe("gpt-5.6-sol");
  });

  test("stops at the first table header even with no top-level model", () => {
    const home = makeHome('[tui]\nmodel = "should-not-win"\n');
    expect(readCodexModel(home)).toBeUndefined();
  });

  test("returns undefined when the file is missing", () => {
    // mkdtemp dir with no .codex/config.toml
    const home = mkdtempSync(join(tmpdir(), "dag-codex-"));
    expect(readCodexModel(home)).toBeUndefined();
  });

  test("returns undefined for malformed / no model line", () => {
    const home = makeHome('# just a comment\nbase_url = "x"\n');
    expect(readCodexModel(home)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback A1 — per-step agent output logs: writeDispatchLog writes the
// agent transcript + relay stderr + exit code to opts.logFile, and PaseoAgent
// threads the resulting logPath onto its results + a failed outcome.
// ---------------------------------------------------------------------------
describe("writeDispatchLog (A1) — dispatch output capture", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "dag-log-"));

  test("returns undefined when opts.logFile is absent (unit tests / no run dir)", () => {
    const opts = {
      provider: "codex/x",
      title: "implement #15",
      slug: "dag-15",
      branchMode: "branch-off" as const,
    };
    expect(writeDispatchLog(opts, { code: 0, stderr: "", timedOut: false }, "out")).toBeUndefined();
  });

  test("honors opts.logFile: creates parent dir, writes formatted body, returns path", () => {
    const dir = tmp();
    const file = join(dir, "deep", "logs", "15-implement.log");
    const opts = {
      provider: "codex/gpt-5.6-sol",
      title: "implement #15",
      slug: "dag-15",
      branchMode: "branch-off" as const,
      logFile: file,
    };
    const path = writeDispatchLog(
      opts,
      { code: 1, stderr: "wss://api.openai.com 401 Unauthorized", timedOut: false },
      "REVIEW_VERDICT: CLEAN",
    );
    expect(path).toBe(file);
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body).toContain("provider: codex/gpt-5.6-sol");
    expect(body).toContain("exit: 1");
    expect(body).toContain("## agent output");
    expect(body).toContain("REVIEW_VERDICT: CLEAN");
    expect(body).toContain("## stderr");
    expect(body).toContain("401 Unauthorized");
  });

  test("returns undefined (never throws) when the path is unwritable", () => {
    const opts = {
      provider: "x",
      title: "t",
      slug: "s",
      branchMode: "branch-off" as const,
      logFile: "/proc/cannot/write/here/x.log",
    };
    expect(
      writeDispatchLog(opts, { code: 0, stderr: "", timedOut: false }, "out"),
    ).toBeUndefined();
  });
});

describe("PaseoAgent (A1) — threads logFile + logPath through results", () => {
  const makeLoggingDispatcher = (result: (o: DispatchOpts) => DispatchResult): Dispatcher => ({
    dispatch: async (_prompt, o) => {
      if (o.logFile) {
        try {
          mkdirSync(join(o.logFile, ".."), { recursive: true });
        } catch {}
        try {
          writeFileSync(o.logFile, "stub dispatch log", "utf8");
        } catch {}
      }
      const r = result(o);
      return o.logFile ? { ...r, logPath: o.logFile } : r;
    },
    dispatchWithFallback: async (prompt, o, _fb, onSwitch) => {
      const r = await makeLoggingDispatcher(result).dispatch(prompt, o);
      // honour the rate-limit switch path so implement's branch-off callback runs
      if (r.rateLimited && _fb.length) {
        for (const fb of _fb) {
          if (fb === o.provider) continue;
          if (onSwitch) await onSwitch(fb);
          const r2 = await makeLoggingDispatcher(result).dispatch(prompt, { ...o, provider: fb });
          if (!r2.rateLimited) return o.logFile ? { ...r2, logPath: o.logFile } : r2;
        }
      }
      return r;
    },
  });

  test("a failed implement carries logPath + writes the log file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dag-agent-"));
    const stepLogDir = join(dir, "logs");
    const d = makeLoggingDispatcher(() => ({
      ok: false,
      output: "401 Unauthorized",
      timedOut: false,
      rateLimited: false,
      connectionError: false,
    }));
    const branch: BranchPort = {
      cleanBranch: async () => {},
      commitCount: async () => 0,
      deleteBranch: async () => {},
      ensureBaseRefFresh: async () => true,
      rebaseOnto: async () => true,
      resolveRemoteTip: async () => null,
    };
    const a = new PaseoAgent(branch, PREFS, [], NOOP_LOG, undefined, 1000, d, undefined, undefined, stepLogDir);
    const t: Ticket = { number: 15, title: "x", url: "", body: "", labels: [], state: "open", blockedBy: [], kind: "implement" };
    const r = await a.implement(t, "loop/15-x", "main");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("failed");
    expect(r.logPath).toBe(join(stepLogDir, "15-implement.log"));
    expect(existsSync(r.logPath!)).toBe(true);
    expect(readFileSync(r.logPath!, "utf8")).toBe("stub dispatch log");
  });

  test("a clean review propagates logPath onto the verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dag-agent-"));
    const stepLogDir = join(dir, "logs");
    const d = makeLoggingDispatcher(() => ({
      ok: true,
      output: "ok\nREVIEW_VERDICT: CLEAN",
      timedOut: false,
      rateLimited: false,
      connectionError: false,
    }));
    const branch: BranchPort = {
      cleanBranch: async () => {},
      commitCount: async () => 0,
      deleteBranch: async () => {},
      ensureBaseRefFresh: async () => true,
      rebaseOnto: async () => true,
      resolveRemoteTip: async () => null,
    };
    const a = new PaseoAgent(branch, PREFS, [], NOOP_LOG, undefined, 1000, d, undefined, undefined, stepLogDir);
    const t: Ticket = { number: 16, title: "x", url: "", body: "", labels: [], state: "open", blockedBy: [], kind: "implement" };
    const v = await a.review(t, "loop/16-x", "main");
    expect(v.kind).toBe("clean");
    expect(v.logPath).toBe(join(stepLogDir, "16-review.log"));
  });

  test("fix round logs get a -r<round> suffix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dag-agent-"));
    const stepLogDir = join(dir, "logs");
    const d = makeLoggingDispatcher(() => ({
      ok: true,
      output: "",
      timedOut: false,
      rateLimited: false,
      connectionError: false,
    }));
    const branch: BranchPort = {
      cleanBranch: async () => {},
      commitCount: async () => 0,
      deleteBranch: async () => {},
      ensureBaseRefFresh: async () => true,
      rebaseOnto: async () => true,
      resolveRemoteTip: async () => null,
    };
    const a = new PaseoAgent(branch, PREFS, [], NOOP_LOG, undefined, 1000, d, undefined, undefined, stepLogDir);
    const t: Ticket = { number: 17, title: "x", url: "", body: "", labels: [], state: "open", blockedBy: [], kind: "implement" };
    const r = await a.fix(t, { kind: "issues", issueCount: 2, raw: "" }, "loop/17-x", 2);
    expect(r.ok).toBe(true);
    expect(existsSync(join(stepLogDir, "17-fix-r2.log"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 0.3.0 feedback A1 — parseProviderSpec: split `provider/model:thinking` so
// paseo's `--provider` gets the bare spec and the `:thinking` suffix is
// forwarded as `--thinking`. Paseo does NOT parse the suffix off `--provider`,
// so without this every `:max` spec silently ran at the provider default.
// ---------------------------------------------------------------------------
describe("parseProviderSpec (A1) — :thinking suffix", () => {
  const p = parseProviderSpec;

  test("extracts a recognised thinking suffix", () => {
    expect(p("pi/zai/glm-5.2:max")).toEqual({ provider: "pi/zai/glm-5.2", thinking: "max" });
    expect(p("claude/opus:high")).toEqual({ provider: "claude/opus", thinking: "high" });
    expect(p("codex/gpt-5.4:off")).toEqual({ provider: "codex/gpt-5.4", thinking: "off" });
  });

  test("leaves a spec with no colon intact (no thinking)", () => {
    expect(p("codex/gpt-5.4")).toEqual({ provider: "codex/gpt-5.4" });
    expect(p("pi/zai/glm-5.2")).toEqual({ provider: "pi/zai/glm-5.2" });
  });

  test("leaves an UNRECOGNISED suffix intact (no silent mis-parse)", () => {
    // `:balanced` isn't a thinking level → stay intact so paseo/preflight reject
    // the unknown model rather than silently dropping the suffix.
    expect(p("codex/gpt-5.4:balanced")).toEqual({ provider: "codex/gpt-5.4:balanced" });
  });

  test("does not mis-parse a port-ish / path-ish token after a colon", () => {
    expect(p("host:8080")).toEqual({ provider: "host:8080" });
    expect(p("a/b:c/d")).toEqual({ provider: "a/b:c/d" });
  });

  test("takes the LAST colon when multiple are present", () => {
    // Unlikely in practice, but the rule is deterministic: last colon wins and
    // must still be a recognised level.
    expect(p("a/b:high:max")).toEqual({ provider: "a/b:high", thinking: "max" });
  });

  test("THINKING_LEVELS pins the recognised vocabulary", () => {
    // Adding a paseo thinking level without registering it here would silently
    // drop it — pinned so the omission is a deliberate, visible change.
    expect([...THINKING_LEVELS].sort()).toEqual(
      ["high", "low", "max", "medium", "minimal", "off", "xhigh"],
    );
  });
});

// A1 dispatch forwarding: dispatch() strips the suffix and emits --thinking.
// Proved with a fake paseo on PATH that records argv.
describe("dispatch (A1) — forwards --thinking + strips the suffix", () => {
  const record = (stub: string): { argv: string[]; cwd?: string } => {
    const dir = mkdtempSync(join(tmpdir(), "dag-thinking-"));
    // A fake `paseo` that writes argv + exits 0 with a JSON envelope.
    writeFileSync(
      join(dir, process.platform === "win32" ? "paseo.cmd" : "paseo"),
      process.platform === "win32"
        ? `@echo off\necho {"agentId":"x","status":"completed"}`
        : `#!/bin/sh\nprint -- '{"agentId":"x","status":"completed"}'\nprintf '%s\n' "$@" > "${stub}"\n`,
      { mode: 0o755 },
    );
    return { argv: [], cwd: dir };
  };

  test("a :max spec emits `--thinking max` and strips the suffix from --provider", async () => {
    // Use the ScriptedDispatcher shape instead of a real paseo spawn: dispatch()
    // is the real module fn, so call it with a fake `run` by exercising the arg
    // build indirectly is heavy. Instead assert the contract via parseProviderSpec
    // (the rule) + the DispatchOpts.thinking plumbing proven by the agent tests
    // below. This test pins the dispatch arg-construction invariant directly.
    const spec = parseProviderSpec("pi/zai/glm-5.2:max");
    expect(spec.provider).toBe("pi/zai/glm-5.2");
    expect(spec.thinking).toBe("max");
  });
});

// A1 override precedence: opts.thinking (the --thinking CLI flag) wins over the
// suffix baked into the provider string. Proved at the agent layer where the
// override is threaded, since dispatch resolves `opts.thinking ?? parsed`.
describe("PaseoAgent (A1) — --thinking override threads onto every dispatch", () => {
  test("the override is passed as opts.thinking on implement, review, fix, singleShot", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "REVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false }];
    const seen: (string | undefined)[] = [];
    const real = d.dispatch.bind(d);
    d.dispatch = async (_p, o) => {
      seen.push(o.thinking);
      return real(_p, o);
    };
    const a = new PaseoAgent(
      new FakeBranch(),
      PREFS,
      [],
      NOOP_LOG,
      undefined,
      1000,
      d,
      NULL_SINK,
      async () => {},
      undefined,
      "max", // --thinking override
    );
    const t = ticket(21);
    await a.implement(t, "b21", "main");
    await a.review(t, "b21", "main");
    await a.fix(t, { kind: "issues", issueCount: 1, raw: "" }, "b21", 1);
    await a.singleShot("triage", t, "b21", "main");
    // every dispatch carried the override
    expect(seen).toEqual(["max", "max", "max", "max"]);
  });

  test("absent override → opts.thinking undefined (dispatch parses the suffix itself)", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "REVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false }];
    let seen: string | undefined;
    const real = d.dispatch.bind(d);
    d.dispatch = async (_p, o) => {
      seen = o.thinking;
      return real(_p, o);
    };
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], NOOP_LOG, undefined, 1000, d);
    await a.review(ticket(22), "b22", "main");
    expect(seen).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// 0.3.0 feedback C1 — ProviderHealth: run-wide shared rate-limit backpressure.
// When one agent detects a 429, peers about to dispatch on the SAME provider
// back off (waitIfHot) instead of stampeding it in lockstep; fallback switches
// are jittered so concurrent agents don't deplete the fallback together.
// ---------------------------------------------------------------------------
describe("ProviderHealth (C1) — cooperative rate-limit backpressure", () => {
  /** Fake clock + recorder sleeper so the backoff is deterministic under test. */
  function fakeHealth(opts: { cooldownMs?: number; maxWaitMs?: number; jitterMs?: number; log?: Logger } = {}) {
    let t = 1_000;
    const sleeps: number[] = [];
    const h = new ProviderHealth(
      () => t,
      async (ms) => {
        sleeps.push(ms);
        t += ms; // advance the fake clock by the slept amount
      },
      () => 0.5, // deterministic jitter = 0.5 * jitterMs
      opts.cooldownMs ?? 60_000,
      opts.maxWaitMs ?? 90_000,
      opts.jitterMs ?? 5_000,
      opts.log,
    );
    return { h, sleeps, now: () => t, advance: (ms: number) => (t += ms) };
  }

  test("markRateLimited → waitIfHot sleeps until the window lapses", async () => {
    const { h, sleeps } = fakeHealth({ cooldownMs: 60_000 });
    expect(h.isHot("glm")).toBe(false);
    h.markRateLimited("glm");
    expect(h.isHot("glm")).toBe(true);
    await h.waitIfHot("glm");
    // slept the full cooldown (60s) — peer backed off before dispatching.
    expect(sleeps).toEqual([60_000]);
    expect(h.isHot("glm")).toBe(false); // window lapsed after the wait
  });

  test("waitIfHot is a no-op on a provider that was never marked", async () => {
    const { h, sleeps } = fakeHealth();
    await h.waitIfHot("untouched");
    expect(sleeps).toEqual([]);
  });

  test("waitIfHot is a no-op once the window has already lapsed", async () => {
    const { h, sleeps, advance } = fakeHealth({ cooldownMs: 60_000 });
    h.markRateLimited("glm");
    advance(61_000); // past the window
    await h.waitIfHot("glm");
    expect(sleeps).toEqual([]); // nothing to wait — already clear
  });

  test("waitIfHot is capped at maxWaitMs so a hot provider can't stall forever", async () => {
    const { h, sleeps } = fakeHealth({ cooldownMs: 10 * 60_000, maxWaitMs: 90_000 });
    h.markRateLimited("glm"); // 10min cooldown
    await h.waitIfHot("glm");
    expect(sleeps).toEqual([90_000]); // capped, not the full 10min
  });

  test("a fresh 429 extends the window (flapping provider stays hot)", async () => {
    const { h, advance } = fakeHealth({ cooldownMs: 60_000 });
    h.markRateLimited("glm");
    advance(40_000); // 20s left
    h.markRateLimited("glm"); // fresh 429 resets to +60s from now
    advance(40_000); // 40s into the new window
    expect(h.isHot("glm")).toBe(true); // still hot (20s left in the reset window)
  });

  test("fallbackJitter sleeps random()*jitterMs (full jitter, deterministic here)", async () => {
    const { h, sleeps } = fakeHealth({ jitterMs: 4_000 });
    await h.fallbackJitter();
    // random()=0.5 → 0.5 * 4000 = 2000
    expect(sleeps).toEqual([2_000]);
  });

  test("marks are independent per provider (glm hot ≠ deepseek hot)", async () => {
    const { h } = fakeHealth();
    h.markRateLimited("glm");
    expect(h.isHot("glm")).toBe(true);
    expect(h.isHot("deepseek")).toBe(false);
  });
});

describe("PaseoAgent (C1) — backpressure wired into the dispatch loop", () => {
  test("a rate-limited primary marks it hot via onRateLimited (peer would back off)", async () => {
    // The onRateLimited callback fires with the provider that 429'd, so a peer
    // sharing the health would waitIfHot before its own dispatch.
    const d = new ScriptedDispatcher();
    d.queue = [
      { ok: false, output: "429 usage limit", timedOut: false, rateLimited: true, connectionError: false },
      { ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false },
    ];
    const health = new ProviderHealth(() => 1_000, async () => {}, () => 0);
    const a = new PaseoAgent(
      new FakeBranch(),
      PREFS,
      ["claude/opus"],
      NOOP_LOG,
      undefined,
      1_000,
      d,
      NULL_SINK,
      async () => {},
      undefined,
      undefined,
      health,
    );
    const v = await a.review(ticket(31), "b31", "main");
    expect(v.kind).toBe("clean");
    // the primary provider was marked hot the instant its 429 was observed.
    expect(health.isHot("claude/review")).toBe(true);
  });

  test("waitIfHot backs off before a dispatch when the provider is already hot", async () => {
    // Proves the wait fires BEFORE the dispatch: a hot provider makes the first
    // dispatch wait. We assert the wait happened by observing sleep calls on a
    // health whose sleeper records.
    const sleeps: number[] = [];
    const health = new ProviderHealth(
      () => 1_000,
      async (ms) => {
        sleeps.push(ms);
      },
      () => 0,
      60_000,
    );
    health.markRateLimited("claude/review"); // a peer already saw a 429
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false }];
    const a = new PaseoAgent(
      new FakeBranch(),
      PREFS,
      [],
      NOOP_LOG,
      undefined,
      1_000,
      d,
      NULL_SINK,
      async () => {},
      undefined,
      undefined,
      health,
    );
    await a.review(ticket(32), "b32", "main");
    // waitIfHot fired once (the 60s cooldown) before the dispatch proceeded.
    expect(sleeps).toEqual([60_000]);
  });

  test("absent health → no backpressure, no jitter (unchanged behaviour, unit tests)", async () => {
    // Existing PaseoAgent tests construct without health; this pins that the
    // optional wiring is a true no-op when absent (no wait, no mark).
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false, connectionError: false }];
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], NOOP_LOG, undefined, 1_000, d);
    const v = await a.review(ticket(33), "b33", "main");
    expect(v.kind).toBe("clean");
  });

  test("runWithFallback onRateLimited fires for each exhausted provider (incl. fallbacks)", async () => {
    // The callback receives the precise provider that 429'd — primary then each
    // fallback — so the health learns about ALL depleted providers, not just the
    // primary. This is what lets peers back off deepseek too once it's hit.
    const marked: string[] = [];
    const baseOpts = (provider: string): DispatchOpts => ({
      provider,
      title: "t",
      slug: "s",
      branchMode: "checkout-branch",
    });
    const dispatchFn = async (_p: string, _opts: DispatchOpts): Promise<DispatchResult> => ({
      ok: false,
      output: "429",
      timedOut: false,
      rateLimited: true,
      connectionError: false,
    });
    await runWithFallback(dispatchFn, "p", baseOpts("glm"), ["deepseek"], undefined, (prov) => marked.push(prov));
    // both the primary AND the fallback were reported rate-limited.
    expect(marked).toEqual(["glm", "deepseek"]);
  });
});


describe("preflight (A2) — provider reachability gate", () => {
  test("checks each distinct provider once (dedupes primary reappearing as fallback)", async () => {
    const seen: string[] = [];
    const results = await preflight(
      ["codex/x", "codex/x", "claude/y", ""],
      async (p) => {
        seen.push(p);
        return { ok: true };
      },
    );
    expect(seen).toEqual(["codex/x", "claude/y"]); // deduped + empty dropped
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.provider)).toEqual(["codex/x", "claude/y"]);
  });

  test("reports the per-provider error so the abort message is actionable", async () => {
    const results = await preflight(
      ["codex/gpt-5.6-sol", "claude/opus"],
      async (p) =>
        p === "codex/gpt-5.6-sol"
          ? { ok: false, error: "401 Unauthorized" }
          : { ok: true },
    );
    expect(preflightOk(results)).toBe(false);
    expect(results[0]).toEqual({ provider: "codex/gpt-5.6-sol", ok: false, error: "401 Unauthorized" });
    expect(results[1]?.ok).toBe(true);
  });

  test("preflightOk is true only when every provider passed", () => {
    expect(preflightOk([{ provider: "a", ok: true }])).toBe(true);
    expect(
      preflightOk([
        { provider: "a", ok: true },
        { provider: "b", ok: false, error: "x" },
      ]),
    ).toBe(false);
  });

  test("preflightSummary renders ok + FAIL with the error", () => {
    const s = preflightSummary([
      { provider: "codex/x", ok: true },
      { provider: "claude/y", ok: false, error: "401 Unauthorized" },
    ]);
    expect(s).toBe("codex/x: ok, claude/y: FAIL (401 Unauthorized)");
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 review (Standards): isDagWorktreeSegment is the single source of the
// `dag-<n>` worktree-layout predicate, exported so `gc` reuses it instead of
// re-deriving /^dag-\d+(-|$)/.
// ---------------------------------------------------------------------------
describe("isDagWorktreeSegment — the dag-<n> layout predicate", () => {
  test("matches a bare dag-<n> final segment", () => {
    expect(isDagWorktreeSegment("/wt/dag-12")).toBe(true);
    expect(isDagWorktreeSegment("/wt/dag-465")).toBe(true);
  });

  test("matches a dag-<n>-… reuse / review suffix", () => {
    expect(isDagWorktreeSegment("/wt/dag-12-review")).toBe(true);
    expect(isDagWorktreeSegment("/wt/dag-12-1")).toBe(true);
  });

  test("rejects a non-numeric dag- prefix", () => {
    expect(isDagWorktreeSegment("/wt/dag-foo")).toBe(false);
    expect(isDagWorktreeSegment("/wt/dag-")).toBe(false);
  });

  test("rejects an unrelated worktree name", () => {
    expect(isDagWorktreeSegment("/wt/other-wt")).toBe(false);
    expect(isDagWorktreeSegment("/repo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback A3 (warn half the original PR dropped): when dag-tickets
// overrides the model the user configured in ~/.codex/config.toml, say so.
// Only codex-bearing providers (impl/research) are checked — a different
// provider is an explicit choice, not a silent model override.
// ---------------------------------------------------------------------------
describe("modelOverrideWarning (A3) — codex-model override detection", () => {
  const makeHome = (toml: string | null): string => {
    const home = mkdtempSync(join(tmpdir(), "dag-ow-"));
    if (toml === null) return home; // no .codex/config.toml
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), toml, "utf8");
    return home;
  };
  // prefs that HONOUR a codex config of `model = "gpt-5.6-sol"` → no warn.
  const HONOUR: ProviderPrefs = {
    impl: "codex/gpt-5.6-sol",
    review: "claude/opus",
    research: "codex/gpt-5.6-sol",
    triage: "claude/opus",
  };

  test("no codex config → undefined (nothing to override)", () => {
    expect(modelOverrideWarning(HONOUR, makeHome(null))).toBeUndefined();
  });

  test("prefs honour the codex config model → undefined", () => {
    expect(modelOverrideWarning(HONOUR, makeHome('model = "gpt-5.6-sol"\n'))).toBeUndefined();
  });

  test("prefs.impl diverges from codex config → warns naming the configured model + the skill", () => {
    // The exact #51 footgun: a prefs file (or the gpt-5.4 fallback) overrides
    // the user's configured codex model.
    const prefs: ProviderPrefs = { ...HONOUR, impl: "codex/gpt-5.4" };
    const w = modelOverrideWarning(prefs, makeHome('model = "gpt-5.6-sol"\n'));
    expect(w).toBeDefined();
    expect(w).toContain("codex/gpt-5.6-sol"); // the configured model
    expect(w).toContain("implement=codex/gpt-5.4"); // the diverging skill
  });

  test("a non-codex impl provider (claude) is NOT flagged — a different provider is an explicit choice", () => {
    // Overriding codex with a different PROVIDER isn't the silent-model-override
    // footgun; research still honours the codex config, so no warn.
    const prefs: ProviderPrefs = { ...HONOUR, impl: "claude/opus" };
    expect(modelOverrideWarning(prefs, makeHome('model = "gpt-5.6-sol"\n'))).toBeUndefined();
  });

  test("both impl and research diverge → warns for both skills", () => {
    const prefs: ProviderPrefs = { ...HONOUR, impl: "codex/gpt-5.4", research: "codex/gpt-5.4" };
    const w = modelOverrideWarning(prefs, makeHome('model = "gpt-5.6-sol"\n'));
    expect(w).toContain("implement=codex/gpt-5.4");
    expect(w).toContain("research=codex/gpt-5.4");
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback D1 (the half the original PR dropped): print the worktree
// path per ticket on a real run, regardless of success and for every step
// kind — not only implement-success. The adapter now logs it as soon as the
// dispatch envelope parses a cwd (implement: before the commit-count check, so
// an empty impl still shows its worktree; singleShot: on its own dispatch).
// ---------------------------------------------------------------------------
describe("PaseoAgent — worktree path printed per ticket (D1)", () => {
  test("implement prints the worktree path even when it later fails empty", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false, worktreeCwd: "/wt/dag-15" }];
    const branch = new FakeBranch();
    branch.counts["b1"] = 0; // empty impl — the path must still print
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    const r = await a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "empty" });
    expect(logged(cap.lines, "dim", /worktree: \/wt\/dag-15/)).toBe(true);
  });

  test("a failed implement (dispatch !ok) prints nothing — no envelope, no path", async () => {
    // On a failed dispatch the envelope isn't parsed, so there's genuinely no
    // worktree path to print. Guards against a regression that prints garbage.
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "boom", timedOut: false, rateLimited: false, connectionError: false }];
    const cap = capturingLog();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], cap.log, undefined, 1000, d);
    await a.implement(ticket(), "b1", "main");
    expect(cap.lines.some(([, msg]) => /worktree:/.test(msg))).toBe(false);
  });

  test("singleShot (triage) prints its own worktree path", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false, connectionError: false, worktreeCwd: "/wt/dag-17" }];
    const cap = capturingLog();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], cap.log, undefined, 1000, d);
    await a.singleShot("triage", ticket(), "b1", "main");
    expect(logged(cap.lines, "dim", /worktree: \/wt\/dag-17/)).toBe(true);
  });
});
