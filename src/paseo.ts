import { run } from "./shell.ts";
import type { Ticket } from "./types.ts";

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

function msToDuration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
}

export interface DispatchOpts {
  provider: string;
  title: string;
  /** Paseo worktree slug — groups the run in the UI. */
  slug: string;
  cwd?: string;
  /** Max wall time for the agent run (paseo --wait-timeout). */
  timeoutMs?: number;
  mode?: string;
  branchMode: "branch-off" | "checkout-branch";
  /** branch-off: new branch to create. */
  newBranch?: string;
  /** branch-off: base ref. */
  base?: string;
  /** checkout-branch: existing branch to check out. */
  branch?: string;
}

export interface DispatchResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
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

  const r = await run(args, { cwd: opts.cwd, timeoutMs: waitMs + 60_000 });
  let status = r.ok ? "completed" : "failed";
  let output = r.stdout;
  if (r.ok) {
    try {
      const j = JSON.parse(r.stdout) as { agentId?: string; status?: string };
      if (typeof j.status === "string") status = j.status;
      const agentId = j.agentId;
      if (agentId) {
        const lr = await run(["paseo", "logs", agentId, "--filter", "text"], {
          cwd: opts.cwd,
          timeoutMs: 60_000,
        });
        if (lr.ok) {
          output = lr.stdout
            .split(/\r?\n/)
            .filter((line) => !/^\[User\]/.test(line))
            .join("\n");
        }
      }
    } catch {
      /* non-JSON stdout (older paseo) → keep the status envelope as output */
    }
  }
  return {
    ok: r.ok && (status === "completed" || status === "idle"),
    output,
    timedOut: r.timedOut,
  };
}

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
As your FINAL non-empty line, emit exactly one of:
- \`REVIEW_VERDICT: CLEAN\`           — no actionable findings
- \`REVIEW_VERDICT: ISSUES <n>\`      — n actionable findings remain

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
  return `You are working one GitHub issue in isolation. The /${skill} skill is available — run it.

## Task
Issue #${t.number}: ${t.title}
Issue URL: ${t.url}

## Issue body
${t.body || "(no body)"}

Run /${skill} for this issue. When finished, post any required comment/output on the issue via \`gh\` per the skill's contract, then report a one-paragraph summary.`;
}
