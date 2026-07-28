import { test, expect, describe } from "bun:test";
import {
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
  counts: Record<string, number> = {};
  async cleanBranch(branch: string): Promise<void> {
    this.cleaned.push(branch);
  }
  async deleteBranch(branch: string): Promise<void> {
    this.deleted.push(branch);
  }
  async commitCount(_base: string, branch: string): Promise<number> {
    return this.counts[branch] ?? 3;
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
        rateLimited: false,
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
    d.queue = [{ ok: false, output: "429 usage limit", timedOut: false, rateLimited: true }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "rate-limited" });
  });

  test("timed-out dispatch (not rate-limited) → reason 'timeout'", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "", timedOut: true, rateLimited: false }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "timeout" });
  });

  test("failed dispatch (neither) → reason 'failed'", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "boom", timedOut: false, rateLimited: false }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "failed" });
  });

  test("ok dispatch but zero commits → reason 'empty'", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false }];
    const branch = new FakeBranch();
    branch.counts["b1"] = 0;
    const cap = capturingLog();
    const a = new PaseoAgent(branch, PREFS, [], cap.log, undefined, 1000, d);
    const r = await a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: false, commits: 0, reason: "empty" });
  });

  test("ok dispatch with commits → ok:true", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: true, output: "", timedOut: false, rateLimited: false }];
    const r = await agent(d).a.implement(ticket(), "b1", "main");
    expect(r).toEqual({ ok: true, commits: 3 });
  });
});

describe("PaseoAgent.review", () => {
  test("failed dispatch → { kind: 'unknown' } and a warn is logged", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [{ ok: false, output: "agent exploded", timedOut: false, rateLimited: false }];
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
    d.queue = [{ ok: false, output: "", timedOut: true, rateLimited: false }];
    const cap = capturingLog();
    const a = new PaseoAgent(new FakeBranch(), PREFS, [], cap.log, undefined, 1000, d);
    const v = await a.review(ticket(), "b1", "main");
    expect(v.kind).toBe("unknown");
    expect(logged(cap.lines, "warn", /review agent failed \(timeout\)/)).toBe(true);
  });

  test("ok dispatch with REVIEW_VERDICT: CLEAN → parsed clean", async () => {
    const d = new ScriptedDispatcher();
    d.queue = [
      { ok: true, output: "Looks good.\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false },
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
      { ok: false, output: "429 usage limit reached", timedOut: false, rateLimited: true },
      { ok: true, output: "ok\nREVIEW_VERDICT: CLEAN", timedOut: false, rateLimited: false },
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
      return { ok: !rl, output: opts.provider, timedOut: false, rateLimited: rl };
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
      rateLimited: true,
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
      return { ok: false, output: "", timedOut: false, rateLimited: true };
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
      return { ok: true, output: "done", timedOut: false, rateLimited: false };
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
