import type { Ticket } from "./types.ts";
import { routingRuleFor } from "./config.ts";
import { parseReviewVerdict } from "./parse.ts";
import { branchFor, createPr, watchChecks, mergePr, closeIssue, type MergeStrategy } from "./gitgh.ts";
import {
  dispatch,
  implementPrompt,
  reviewPrompt,
  fixPrompt,
  singleShotPrompt,
  type ProviderPrefs,
  type DispatchResult,
} from "./paseo.ts";

export type LogLevel = "info" | "ok" | "warn" | "error" | "dim";
export type Logger = (level: LogLevel, msg: string, ticketNumber?: number) => void;

export interface RunContext {
  prefs: ProviderPrefs;
  baseBranch: string;
  cwd?: string;
  maxFixRounds: number;
  mergeStrategy: MergeStrategy;
  autoMerge: boolean;
  /** When true, CI must pass before merge (a "none" check result blocks). */
  requireChecks: boolean;
  dryRun: boolean;
  runTimeoutMs?: number;
  log: Logger;
}

export interface TicketOutcome {
  status: "done" | "failed" | "skipped";
  branch?: string;
  pr?: number;
  rounds?: number;
  error?: string;
}

const SLUG = (n: number) => `loop-${n}`;

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
// ---------------------------------------------------------------------------

async function runImplementLifecycle(t: Ticket, ctx: RunContext): Promise<TicketOutcome> {
  const branch = branchFor(t.number, t.title);
  ctx.log("info", `implement on branch ${branch}`, t.number);

  // 1. Implement (fresh worktree, branch-off from the default branch).
  const impl = await dispatch(implementPrompt(t, branch), {
    provider: ctx.prefs.impl,
    title: `implement #${t.number}`,
    slug: SLUG(t.number),
    cwd: ctx.cwd,
    timeoutMs: ctx.runTimeoutMs,
    branchMode: "branch-off",
    newBranch: branch,
    base: ctx.baseBranch,
  });
  if (!impl.ok) {
    return fail(t, ctx, `implement agent failed${impl.timedOut ? " (timeout)" : ""}`, branch);
  }
  ctx.log("ok", "implement complete; running review", t.number);

  // 2. Review + bounded fix-loop.
  let rounds = 0;
  let verdict = await runReview(t, branch, ctx);
  while (verdict.kind === "issues" && rounds < ctx.maxFixRounds) {
    rounds++;
    ctx.log("info", `review found ${verdict.issueCount} issue(s); fix round ${rounds}/${ctx.maxFixRounds}`, t.number);
    const fix = await dispatch(fixPrompt(t, verdict.raw, branch), {
      provider: ctx.prefs.impl,
      title: `fix #${t.number} r${rounds}`,
      slug: SLUG(t.number),
      cwd: ctx.cwd,
      timeoutMs: ctx.runTimeoutMs,
      branchMode: "checkout-branch",
      branch,
    });
    if (!fix.ok) return fail(t, ctx, `fix round ${rounds} failed`, branch);
    verdict = await runReview(t, branch, ctx);
  }

  if (verdict.kind !== "clean") {
    // Either still has issues after rounds, or verdict stayed unknown.
    return fail(t, ctx, `review not clean after ${rounds} round(s): ${verdict.kind}`, branch);
  }
  ctx.log("ok", "review clean; opening PR", t.number);

  // 3. PR.
  const pr = await createPr({
    title: `${t.title} (#${t.number})`,
    body: prBody(t),
    head: branch,
    base: ctx.baseBranch,
    cwd: ctx.cwd,
  });
  ctx.log("ok", `PR #${pr} opened`, t.number);

  // 4. CI gate.
  const checks = await watchChecks(pr, { cwd: ctx.cwd, timeoutMs: ctx.runTimeoutMs });
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
    await mergePr(pr, ctx.mergeStrategy, { cwd: ctx.cwd });
    ctx.log("ok", `PR #${pr} merged (${ctx.mergeStrategy})`, t.number);
    await closeIssue(t.number, `Implemented and merged via loop-tickets in PR #${pr}.`, { cwd: ctx.cwd });
    return { status: "done", branch, pr, rounds };
  } catch (e) {
    return fail(t, ctx, `merge failed: ${(e as Error).message}`, branch, pr);
  }
}

/** Run /code-review in a fresh worktree on the branch; retry once on an unparseable verdict. */
async function runReview(t: Ticket, branch: string, ctx: RunContext): Promise<ReturnType<typeof parseReviewVerdict>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r: DispatchResult = await dispatch(reviewPrompt(t, ctx.baseBranch), {
      provider: ctx.prefs.review,
      title: `review #${t.number}`,
      slug: `${SLUG(t.number)}-review`,
      cwd: ctx.cwd,
      timeoutMs: ctx.runTimeoutMs,
      branchMode: "checkout-branch",
      branch,
    });
    if (!r.ok) {
      ctx.log("warn", `review agent failed${r.timedOut ? " (timeout)" : ""}`, t.number);
      return { kind: "unknown", issueCount: 0, raw: r.output.slice(-800) };
    }
    const v = parseReviewVerdict(r.output);
    if (v.kind !== "unknown" || attempt > 0) return v;
    ctx.log("warn", "review verdict unparseable; retrying once", t.number);
  }
  return { kind: "unknown", issueCount: 0, raw: "" };
}

async function runSingleShot(t: Ticket, skill: string, ctx: RunContext): Promise<TicketOutcome> {
  const branch = branchFor(t.number, `${t.title}-shot`);
  ctx.log("info", `${skill} (single-shot)`, t.number);
  const r = await dispatch(singleShotPrompt(skill, t), {
    provider: skill === "research" ? ctx.prefs.research : ctx.prefs.triage,
    title: `${skill} #${t.number}`,
    slug: SLUG(t.number),
    cwd: ctx.cwd,
    timeoutMs: ctx.runTimeoutMs,
    branchMode: "branch-off",
    newBranch: branch,
    base: ctx.baseBranch,
  });
  if (!r.ok) return fail(t, ctx, `${skill} agent failed${r.timedOut ? " (timeout)" : ""}`, branch);
  ctx.log("ok", `${skill} complete`, t.number);
  return { status: "done", branch };
}

// ---------------------------------------------------------------------------
// Dry run — print the plan, dispatch nothing.
// ---------------------------------------------------------------------------

async function dryRunPlan(t: Ticket, skill: string, expectPr: boolean, ctx: RunContext): Promise<TicketOutcome> {
  const branch = branchFor(t.number, t.title);
  const lines: string[] = [];
  lines.push(`would run /${skill} on #${t.number} (${t.kind}) — ${t.title}`);
  lines.push(`  provider: ${skill === "research" ? ctx.prefs.research : skill === "triage" ? ctx.prefs.triage : ctx.prefs.impl}`);
  lines.push(`  worktree: branch-off new-branch=${branch} base=${ctx.baseBranch}`);
  if (expectPr) {
    lines.push(`  review:   /code-review provider=${ctx.prefs.review} fixed-point=origin/${ctx.baseBranch}`);
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
    "_Generated by loop-tickets. Implements, code-reviews, and merges the ticket per the project's mattpocock-skills workflow._",
  ].join("\n");
}

function fail(t: Ticket, ctx: RunContext, error: string, branch?: string, pr?: number): TicketOutcome {
  ctx.log("error", error, t.number);
  return { status: "failed", branch, pr, error };
}
