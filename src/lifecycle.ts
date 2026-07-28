import type { Ticket } from "./types.ts";
import { routingRuleFor } from "./config.ts";
import type { AgentPort, Logger, MergeStrategy, PullRequestPort } from "./ports.ts";
import { branchFor } from "./gitgh.ts";

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
}

export interface TicketOutcome {
  status: "done" | "failed" | "skipped";
  branch?: string;
  pr?: number;
  rounds?: number;
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
  const impl = await ctx.agent.implement(t, branch, ctx.baseBranch);
  if (!impl.ok) {
    const why =
      impl.reason === "empty" ? "produced no commits (agent may have failed silently)" :
      impl.reason === "rate-limited" ? "rate-limited, no fallback succeeded" :
      impl.reason === "timeout" ? "agent timed out" :
      impl.reason === "stale-base" ? "base ref could not be refreshed (offline?); refusing a stale branch-off" :
      "agent failed";
    return fail(t, ctx, `implement ${why}`, branch);
  }
  ctx.log("ok", `implement complete (${impl.commits} commit${impl.commits === 1 ? "" : "s"}); running review`, t.number);

  // 2. Review + bounded fix-loop.
  let rounds = 0;
  let verdict = await ctx.agent.review(t, branch, ctx.baseBranch);
  while (verdict.kind === "issues" && rounds < ctx.maxFixRounds) {
    rounds++;
    ctx.log("info", `review found ${verdict.issueCount} issue(s); fix round ${rounds}/${ctx.maxFixRounds}`, t.number);
    const fix = await ctx.agent.fix(t, verdict, branch, rounds);
    if (!fix.ok) return fail(t, ctx, `fix round ${rounds} failed`, branch);
    verdict = await ctx.agent.review(t, branch, ctx.baseBranch);
  }

  if (verdict.kind !== "clean") {
    // Either still has issues after rounds, or verdict stayed unknown.
    return fail(t, ctx, `review not clean after ${rounds} round(s): ${verdict.kind}`, branch);
  }
  ctx.log("ok", "review clean; opening PR", t.number);

  // 3. PR.
  const pr = await ctx.pullRequest.createPr({
    title: `${t.title} (#${t.number})`,
    body: prBody(t),
    head: branch,
    base: ctx.baseBranch,
  });
  ctx.log("ok", `PR #${pr} opened`, t.number);

  // 4. CI gate.
  const checks = await ctx.pullRequest.watchChecks(pr);
  const ciOk = checks.state === "pass" || (checks.state === "none" && !ctx.requireChecks);
  if (!ciOk) {
    ctx.log("error", `CI not green (state=${checks.state}${checks.failed.length ? ": " + checks.failed.join(", ") : ""}); leaving PR #${pr} for human`, t.number);
    return { status: "failed", branch, pr, rounds, error: "ci-failed" };
  }

  // 5. Merge (or hand off).
  if (!ctx.autoMerge) {
    ctx.log("ok", `PR #${pr} ready for manual merge (CI green, review clean)`, t.number);
    return { status: "done", branch, pr, rounds };
  }
  try {
    await ctx.pullRequest.mergePr(pr, ctx.mergeStrategy);
    ctx.log("ok", `PR #${pr} merged (${ctx.mergeStrategy})`, t.number);
    await ctx.pullRequest.closeIssue(t.number, `Implemented and merged via dag-tickets in PR #${pr}.`);
    return { status: "done", branch, pr, rounds };
  } catch (e) {
    return fail(t, ctx, `merge failed: ${(e as Error).message}`, branch, pr);
  }
}

async function runSingleShot(t: Ticket, skill: string, ctx: RunContext): Promise<TicketOutcome> {
  const branch = branchFor(t.number, `${t.title}-shot`);
  ctx.log("info", `${skill} (single-shot)`, t.number);
  const r = await ctx.agent.singleShot(skill, t, branch, ctx.baseBranch);
  if (!r.ok) return fail(t, ctx, `${skill} agent failed${r.timedOut ? " (timeout)" : ""}`, branch);
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

function fail(t: Ticket, ctx: RunContext, error: string, branch?: string, pr?: number): TicketOutcome {
  ctx.log("error", error, t.number);
  return { status: "failed", branch, pr, error };
}
