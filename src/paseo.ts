import { run } from "./shell.ts";
import type { ReviewVerdict, Ticket } from "./types.ts";
import type {
  AgentPort,
  BranchPort,
  Dispatcher,
  DispatchOpts,
  DispatchResult,
  EventSink,
  ImplFailReason,
  ImplResult,
  Logger,
  ReconcileResult,
  StepResult,
} from "./ports.ts";
import { normalizeBase, remoteRef } from "./ports.ts";
import { parseReviewVerdict } from "./parse.ts";
import { EVT } from "./events.ts";
import { NULL_SINK } from "./ports.ts";
import { branchFor } from "./gitgh.ts";

/**
 * Provider selection mirrors Paseo's `orchestration-preferences.json`:
 * impl/research use the workhorse, review/triage use a different provider so
 * the reviewer catches the implementer's blind spots. When the prefs file is
 * absent we fall back to sensible category defaults.
 */
export interface ProviderPrefs {
  impl: string;
  review: string;
  research: string;
  triage: string;
}

const FALLBACK_PREFS: ProviderPrefs = {
  impl: "codex/gpt-5.4",
  review: "claude/opus",
  research: "codex/gpt-5.4",
  triage: "claude/opus",
};

export async function loadPrefs(): Promise<ProviderPrefs> {
  const home = process.env.HOME ?? "";
  if (!home) return { ...FALLBACK_PREFS };
  try {
    const f = Bun.file(`${home}/.paseo/orchestration-preferences.json`);
    if (await f.exists()) {
      const j = (await f.json()) as { providers?: Record<string, string> };
      const p = j.providers ?? {};
      return {
        impl: p.impl ?? FALLBACK_PREFS.impl,
        review: p.audit ?? FALLBACK_PREFS.review,
        research: p.research ?? FALLBACK_PREFS.research,
        triage: p.planning ?? FALLBACK_PREFS.triage,
      };
    }
  } catch {
    /* unreadable prefs → fall back */
  }
  return { ...FALLBACK_PREFS };
}

const DEFAULT_RUN_MS = 60 * 60 * 1000; // 60 min per agent run

/** Grace margin so `paseo run`'s own `--wait-timeout` fires before run()'s
 *  hard kill: proportional to `waitMs`, floored at 1s and capped at 60s. Capped
 *  at 60s so a real long run (default 60min) keeps the unchanged prod margin;
 *  a tiny `waitMs` (e.g. the e2e suite via DAG_AGENT_TIMEOUT_MS) gets a tiny
 *  grace so the kill lands in ~ms instead of waiting a flat 60s. */
const dispatchGraceMs = (waitMs: number): number => Math.min(60_000, Math.max(1_000, waitMs));

/** Interval between `paseo logs` reads while waiting for the agent's transcript
 *  to stop changing. Read at call time (not module load) so a caller can adjust
 *  it via env between dispatches — prod leaves it unset → 2000ms (unchanged). */
const paseoLogPollMs = (): number => Number(process.env.DAG_PASEO_LOG_POLL_MS ?? 2000);

function msToDuration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
}

const RATE_LIMIT_RE = /\b429\b|usage limit reached|rate[ -]?limit|quota|too many requests/i;

/** Detect provider rate-limiting / quota exhaustion in agent output. */
export function isRateLimited(output: string): boolean {
  return RATE_LIMIT_RE.test(output);
}

/**
 * Relay/stream transport failure signatures. A transport blip (TCP reset,
 * dropped SSE stream, undici `fetch failed`, …) makes `paseo run` exit
 * non-zero even though the paseo daemon auto-recovers the agent. Such a
 * failure is transient — a backoff-and-retry clears it — so it's classified
 * distinctly from a hard agent failure (`implement-failed`). Mirrors the
 * shape of {@link RATE_LIMIT_RE}: a case-insensitive alternation over the
 * real errno codes / human phrases the relay prints.
 *
 * Includes `ETIMEDOUT` (the socket errno): a connect/read timeout is a
 * transport failure and belongs here. It can overlap with the wall-clock
 * {@link DispatchResult.timedOut} path (`agent-timeout`); both are transient,
 * so when both fire the only difference is the post-mortem label, not the
 * retry decision — see {@link implFailReason} for the precedence.
 */
const CONNECTION_ERROR_RE =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|\bETIMEDOUT\b|fetch failed|socket hang up|stream (?:closed|ended|aborted)|connection (?:reset|refused|closed|aborted)/i;

/** Detect a relay/stream transport failure in agent output. */
export function isConnectionError(output: string): boolean {
  return CONNECTION_ERROR_RE.test(output);
}

/**
 * Map a failed dispatch to its implement-failure reason, in precedence order:
 * rate-limited → connection-error → timeout → failed.
 *
 * - rate-limited first: `dispatchWithFallback` already retried across
 *   providers, so a surviving rate-limit is the dominant signal.
 * - connection-error before timeout: a transport reset that also burned the
 *   wall clock is labelled by its root cause. Both reasons are transient, so
 *   the retry decision is identical either way — this only sets the
 *   post-mortem label.
 *
 * Extracted from `PaseoAgent.implement` so the rule is named and directly
 * unit-testable (the ternary there had grown to a 4-way cascade).
 */
export function implFailReason(r: {
  rateLimited: boolean;
  connectionError: boolean;
  timedOut: boolean;
}): ImplFailReason {
  return r.rateLimited
    ? "rate-limited"
    : r.connectionError
      ? "connection-error"
      : r.timedOut
        ? "timeout"
        : "failed";
}

/**
 * Run one Paseo agent in a fresh worktree. `paseo run --json --new-workspace
 * worktree` creates the worktree + agent and blocks until the agent finishes.
 *
 * `paseo run`'s stdout is NOT the agent's answer — it's a status envelope
 * (`{agentId, status, provider, cwd, title}`). The agent's actual answer text
 * lives in `paseo logs <agentId>`. We fetch it with `--filter text` and strip
 * `[User]` lines so the prompt (which echoes the literal `REVIEW_VERDICT:`
 * instruction tokens) cannot false-match the verdict parser; the parser also
 * takes the LAST verdict match as a second line of defence.
 */
export async function dispatch(prompt: string, opts: DispatchOpts): Promise<DispatchResult> {
  const waitMs = opts.timeoutMs ?? DEFAULT_RUN_MS;
  const args = [
    "paseo",
    "run",
    "--json",
    "--provider",
    opts.provider,
    "--title",
    opts.title,
    "--worktree-slug",
    opts.slug,
    "--new-workspace",
    "worktree",
    "--wait-timeout",
    msToDuration(waitMs),
  ];
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.branchMode === "branch-off") {
    args.push("--worktree-mode", "branch-off");
    if (opts.newBranch) args.push("--new-branch", opts.newBranch);
    if (opts.base) args.push("--base", opts.base);
  } else {
    args.push("--worktree-mode", "checkout-branch");
    if (opts.branch) args.push("--branch", opts.branch);
  }
  args.push(prompt);

  const r = await run(args, { cwd: opts.cwd, timeoutMs: waitMs + dispatchGraceMs(waitMs) });
  let status = r.ok ? "completed" : "failed";
  let output = r.stdout;
  if (r.ok) {
    try {
      const j = JSON.parse(r.stdout) as { agentId?: string; status?: string };
      if (typeof j.status === "string") status = j.status;
      const agentId = j.agentId;
      if (agentId) {
        // The paseo log store can lag behind agent completion: reading once
        // right after `paseo run` returns sometimes captures a partial
        // transcript (missing the agent's final lines — e.g. REVIEW_VERDICT).
        // Poll until the filtered output stops changing so we capture the full
        // text instead of truncating mid-generation.
        let prev = "";
        for (let attempt = 0; attempt < 4; attempt++) {
          const lr = await run(["paseo", "logs", agentId, "--filter", "text"], {
            cwd: opts.cwd,
            timeoutMs: 60_000,
          });
          if (!lr.ok) break;
          const cur = lr.stdout
            .split(/\r?\n/)
            .filter((line) => !/^\[User\]/.test(line))
            .join("\n");
          output = cur;
          if (cur.length > 0 && cur === prev) break;
          prev = cur;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, paseoLogPollMs()));
        }
      }
    } catch {
      /* non-JSON stdout (older paseo) → keep the status envelope as output */
    }
  }
  const rateLimited = isRateLimited(output);
  // Transport failures (ECONNRESET / fetch failed / stream closed) classically
  // land on STDERR as an uncaught stack trace, not in the status envelope on
  // stdout — and on the !r.ok path `output` is stdout only (the JSON/log
  // polling above is skipped). Scan both streams so a relay blip reported to
  // stderr is still classified transient instead of falling through to a
  // terminal `implement-failed` (issue #39). rateLimited stays stdout-only to
  // avoid widening its (working) detection surface here.
  const connectionError = isConnectionError(output) || isConnectionError(r.stderr);
  return {
    ok: r.ok && (status === "completed" || status === "idle"),
    output,
    timedOut: r.timedOut,
    rateLimited,
    connectionError,
  };
}

/**
 * The rate-limit fallback loop — single source of truth shared by the real
 * {@link Dispatcher} (bound to {@link dispatch}) and by test fakes bound to a
 * scripted dispatch. Running the real loop over a fake dispatch is what lets
 * the retry ordering (onSwitch per fallback, stop on first success, skip the
 * primary if it reappears in the fallback list) be exercised without a
 * `paseo run`.
 *
 * `onSwitch` runs before each retry so the caller can reset worktree/branch
 * state (branch-off retries need a clean branch). A result that is still
 * rate-limited after exhausting fallbacks is marked !ok.
 */
export async function runWithFallback(
  dispatchFn: Dispatcher["dispatch"],
  prompt: string,
  opts: DispatchOpts,
  fallbacks: string[],
  onSwitch?: (nextProvider: string) => Promise<void>,
): Promise<DispatchResult> {
  let result = await dispatchFn(prompt, opts);
  for (const fb of fallbacks) {
    if (!result.rateLimited) break;
    if (fb === opts.provider) continue;
    if (onSwitch) await onSwitch(fb);
    result = await dispatchFn(prompt, { ...opts, provider: fb });
  }
  if (result.rateLimited) result.ok = false;
  return result;
}

/**
 * Real {@link Dispatcher}: `dispatch` is the module-level run (stable-log
 * polling + JSON-envelope parsing); `dispatchWithFallback` binds that same
 * dispatch into {@link runWithFallback}, so prod behaviour is byte-identical to
 * the pre-injection implementation. Frozen so the default wiring is constant.
 * Passed as the default dispatcher to {@link PaseoAgent}.
 */
export const realDispatcher: Dispatcher = Object.freeze({
  dispatch,
  dispatchWithFallback: (
    prompt: string,
    opts: DispatchOpts,
    fallbacks: string[],
    onSwitch?: (nextProvider: string) => Promise<void>,
  ): Promise<DispatchResult> => runWithFallback(dispatch, prompt, opts, fallbacks, onSwitch),
});

// ---------------------------------------------------------------------------
// Prompt builders. The receiving Paseo agent starts with zero context, so each
// prompt is a self-contained briefing (per the paseo-handoff principle).
// ---------------------------------------------------------------------------

export function implementPrompt(t: Ticket, branch: string): string {
  return `You are implementing one GitHub issue in isolation. The mattpocock skills (/implement, /tdd, /code-review) are available in this session — use /implement to drive the work.

## Task
Implement issue #${t.number}: ${t.title}
Issue URL: ${t.url}

## Issue body
${t.body || "(no body)"}

## How to work
- Use /tdd at the repo's pre-agreed test seams where possible.
- Run typechecking regularly, single test files regularly, and the full test suite once at the end.
- Commit your work to the current branch (${branch}) with clear messages.
- When done, push the branch: \`git push -u origin ${branch}\`.

## Constraints
- DO NOT open a pull request — the orchestrator creates and merges the PR.
- DO NOT modify the issue tracker (no comments, label changes, or closes).
- Stay within the issue's scope; do not gold-plate.

Report a short summary of what you implemented and the final test result.`;
}

export function reviewPrompt(t: Ticket, baseRef: string): string {
  return `You are reviewing a fresh implementation in isolation. The /code-review skill is available — run it.

## Task
Review the work for issue #${t.number}: ${t.title} on the current branch.
Fixed point for the diff: \`origin/${baseRef}\` (the repo's default branch).

Run /code-review with that fixed point. Report findings under the Standards and Spec axes exactly as the skill prescribes.

## Verdict (required)
After your full report, your VERY LAST line must be EXACTLY one of these (copy verbatim, on its own line, nothing after it):
REVIEW_VERDICT: CLEAN
REVIEW_VERDICT: ISSUES 3

Replace 3 with the actual count of actionable findings. Do not embed the verdict inside a sentence or wrap it in markdown — it must be a standalone line so the orchestrator can parse it.

Do not modify any code. Do not commit or push.`;
}

export function fixPrompt(t: Ticket, reviewOutput: string, branch: string): string {
  return `You are fixing code-review findings on an in-flight implementation. The /implement and /tdd skills are available.

## Task
Issue #${t.number}: ${t.title}. A code review on this branch produced the findings below. Address every actionable finding.

## Review findings
${reviewOutput.trim() || "(no detail extracted)"}

## How to work
- Run the relevant tests after each fix; run the full suite once before finishing.
- Commit to the current branch (${branch}) and push: \`git push\`.

## Constraints
- DO NOT open a pull request.
- Only fix what the review raised — no drive-by refactors.

Report what you changed and the final test result.`;
}

export function singleShotPrompt(skill: string, t: Ticket): string {
  // Unattended /triage runs without a maintainer to confirm destructive
  // actions, so it is fenced at the write boundary (ADR-0001): non-destructive
  // transitions + comments are fine; closing the issue or applying `wontfix`
  // is not — those need a human. Research writes a markdown asset, not the
  // tracker, so the fence only applies to triage.
  const triageBoundary = skill === "triage" ? `
## Write boundary (unattended)
There is no maintainer to confirm destructive actions.
- You MAY apply non-destructive state transitions (label \`needs-info\` or \`ready-for-agent\`) and post comments / agent briefs via \`gh\`.
- You MUST NOT close the issue or apply the \`wontfix\` label — irreversible. If you recommend \`wontfix\`, post the rationale as a comment and leave the issue open for a human.` : "";
  return `You are working one GitHub issue in isolation. The /${skill} skill is available — run it.

## Task
Issue #${t.number}: ${t.title}
Issue URL: ${t.url}

## Issue body
${t.body || "(no body)"}
${triageBoundary}

Run /${skill} for this issue. When finished, post any required comment/output on the issue via \`gh\` per the skill's contract, then report a one-paragraph summary.`;
}

const SLUG = (n: number) => `dag-${n}`;

/**
 * Does a worktree path's final segment belong to ticket `n`? The worktree
 * layout contract in ONE place: a ticket's agent lives in a dir whose final
 * segment is `dag-<n>` (implement/fix) or `dag-<n>-…` (`-review`, or a
 * `-<counter>` reuse suffix). Requiring the segment to equal {@link SLUG} or
 * continue with `-` disambiguates siblings — `dag-1` / `dag-1-review` never
 * match `dag-12-1` / `dag-11-review-1`. Co-located with {@link SLUG} so the
 * `dag-<n>` shape has a single source (it was previously re-derived here and
 * in the slug itself).
 */
const ownsWorktreeSegment = (dir: string, n: number): boolean => {
  const seg = dir.split("/").pop() ?? "";
  return seg === SLUG(n) || seg.startsWith(`${SLUG(n)}-`);
};

/**
 * Stop every running Paseo agent whose worktree belongs to ticket `ticketNumber`
 * (#20). Best-effort and never throws: a lookup that finds nothing (the
 * dispatch already finished — lost race) is a no-op; the caller still cleans
 * the branch. Worktree ownership is decided by {@link ownsWorktreeSegment}, the
 * single source of the `dag-<n>` layout.
 */
export async function stopRunningAgent(
  cwd: string | undefined,
  ticketNumber: number,
): Promise<void> {
  // Best-effort and never throws (its documented contract — relied on by
  // abort() and by the rate-limit fallback #40). `paseo` may be absent in
  // unit-test envs, unreachable, or emit malformed output; `run()` itself
  // throws on a missing executable (ENOENT), so the whole body is guarded.
  // Any of those → nothing to stop; the caller still proceeds.
  try {
    const r = await run(["paseo", "ls", "--json"], { cwd });
    if (!r.ok) return;
    let agents: Array<{ id?: string; status?: string; cwd?: string }> = [];
    try {
      const j = JSON.parse(r.stdout) as unknown;
      agents = Array.isArray(j) ? (j as typeof agents) : ((j as { agents?: typeof agents }).agents ?? []);
    } catch {
      return; // malformed `paseo ls` output — nothing to stop
    }
    const running = agents.filter(
      (a) => a.status === "running" && typeof a.cwd === "string" && ownsWorktreeSegment(a.cwd, ticketNumber),
    );
    for (const a of running) {
      if (!a.id) continue;
      try {
        await run(["paseo", "stop", a.id], { cwd });
      } catch {
        /* one bad stop doesn't skip the rest — matches stopInFlight's contract */
      }
    }
  } catch {
    /* paseo missing / spawn error → nothing to stop */
  }
}

/**
 * Real {@link AgentPort} adapter. Owns the worktree-cleanup invariant (each
 * step starts on a clean branch), the rate-limit fallback chain, and verdict
 * parsing — so the lifecycle orchestrator branches on outcomes, never on
 * dispatch mechanics. The stable-log polling that guarantees a complete
 * transcript lives inside {@link dispatch}.
 *
 * Dispatch is injected via {@link Dispatcher}: prod wiring passes the default
 * {@link realDispatcher} (byte-identical to a bare module call), while focused
 * unit tests pass a fake that returns scripted {@link DispatchResult}s — so the
 * dispatch-result → {@link ImplResult}.reason map and the adapter-originated
 * unknown-verdict path are covered without spawning a process.
 */
export class PaseoAgent implements AgentPort {
  constructor(
    private readonly branch: BranchPort,
    private readonly prefs: ProviderPrefs,
    private readonly fallbacks: string[],
    private readonly log: Logger,
    private readonly cwd?: string,
    private readonly timeoutMs: number = DEFAULT_RUN_MS,
    private readonly dispatcher: Dispatcher = realDispatcher,
    // Defaulted (not required like RunContext.events) for two reasons: TS forbids
    // a required param after optional ones, and the dispatch-mechanics tests
    // above intentionally stay focused on dispatch — they rely on this NULL_SINK
    // default. Prod wiring and the event-asserting tests pass an explicit sink.
    private readonly events: EventSink = NULL_SINK,
    /** #20: stop the running Paseo agent for a ticket number. Injected so the
     *  abort path is unit-testable without `paseo ls|stop`; defaults to the
     *  module-level {@link stopRunningAgent} bound to this agent's cwd. */
    private readonly stopAgent: (ticketNumber: number) => Promise<void> = (n) =>
      stopRunningAgent(this.cwd, n),
  ) {}

  /**
   * #40: best-effort stop of the ticket's running agent. Swallowed so a stop
   *  failure (paseo unreachable, lost race, a throwing injected fake) never
   *  blocks the caller — the rate-limit fallback / exit cleanup still proceeds.
   *  Mirrors the stop swallow in {@link abort}.
   */
  private async tryStop(t: Ticket): Promise<void> {
    try {
      await this.stopAgent(t.number);
    } catch {
      /* best-effort: a stop failure must not block the fallback or the exit */
    }
  }

  /**
   * #40: the shared half of every rate-limit fallback switch — log the switch,
   *  emit `provider.switch` (#19), stop the prior agent, and free the branch so
   *  the retry isn't blocked by a stale worktree. Stop-first ordering matters:
   *  cleaning a worktree a live agent is still editing races the agent (the
   *  orphan-agent accumulation #40 fixed). Extracted so the stop lives in ONE
   *  spot instead of being copy-pasted across review/fix (via onRateLimited)
   *  and implement (its inline callback, which adds deleteBranch after this).
   */
  private async switchAway(
    skill: string,
    from: string,
    next: string,
    t: Ticket,
    branch: string,
  ): Promise<void> {
    this.log("warn", `${skill} rate-limited; retrying on ${next}`, t.number);
    this.events.emit(EVT.PROVIDER_SWITCH, t.number, {
      skill,
      from,
      to: next,
      reason: "rate-limited",
    });
    await this.tryStop(t);
    await this.branch.cleanBranch(branch);
  }

  /**
   * Rate-limit-retry hook shared by review() and fix(): a thin binder over
   * {@link switchAway} that closes over the skill + the primary provider.
   * implement() builds its own callback (a branch-off retry also has to
   * deleteBranch before re-creating).
   */
  private onRateLimited(
    skill: string,
    fromProvider: string,
    t: Ticket,
    branch: string,
  ): (next: string) => Promise<void> {
    return (next) => this.switchAway(skill, fromProvider, next, t, branch);
  }

  /** Fetch `origin/<base>` and return the resolved remote-tracking ref, or
   *  `null` if the fetch failed (offline / no remote / non-fast-forward).
   *
   *  A dependent ticket that starts after its blocker merged in the same run
   *  must branch off a base containing that merge; only a confirmed fetch makes
   *  that merge visible at `origin/<base>`. On `null` the caller MUST fail the
   *  ticket rather than branch off a possibly-stale tip (issue #15). */
  private async resolveBranchOffBase(base: string): Promise<string | null> {
    const bare = normalizeBase(base);
    const ok = await this.branch.ensureBaseRefFresh(bare);
    return ok ? remoteRef(bare) : null;
  }

  async implement(t: Ticket, branch: string, base: string, signal?: AbortSignal): Promise<ImplResult> {
    // #34: observe the signal at the agent dispatch seam — an already-aborted
    // signal returns a cancelled outcome without issuing further agent work.
    if (signal?.aborted) return { ok: false, commits: 0, reason: "failed" };
    const baseRef = await this.resolveBranchOffBase(base);
    if (baseRef === null) {
      // Failing beats a silent stale branch-off: a dependent composing on
      // pre-merge code is exactly the CI/merge-conflict failure #15 prevents.
      this.log("warn", `could not fetch ${remoteRef(base)} (offline?); failing implement to avoid a stale branch-off`, t.number);
      return { ok: false, commits: 0, reason: "stale-base" };
    }
    const r = await this.dispatcher.dispatchWithFallback(
      implementPrompt(t, branch),
      {
        provider: this.prefs.impl,
        title: `implement #${t.number}`,
        slug: SLUG(t.number),
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        branchMode: "branch-off",
        newBranch: branch,
        base: baseRef,
      },
      this.fallbacks,
      async (next) => {
        // A branch-off retry must re-create the branch: switchAway (#40) stops
        // the prior agent + frees the worktree, then the branch is dropped so
        // git can re-create it (git forbids a branch in >1 worktree).
        await this.switchAway("implement", this.prefs.impl, next, t, branch);
        await this.branch.deleteBranch(branch);
      },
    );
    if (!r.ok) {
      return {
        ok: false,
        commits: 0,
        reason: implFailReason(r),
      };
    }
    // A rate-limited or empty agent still "completes" with no diff — count
    // against the fetched origin/<base> so a stale local main can't mask it.
    const commits = await this.branch.commitCount(baseRef, branch);
    if (commits === 0) return { ok: false, commits: 0, reason: "empty" };
    return { ok: true, commits };
  }

  /** Single review attempt. Stable-log polling in dispatch guarantees the full
   *  output, so an unparseable verdict means the agent genuinely didn't emit one. */
  async review(t: Ticket, branch: string, base: string): Promise<ReviewVerdict> {
    await this.branch.cleanBranch(branch);
    const r = await this.dispatcher.dispatchWithFallback(
      reviewPrompt(t, base),
      {
        provider: this.prefs.review,
        title: `review #${t.number}`,
        slug: `${SLUG(t.number)}-review`,
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        branchMode: "checkout-branch",
        branch,
      },
      this.fallbacks,
      this.onRateLimited("review", this.prefs.review, t, branch),
    );
    if (!r.ok) {
      this.log("warn", `review agent failed${r.timedOut ? " (timeout)" : ""}`, t.number);
      return { kind: "unknown", issueCount: 0, raw: r.output.slice(-800) };
    }
    return parseReviewVerdict(r.output);
  }

  async fix(t: Ticket, verdict: ReviewVerdict, branch: string, round: number): Promise<StepResult> {
    await this.branch.cleanBranch(branch);
    const r = await this.dispatcher.dispatchWithFallback(
      fixPrompt(t, verdict.raw, branch),
      {
        provider: this.prefs.impl,
        title: `fix #${t.number} r${round}`,
        slug: SLUG(t.number),
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        branchMode: "checkout-branch",
        branch,
      },
      this.fallbacks,
      this.onRateLimited("fix", this.prefs.impl, t, branch),
    );
    return { ok: r.ok, timedOut: r.timedOut, rateLimited: r.rateLimited };
  }

  async singleShot(skill: string, t: Ticket, branch: string, base: string, signal?: AbortSignal): Promise<StepResult> {
    // #34: observe the signal at the agent dispatch seam — an already-aborted
    // signal returns a cancelled outcome without issuing further agent work.
    if (signal?.aborted) return { ok: false, timedOut: false, rateLimited: false };
    const provider = skill === "research" ? this.prefs.research : this.prefs.triage;
    const baseRef = await this.resolveBranchOffBase(base);
    if (baseRef === null) {
      this.log("warn", `could not fetch ${remoteRef(base)} (offline?); failing ${skill} to avoid a stale branch-off`, t.number);
      return { ok: false, timedOut: false, rateLimited: false };
    }
    const r = await this.dispatcher.dispatch(singleShotPrompt(skill, t), {
      provider,
      title: `${skill} #${t.number}`,
      slug: SLUG(t.number),
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      branchMode: "branch-off",
      newBranch: branch,
      base: baseRef,
    });
    return { ok: r.ok, timedOut: r.timedOut, rateLimited: r.rateLimited };
  }

  providerLabel(skill: "implement" | "review" | "triage" | "research"): string {
    switch (skill) {
      case "implement":
        return this.prefs.impl;
      case "review":
        return this.prefs.review;
      case "triage":
        return this.prefs.triage;
      case "research":
        return this.prefs.research;
    }
  }

  /**
   * #20: abort an in-flight ticket — stop its running agent dispatch and clean
   * its worktree so a cascade-doomed dependent doesn't burn a full
   * implement→review→fix→CI cycle. Called by the scheduler when a dependent's
   * blocker settles failed/skipped. Best-effort and never throws: the scheduler
   * has ALREADY recorded the dependent cascade-skipped, so a stop/clean that
   * finds nothing (lost race) or fails leaves the persisted state correct.
   */
  async abort(t: Ticket): Promise<void> {
    try {
      await this.stopAgent(t.number);
    } catch {
      /* best-effort: scheduler already recorded cascade-skipped */
    }
    const branch = branchFor(t.number, t.title);
    try {
      await this.branch.cleanBranch(branch);
    } catch {
      /* a stale/missing worktree is fine — the agent stop is the load-bearing part */
    }
    this.log("warn", `cascade-abort: stopped agent + cleaned worktree ${branch}`, t.number);
  }

  /**
   * #40: stop every agent this run still has in flight — called on graceful
   *  exit (try/finally) and on signal/crash exit (SIGINT/SIGTERM,
   *  uncaughtException, unhandledRejection) so a stopped or crashed run doesn't
   *  orphan running agents on the worktree. Best-effort and never throws: a
   *  per-ticket stop failure doesn't skip the rest, and a stop of an
   *  already-stopped / never-started agent is a no-op. Worktrees are left
   *  intact (cleaned at the next step's cleanBranch, or harmless on resume) —
   *  this is the agent-only half of cleanup; {@link abort} does stop+clean for
   *  the cascade-doomed path. Snapshots the iterable so a concurrent settle
   *  mutating the caller's Set can't corrupt the iteration.
   */
  async stopInFlight(ticketNumbers: Iterable<number>): Promise<void> {
    for (const n of [...ticketNumbers]) {
      try {
        await this.stopAgent(n);
      } catch {
        /* best-effort: keep going so one bad stop doesn't leak the rest */
      }
    }
  }

  /**
   * #29: rebase an overlapping in-flight dependent onto its just-merged blocker.
   * Called when a blocker settles `done` while the dependent is still in flight
   * (it launched via overlap). `blockerTipSha` is the blocker tip the dependent
   * branched from; `base` is the integration branch whose `origin/<base>` now
   * holds the merge. Returns the outcome so the caller can fail the dependent on
   * conflict. Never throws: a failed fetch → `stale-base`; a conflicting rebase
   * → `overlap-rebase`; any throw → `overlap-rebase`. Best-effort like
   * {@link abort} — a missing worktree (lost race) is a clean success.
   *
   * Operational note: rebasing the branch checked out in a worktree while its
   * agent is mid-dispatch is racy. The safe wiring is the pull model — call
   * this at the dependent's create-Pr boundary (between dispatches), not mid-run.
   */
  async reconcile(t: Ticket, blockerTipSha: string, base: string): Promise<ReconcileResult> {
    const branch = branchFor(t.number, t.title);
    try {
      const fresh = await this.branch.ensureBaseRefFresh(base);
      if (!fresh) {
        this.log(
          "warn",
          `overlap-reconcile: could not fetch ${remoteRef(base)} (offline?); failing rebase to avoid a stale base`,
          t.number,
        );
        return { ok: false, reason: "stale-base" };
      }
      const ok = await this.branch.rebaseOnto(branch, blockerTipSha, remoteRef(base));
      if (!ok) {
        this.log(
          "warn",
          `overlap-reconcile: rebase of ${branch} onto ${remoteRef(base)} conflicted; dependent needs human resolution`,
          t.number,
        );
        return { ok: false, reason: "overlap-rebase" };
      }
      this.log("ok", `overlap-reconcile: rebased ${branch} onto ${remoteRef(base)}`, t.number);
      return { ok: true };
    } catch {
      return { ok: false, reason: "overlap-rebase" };
    }
  }
}
