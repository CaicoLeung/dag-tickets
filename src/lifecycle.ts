import type { FailureReason, ReviewVerdict, Ticket } from "./types.ts";
import { routingRuleFor } from "./config.ts";
import type { AgentPort, EventSink, Logger, MergeStrategy, PullRequestPort } from "./ports.ts";
import { branchFor } from "./gitgh.ts";
import { EVT } from "./events.ts";

/**
 * Everything the lifecycle needs to drive one Ticket. The orchestrator touches
 * no external system directly: agent runs cross {@link AgentPort}, the
 * PR→CI→merge path crosses {@link PullRequestPort}. (BranchPort lives in the
 * agent adapter, never seen here.) Provider choice, fallback, timeouts, and
 * cwd are the real adapters' concern — they don't appear here.
 */
export interface RunContext {
  agent: AgentPort;
  pullRequest: PullRequestPort;
  baseBranch: string;
  maxFixRounds: number;
  mergeStrategy: MergeStrategy;
  autoMerge: boolean;
  /** When true, CI must pass before merge (a "none" check result blocks). */
  requireChecks: boolean;
  dryRun: boolean;
  log: Logger;
  /** Machine-readable event channel (issue #19). Required like `log`; tests
   *  pass NULL_SINK (or a capturing fake) via the shared ctx() helper. */
  events: EventSink;
}

export interface TicketOutcome {
  status: "done" | "failed" | "skipped";
  branch?: string;
  pr?: number;
  rounds?: number;
  /**
   * How many whole-ticket attempts were made (issue #21). 1 on a clean first
   * run; up to `maxRetries + 1` after backoffs. Set by the retry wrapper, not
   * a single attempt, so it is absent from bare processTicket() output.
   */
  attempts?: number;
  /** Machine-readable failure classification (issue #21). Absent unless the
   *  ticket settled `failed`. The retry policy branches on this; the free-form
   *  `error` below carries the human detail. */
  reason?: FailureReason;
  error?: string;
}

/** Run one ticket's full lifecycle. Resolves to a terminal outcome. */
export async function processTicket(t: Ticket, ctx: RunContext): Promise<TicketOutcome> {
  const rule = routingRuleFor(t.kind);
  if (t.kind === "unknown" || !rule.skill) {
    ctx.log("warn", `no routing rule for labels [${t.labels.join(", ")}] — skipping`, t.number);
    return { status: "skipped", error: "unknown-kind" };
  }

  if (ctx.dryRun) return dryRunPlan(t, rule.skill, rule.expectPr, ctx);
  if (rule.expectPr) return runImplementLifecycle(t, ctx);
  return runSingleShot(t, rule.skill, ctx);
}

// ---------------------------------------------------------------------------
// implement -> review -> fix-loop -> PR -> (auto)merge
//
// A pure state machine over TicketOutcome. The fix-loop bounds, the CI merge
// gate, and the verdict escalation live here and are exercised through the
// agent/repo ports — no real process is spawned.
// ---------------------------------------------------------------------------

async function runImplementLifecycle(t: Ticket, ctx: RunContext): Promise<TicketOutcome> {
  const branch = branchFor(t.number, t.title);
  ctx.log("info", `implement on branch ${branch}`, t.number);

  // 1. Implement (fresh worktree, branch-off from the default branch). The
  // adapter verifies real commits landed before reporting success.
  const impl = await emitTimedStep(
    ctx,
    "implement",
    t.number,
    () => ctx.agent.implement(t, branch, ctx.baseBranch),
    (r) => ({ ok: r.ok, commits: r.commits, reason: r.reason }),
  );
  if (!impl.ok) {
    const why =
      impl.reason === "empty" ? "produced no commits (agent may have failed silently)" :
      impl.reason === "rate-limited" ? "rate-limited, no fallback succeeded" :
      impl.reason === "timeout" ? "agent timed out" :
      impl.reason === "stale-base" ? "base ref could not be refreshed (offline?); refusing a stale branch-off" :
      "agent failed";
    // Map the adapter's ImplFailReason onto the retry-classifiable
    // FailureReason. rate-limited / stale-base / timeout are transient (a
    // backoff-and-retry may clear them); empty / failed are terminal.
    const reason: FailureReason =
      impl.reason === "rate-limited" ? "rate-limited" :
      impl.reason === "stale-base" ? "stale-base" :
      impl.reason === "timeout" ? "agent-timeout" :
      impl.reason === "empty" ? "implement-empty" :
      "implement-failed";
    return fail(t, ctx, reason, `implement ${why}`, branch);
  }
  ctx.log("ok", `implement complete (${impl.commits} commit${impl.commits === 1 ? "" : "s"}); running review`, t.number);

  // 2. Review + bounded fix-loop. Each review/fix pass is its own timed step
  // so the event trace shows exactly how the loop converged.
  const runReview = (): Promise<ReviewVerdict> =>
    emitTimedStep(
      ctx,
      "review",
      t.number,
      () => ctx.agent.review(t, branch, ctx.baseBranch),
      (r) => ({ verdict: r.kind, issueCount: r.issueCount }),
    );

  let rounds = 0;
  let verdict = await runReview();
  while (verdict.kind === "issues" && rounds < ctx.maxFixRounds) {
    rounds++;
    ctx.log("info", `review found ${verdict.issueCount} issue(s); fix round ${rounds}/${ctx.maxFixRounds}`, t.number);
    const fix = await emitTimedStep(
      ctx,
      "fix",
      t.number,
      () => ctx.agent.fix(t, verdict, branch, rounds),
      (r) => ({ round: rounds, ok: r.ok }),
      { round: rounds },
    );
    if (!fix.ok) return fail(t, ctx, "fix-failed", `fix round ${rounds} failed`, branch);
    verdict = await runReview();
  }

  if (verdict.kind !== "clean") {
    // Distinguish "still has actionable issues after N rounds" (the code is
    // genuinely incomplete) from "verdict stayed unknown" (the agent never
    // emitted a REVIEW_VERDICT line) — both used to share one `review not
    // clean` message. Both are terminal for the ticket, but the post-mortem
    // reason now tells a human which kind of attention is needed (issue #21).
    const reason: FailureReason = verdict.kind === "issues" ? "review-issues" : "review-unknown";
    return fail(t, ctx, reason, `review not clean after ${rounds} round(s): ${verdict.kind}`, branch);
  }
  ctx.log("ok", "review clean; opening PR", t.number);

  // 3. PR.
  const pr = await ctx.pullRequest.createPr({
    title: `${t.title} (#${t.number})`,
    body: prBody(t),
    head: branch,
    base: ctx.baseBranch,
  });
  ctx.events.emit(EVT.PR_CREATED, t.number, { pr, head: branch, base: ctx.baseBranch });
  ctx.log("ok", `PR #${pr} opened`, t.number);

  // 4. CI gate.
  const checks = await ctx.pullRequest.watchChecks(pr);
  ctx.events.emit(EVT.CI_RESULT, t.number, { state: checks.state, failed: checks.failed });
  const ciOk = checks.state === "pass" || (checks.state === "none" && !ctx.requireChecks);
  if (!ciOk) {
    ctx.log("error", `CI not green (state=${checks.state}${checks.failed.length ? ": " + checks.failed.join(", ") : ""}); leaving PR #${pr} for human`, t.number);
    // CI red is the canonical transient cause: a flaky job / momentary infra
    // failure often clears on a backoff-and-retry, so it's retryable. A retry
    // re-runs the whole ticket (the PR from this attempt is left for a human).
    return { status: "failed", branch, pr, rounds, reason: "ci-failed", error: "ci-failed" };
  }

  // 5. Merge (or hand off).
  if (!ctx.autoMerge) {
    ctx.log("ok", `PR #${pr} ready for manual merge (CI green, review clean)`, t.number);
    ctx.events.emit(EVT.MERGE, t.number, { strategy: ctx.mergeStrategy, ok: false, manual: true });
    return { status: "done", branch, pr, rounds };
  }
  try {
    await ctx.pullRequest.mergePr(pr, ctx.mergeStrategy);
    ctx.events.emit(EVT.MERGE, t.number, { strategy: ctx.mergeStrategy, ok: true });
    ctx.log("ok", `PR #${pr} merged (${ctx.mergeStrategy})`, t.number);
    await ctx.pullRequest.closeIssue(t.number, `Implemented and merged via dag-tickets in PR #${pr}.`);
    return { status: "done", branch, pr, rounds };
  } catch (e) {
    const msg = (e as Error).message;
    ctx.events.emit(EVT.MERGE, t.number, { strategy: ctx.mergeStrategy, ok: false, error: msg });
    // A merge failure is usually a race (base moved under us) or a transient
    // gh 5xx — retryable. A retry re-runs from branch-off, so the stale PR is
    // abandoned for a human to close.
    return fail(t, ctx, "merge-race", `merge failed: ${msg}`, branch, pr);
  }
}

async function runSingleShot(t: Ticket, skill: string, ctx: RunContext): Promise<TicketOutcome> {
  const branch = branchFor(t.number, `${t.title}-shot`);
  ctx.log("info", `${skill} (single-shot)`, t.number);
  const r = await emitTimedStep(
    ctx,
    skill,
    t.number,
    () => ctx.agent.singleShot(skill, t, branch, ctx.baseBranch),
    (res) => ({ ok: res.ok, timedOut: res.timedOut }),
  );
  if (!r.ok) return fail(t, ctx, "single-shot-failed", `${skill} agent failed${r.timedOut ? " (timeout)" : ""}`, branch);
  ctx.log("ok", `${skill} complete`, t.number);
  return { status: "done", branch };
}

// ---------------------------------------------------------------------------
// Dry run — print the plan, dispatch nothing.
// ---------------------------------------------------------------------------

async function dryRunPlan(t: Ticket, skill: string, expectPr: boolean, ctx: RunContext): Promise<TicketOutcome> {
  const branch = branchFor(t.number, t.title);
  const labelSkill = skill === "research" ? "research" : skill === "triage" ? "triage" : "implement";
  const lines: string[] = [];
  lines.push(`would run /${skill} on #${t.number} (${t.kind}) — ${t.title}`);
  lines.push(`  provider: ${ctx.agent.providerLabel(labelSkill)}`);
  lines.push(`  worktree: branch-off new-branch=${branch} base=${ctx.baseBranch}`);
  if (expectPr) {
    lines.push(`  review:   /code-review provider=${ctx.agent.providerLabel("review")} fixed-point=origin/${ctx.baseBranch}`);
    if (ctx.maxFixRounds > 0) lines.push(`  fix-loop: up to ${ctx.maxFixRounds} round(s) on ${branch}`);
    lines.push(`  pr:       gh pr create --head ${branch} --base ${ctx.baseBranch}`);
    lines.push(`  checks:   gh pr checks --watch${ctx.requireChecks ? " (required)" : ""}`);
    lines.push(`  merge:    ${ctx.autoMerge ? ctx.mergeStrategy + " + delete-branch + close issue" : "manual (auto-merge off)"}`);
  }
  lines.push(`  blocked-by: ${t.blockedBy.length ? t.blockedBy.map((b) => "#" + b).join(", ") : "—"}`);
  ctx.log("dim", lines.join("\n"), t.number);
  return { status: "done", branch, rounds: 0 };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Run one agent step inside a timed step.start/step.end event pair. Collapses
 * the implement/review/fix/singleShot timing shape so the start↔end pairing
 * can't drift across the four call sites. `startExtra` is spread onto the
 * START payload (e.g. a fix round); `endData(result)` supplies the
 * result-specific END fields — `durationMs` is added by the helper.
 */
async function emitTimedStep<T>(
  ctx: RunContext,
  step: string,
  ticketNumber: number,
  fn: () => Promise<T>,
  endData: (result: T) => Record<string, unknown>,
  startExtra: Record<string, unknown> = {},
): Promise<T> {
  const start = Date.now();
  ctx.events.emit(EVT.STEP_START, ticketNumber, { step, ...startExtra });
  const result = await fn();
  ctx.events.emit(EVT.STEP_END, ticketNumber, {
    step,
    durationMs: Date.now() - start,
    ...endData(result),
  });
  return result;
}

function prBody(t: Ticket): string {
  return [
    `Closes #${t.number}`,
    "",
    `**${t.title}**`,
    "",
    t.body || "",
    "",
    "---",
    "_Generated by dag-tickets. Implements, code-reviews, and merges the ticket per the project's mattpocock-skills workflow._",
  ].join("\n");
}

function fail(
  t: Ticket,
  ctx: RunContext,
  reason: FailureReason,
  error: string,
  branch?: string,
  pr?: number,
): TicketOutcome {
  ctx.log("error", error, t.number);
  return { status: "failed", branch, pr, reason, error };
}
