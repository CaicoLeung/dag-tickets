import { mustRun, run } from "./shell.ts";
import type { BranchPort, CheckResult, CreatePrOpts, MergeStrategy, PullRequestPort } from "./ports.ts";
import { normalizeBase } from "./ports.ts";

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  /** `owner/repo` */
  nameWithOwner: string;
}

let cached: RepoInfo | null = null;

/** Resolve owner/repo + default branch from the current checkout via `gh`. */
export async function repoInfo(cwd?: string): Promise<RepoInfo> {
  if (cached && !cwd) return cached;
  const r = await mustRun(
    ["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    { cwd },
  );
  const j = JSON.parse(r.stdout);
  const nameWithOwner: string = j.nameWithOwner;
  const [owner, repo] = nameWithOwner.split("/");
  if (!owner || !repo) throw new Error(`unexpected repository nameWithOwner: ${nameWithOwner}`);
  // defaultBranchRef is { name, ... } in newer gh; fall back to "main".
  const defaultBranch: string = j.defaultBranchRef?.name ?? "main";
  const info: RepoInfo = { owner, repo, defaultBranch, nameWithOwner };
  if (!cwd) cached = info;
  return info;
}

/** Build a short, filesystem/git-safe branch slug from a ticket. */
export function branchFor(number: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") || "ticket";
  return `loop/${number}-${slug}`;
}

/**
 * 0.2.0 feedback B2: best-effort fetch of `origin/<base>` so a batch's
 *  merged-check sees merges that landed since the last fetch. Shared by the
 *  per-ticket {@link mergedReference} scan (default) and callable once up-front
 *  by a batch caller that fans out many scans in parallel — N parallel
 *  `git fetch origin <base>` of the same ref race on the git lock and waste a
 *  round-trit per ticket, so cli.ts calls this once then passes
 *  `{ fetch: false }` to each per-ticket scan. Non-fatal: a failed fetch
 *  leaves whatever `origin/<base>` currently holds for the scan to read.
 */
export async function ensureMergedBase(base: string, cwd?: string): Promise<void> {
  const bare = normalizeBase(base);
  await run(["git", "fetch", "origin", bare], { cwd });
}

/** Options for {@link mergedReference}. */
export interface MergedReferenceOpts {
  /** When true (default), refresh `origin/<base>` before scanning. A batch
   *  caller that already ran {@link ensureMergedBase} once passes false to
   *  avoid N redundant parallel fetches of the same ref. */
  fetch?: boolean;
}

/**
 * 0.2.0 feedback B2: has the work for issue `n` already landed on `base`? Scans
 *  merged commit subjects on `origin/<base>` for a precise reference to `#n` —
 *  the GitHub squash-merge title form `Title (#465)` (parens around the number)
 *  or a `Closes/Fixes/Resolves #465` trailer — so dag-tickets doesn't
 *  re-implement already-merged work into the void. `n` is a parsed integer,
 *  safe to interpolate into the grep.
 *
 *  Conservative on purpose: a coincidental `#465` inside `#4650` or prose like
 *  "relates to #465" is rejected — only the parenthesised title trailer or a
 *  real closing-verb trailer counts, so a real merge is the only thing that
 *  triggers a skip. Best-effort: a failed scan returns `{ merged: false }`
 *  (the run proceeds) rather than blocking.
 *
 *  `opts.fetch` (default true) refreshes `origin/<base>` first; a batch caller
 *  that fanned out scans across many tickets should run
 *  {@link ensureMergedBase} once and pass `{ fetch: false }` here so the same
 *  ref isn't fetched N times in parallel.
 */
export async function mergedReference(
  n: number,
  base: string,
  cwd?: string,
  opts: MergedReferenceOpts = {},
): Promise<{ merged: boolean; sha?: string; subject?: string }> {
  const bare = normalizeBase(base);
  // Fetch so origin/<base> reflects merges that landed since the last fetch; a
  // failed fetch is non-fatal (we scan whatever origin/<base> currently holds).
  // Skipped when a batch caller already ran ensureMergedBase once up-front.
  if (opts.fetch !== false) await ensureMergedBase(base, cwd);
  // git --grep scans all history (full message: subject + body) fast; limit
  // to the most recent 50 matches so a very old coincidental reference can't
  // mask a recent precise one. %B carries the whole message so a Closes/Fixes
  // trailer in the body is verifiable, not just the subject.
  const r = await run(
    ["git", "log", `origin/${bare}`, "--grep", `#${n}`, "-i", "--format=%H%x09%B", "-50"],
    { cwd },
  );
  if (!r.ok) return { merged: false };
  // Precise: `(#465)` (the squash-merge title trailer — parens immediately
  // around the number) OR a Closes/Fixes/Resolves trailer (verb directly
  // followed by #n), with the number not followed by another digit (so #4650
  // can't match). A bare #465 in prose ("relates to #465", "see #465") is
  // intentionally NOT matched — those are not merge references and matching
  // them would falsely skip work that hasn't landed. The first alternation
  // requires literal parens around just the number; the second requires the
  // GitHub trailer verb adjacent to it.
  const precise = new RegExp(
    `\\(#${n}\\)(?!\\d)|(?:closes|fixes|resolves)\\s+#${n}(?!\\d)`,
    "i",
  );
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf("\t");
    const sha = idx >= 0 ? line.slice(0, idx) : "";
    // %B can span multiple lines; a trailer sits on its own line, so testing
    // each line independently is correct (and the subject line carries (#n)).
    const text = idx >= 0 ? line.slice(idx + 1) : line;
    if (precise.test(text)) return { merged: true, sha: sha || undefined, subject: text.slice(0, 120) };
  }
  return { merged: false };
}

/**
 * Real {@link BranchPort} adapter: git worktree/branch hygiene. Owns the
 * invariant that each agent step starts on a clean branch (git forbids a
 * branch in more than one worktree). Driven by {@link PaseoAgent}; the
 * lifecycle orchestrator never sees these commands.
 */
export class ShellBranch implements BranchPort {
  constructor(private readonly cwd?: string) {}

  /** Paths of linked worktrees whose HEAD is on `branch` (git forbids >1, but
   *  the porcelain walk collects all matches defensively). Shared by
   *  {@link cleanBranch} (remove them) and {@link rebaseOnto} (rebase inside
   *  the first). Returns [] when `git worktree list` fails. */
  private async worktreesOnBranch(branch: string): Promise<string[]> {
    const target = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
    const r = await run(["git", "worktree", "list", "--porcelain"], { cwd: this.cwd });
    if (!r.ok) return [];
    const found: string[] = [];
    let path = "";
    let onBranch = false;
    const flush = (): void => {
      if (path && onBranch) found.push(path);
    };
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush();
        path = line.slice("worktree ".length).trim();
        onBranch = false;
      } else if (line.startsWith("branch ")) {
        onBranch = line.slice("branch ".length).trim() === target;
      }
    }
    flush();
    return found;
  }

  /**
   * Remove any linked worktree whose HEAD is on `branch`. Git forbids a branch
   * being checked out in more than one worktree, so a leftover worktree from a
   * prior dispatch makes a later `checkout-branch` dispatch fail with "Branch
   * already checked out". Commits live on the branch ref, so forcing removal
   * here loses no work. The main checkout is never on a `loop/` branch.
   */
  async cleanBranch(branch: string): Promise<void> {
    for (const p of await this.worktreesOnBranch(branch)) {
      await run(["git", "worktree", "remove", "--force", p], { cwd: this.cwd });
    }
  }

  /** @see {BranchPort.rebaseOnto}.
   *
   *  Runs inside the branch's linked worktree (`git -C <wt>`), since git forbids
   *  rebasing a branch checked out elsewhere. On conflict the rebase is aborted
   *  so the dependent's worktree is left clean. A branch with no linked
   *  worktree (lost race / already settled) is a no-op success. */
  async rebaseOnto(branch: string, oldBase: string, newBase: string): Promise<boolean> {
    const wts = await this.worktreesOnBranch(branch);
    if (wts.length === 0) return true;
    const wt = wts[0]!;
    const r = await run(["git", "-C", wt, "rebase", "--onto", newBase, oldBase], {
      cwd: this.cwd,
    });
    if (r.ok) return true;
    await run(["git", "-C", wt, "rebase", "--abort"], { cwd: this.cwd });
    return false;
  }

  /** @see {BranchPort.resolveRemoteTip}.
   *
   *  Refspec mirrors {@link ensureBaseRefFresh} (the leading `+` force-updates
   *  the remote-tracking ref so a rebased / force-pushed blocker head still
   *  lands instead of being rejected). `null` covers both a failed fetch and a
   *  ref that doesn't exist on the remote — the caller can't tell (and doesn't
   *  need to) whether the blocker hasn't pushed yet or the fetch broke. */
  async resolveRemoteTip(ref: string): Promise<string | null> {
    const bare = normalizeBase(ref);
    const fetch = await run(
      ["git", "fetch", "origin", `+${bare}:refs/remotes/origin/${bare}`],
      { cwd: this.cwd },
    );
    if (!fetch.ok) return null;
    const rev = await run(["git", "rev-parse", `origin/${bare}`], { cwd: this.cwd });
    if (!rev.ok) return null;
    const sha = rev.stdout.trim();
    return sha || null;
  }

  async commitCount(base: string, branch: string): Promise<number> {
    const r = await run(["git", "rev-list", "--count", `${base}..${branch}`], { cwd: this.cwd });
    if (!r.ok) return 0;
    return parseInt(r.stdout.trim(), 10) || 0;
  }

  async deleteBranch(branch: string): Promise<void> {
    await run(["git", "branch", "-D", branch], { cwd: this.cwd });
  }

  /** @see {BranchPort.ensureBaseRefFresh}.
   *
   *  Refspec rationale: `+<base>:refs/remotes/origin/<base>` writes straight to
   *  the remote-tracking ref (independent of the remote's configured fetchspecs)
   *  and the leading `+` force-updates it on a non-fast-forward, so a rebased /
   *  force-pushed base still lands instead of being rejected as stale. */
  async ensureBaseRefFresh(base: string): Promise<boolean> {
    const bare = normalizeBase(base);
    const r = await run(
      ["git", "fetch", "origin", `+${bare}:refs/remotes/origin/${bare}`],
      { cwd: this.cwd },
    );
    return r.ok;
  }
}

/**
 * Real {@link PullRequestPort} adapter: the gh PR→CI→merge→close path. Driven
 * by the lifecycle orchestrator; a fake stands in for tests.
 */

/** GitHub's authoritative state for a PR. Narrowed to a union (mirroring
 *  {@link MergeStrategy}) so the {@link ShellPullRequest.reconcilePrState}
 *  contract is a known enum, not a magic string compared at every call site. */
type PrState = "OPEN" | "MERGED" | "CLOSED";

/** Attempts {@link ShellPullRequest.reconcilePrState} makes before conceding
 *  "unknown". Guards a merge that already landed: a single transient
 *  `gh pr view` failure would otherwise return null → mergePr throws →
 *  merge-race → the duplicate-PR bug #38. Bounded so a real outage still fails
 *  fast-ish. */
const PR_STATE_ATTEMPTS = 3;
/** Backoff between {@link ShellPullRequest.reconcilePrState} retries. */
const PR_STATE_RETRY_MS = 500;

/** Outcome of {@link ShellPullRequest.reconcilePrState}: the resolved PR
 *  state, or — when it could not be determined — the last transient failure
 *  reason, so {@link ShellPullRequest.mergePr}'s thrown error names the real
 *  culprit (a down/flaky `gh pr view`) instead of mis-blaming a merge that
 *  likely already landed. */
interface ReconciledPrState {
  state: PrState | null;
  failure?: string;
}

export class ShellPullRequest implements PullRequestPort {
  constructor(
    private readonly cwd?: string,
    /** Watch-checks timeout; undefined polls indefinitely (current behaviour). */
    private readonly timeoutMs?: number,
  ) {}

  /** Push the head branch and open a PR for it. Returns the PR number.
   *  Force-pushes so a stale remote branch from a prior batch is overwritten. */
  async createPr(opts: CreatePrOpts): Promise<number> {
    await run(["git", "push", "-u", "--force", "origin", `${opts.head}:${opts.head}`], { cwd: this.cwd });
    const args = [
      "gh",
      "pr",
      "create",
      "--title",
      opts.title,
      "--body",
      opts.body,
      "--head",
      opts.head,
      "--base",
      opts.base,
    ];
    if (opts.draft) args.push("--draft");
    const r = await mustRun(args, { cwd: this.cwd });
    // gh pr create prints the PR URL on success; older gh lacks --json on create.
    const m = r.stdout.match(/\/pull\/(\d+)/) ?? r.stderr.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`could not parse PR number from gh output: ${r.stdout}\n${r.stderr}`);
    return parseInt(m[1]!, 10);
  }

  /**
   * Wait for PR checks to finish, then report pass/fail.
   *
   * `gh pr checks --watch --fail-fast` blocks until complete and exits non-zero
   * on the first failing check. A PR that triggers zero check workflows (e.g.
   * every workflow path-filters the changed files out) prints
   * "no checks reported on the <branch> branch" to stderr and exits non-zero
   * (often 1). That message is unambiguous, so we treat it as `state:"none"`
   * regardless of exit code — otherwise path-filtered PRs cascade to
   * `ci-failed` (#37). We scope the match to stderr (where gh writes its own
   * diagnostics) and anchor on the literal "no checks reported" (not bare
   * "no checks") so a real failing check whose stdout table echoes those words
   * can't be misread as no-CI. The caller decides whether `none` satisfies the
   * merge gate via --require-checks.
   */
  async watchChecks(prNumber: number): Promise<CheckResult> {
    const watch = await run(
      ["gh", "pr", "checks", String(prNumber), "--watch", "--fail-fast", "--interval", "30"],
      { cwd: this.cwd, timeoutMs: this.timeoutMs },
    );
    if (watch.timedOut) return { state: "fail", failed: ["checks-watch-timeout"] };
    // gh writes its no-checks diagnostic to stderr; a failing check's output is
    // a table on stdout. Match stderr only (exit code is unreliable, #37) so a
    // failing check whose log echoes "no checks reported" can't be misread as
    // no-CI.
    if (/no checks reported|nothing to check/.test(watch.stderr.toLowerCase())) {
      return { state: "none", failed: [] };
    }
    if (!watch.ok) {
      // Gather which checks failed for the escalation message.
      const detail = await run(["gh", "pr", "checks", String(prNumber), "--json", "name,state"], { cwd: this.cwd });
      const failed: string[] = [];
      try {
        const arr = JSON.parse(detail.stdout) as Array<{ name?: string; state?: string }>;
        for (const c of arr) {
          if (c.state && /fail|error|x/i.test(c.state) && c.name) failed.push(c.name);
        }
      } catch {
        /* ignore parse errors */
      }
      return { state: "fail", failed: failed.length ? failed : ["one-or-more-checks"] };
    }
    return { state: "pass", failed: [] };
  }

  /** Merge a PR and delete its branch.
   *
   *  `gh pr merge --delete-branch` performs the server-side merge, then tries
   *  to delete the branch — both remote and local. The local delete fails
   *  (exit 1) when the branch is checked out in a worktree, which dag-tickets'
   *  review worktree routinely is. The merge on GitHub has already landed by
   *  then, so throwing here would be misclassified upstream as a retryable
   *  `merge-race` and the already-merged ticket re-implemented → duplicate PRs
   *  (#38). On a non-zero exit we reconcile against GitHub's authoritative PR
   *  state: a `MERGED` PR means the merge succeeded and we return normally;
   *  anything else (OPEN/CLOSED/unknown) is a genuine merge failure and we
   *  throw, preserving the merge-race retry path. */
  async mergePr(prNumber: number, strategy: MergeStrategy): Promise<void> {
    const flag = strategy === "squash" ? "--squash" : strategy === "rebase" ? "--rebase" : "--merge";
    const r = await run(
      ["gh", "pr", "merge", String(prNumber), flag, "--delete-branch"],
      { cwd: this.cwd },
    );
    if (r.ok) return;
    const reconciled = await this.reconcilePrState(prNumber);
    if (reconciled.state === "MERGED") return; // merge landed despite the non-zero exit
    throw new Error(
      `gh pr merge failed (pr state=${reconciled.state ?? "?"}, exit ${r.code}): ${r.stderr.trim()}` +
        (reconciled.state === null
          ? ` — reconciliation unavailable: ${reconciled.failure ?? "unknown"}`
          : ""),
    );
  }

  /** GitHub's authoritative state for a PR ({@link PrState}). Used by
   *  {@link mergePr} to decide whether a non-zero `gh pr merge` exit still
   *  landed the merge. Retries on ANY transient `gh pr view` failure — a
   *  non-zero exit (network/5xx) or a malformed/truncated response — so a flaky
   *  view right after a successful merge can't re-introduce the #38
   *  misclassification. A well-formed but unrecognized state is terminal, not
   *  transient (retrying returns the same value), so it concedes immediately.
   *  Returns null (with the last failure reason) only after all attempts fail,
   *  so the caller's error names the real culprit rather than the merge. */
  private async reconcilePrState(prNumber: number): Promise<ReconciledPrState> {
    const wait = () => new Promise<void>((res) => setTimeout(res, PR_STATE_RETRY_MS));
    let lastFailure = "no attempt made";
    for (let attempt = 1; attempt <= PR_STATE_ATTEMPTS; attempt++) {
      const last = attempt === PR_STATE_ATTEMPTS;
      const r = await run(
        ["gh", "pr", "view", String(prNumber), "--json", "state"],
        { cwd: this.cwd },
      );
      // Non-zero exit is transient (network/5xx) — retry so a flaky view right
      // after a landed merge can't re-introduce the #38 misclassification.
      if (!r.ok) {
        lastFailure = `gh pr view exit ${r.code}: ${r.stderr.trim() || "<no stderr>"}`;
        if (!last) await wait();
        continue;
      }
      // Malformed/truncated stdout is equally transient — retry too, so the
      // hardening covers the same failure mode as !r.ok (symmetric).
      let s: string | undefined;
      try {
        s = (JSON.parse(r.stdout) as { state?: string }).state;
      } catch {
        lastFailure = `gh pr view returned malformed json: ${r.stdout.trim().slice(0, 120) || "<empty>"}`;
        if (!last) await wait();
        continue;
      }
      if (s === "OPEN" || s === "MERGED" || s === "CLOSED") return { state: s };
      // Well-formed but unrecognized state is terminal — retrying won't change
      // it — so concede immediately rather than burn the retry budget.
      return { state: null, failure: `unrecognized pr state: ${s ?? "<missing>"}` };
    }
    return { state: null, failure: lastFailure };
  }

  /** Close an issue with an explanatory comment. */
  async closeIssue(number: number, comment: string): Promise<void> {
    await mustRun(["gh", "issue", "close", String(number), "--comment", comment], { cwd: this.cwd });
  }
}
