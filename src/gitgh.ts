import { mustRun, run } from "./shell.ts";
import type { CheckResult, CreatePrOpts, MergeStrategy, RepoPort } from "./ports.ts";

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
 * Real {@link RepoPort} adapter: shells out to `git` (worktree/branch hygiene)
 * and `gh` (PR/CI/merge/issue). The lifecycle never sees these commands — it
 * crosses the seam at {@link RepoPort}.
 */
export class ShellRepo implements RepoPort {
  constructor(
    private readonly cwd?: string,
    /** Watch-checks timeout; undefined polls indefinitely (current behaviour). */
    private readonly timeoutMs?: number,
  ) {}

  /**
   * Remove any linked worktree whose HEAD is on `branch`. Git forbids a branch
   * being checked out in more than one worktree, so a leftover worktree from a
   * prior dispatch makes a later `checkout-branch` dispatch fail with "Branch
   * already checked out". Commits live on the branch ref, so forcing removal
   * here loses no work. The main checkout is never on a `loop/` branch.
   */
  async cleanBranch(branch: string): Promise<void> {
    const target = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
    const r = await run(["git", "worktree", "list", "--porcelain"], { cwd: this.cwd });
    if (!r.ok) return;
    const toRemove: string[] = [];
    let path = "";
    let onBranch = false;
    const flush = () => {
      if (path && onBranch) toRemove.push(path);
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
    for (const p of toRemove) {
      await run(["git", "worktree", "remove", "--force", p], { cwd: this.cwd });
    }
  }

  async commitCount(base: string, branch: string): Promise<number> {
    const r = await run(["git", "rev-list", "--count", `${base}..${branch}`], { cwd: this.cwd });
    if (!r.ok) return 0;
    return parseInt(r.stdout.trim(), 10) || 0;
  }

  async deleteBranch(branch: string): Promise<void> {
    await run(["git", "branch", "-D", branch], { cwd: this.cwd });
  }

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
   * on the first failing check. A PR with no checks prints "no checks" and
   * exits 0 → we report `none` (the caller decides whether that satisfies the
   * merge gate via --require-checks).
   */
  async watchChecks(prNumber: number): Promise<CheckResult> {
    const watch = await run(
      ["gh", "pr", "checks", String(prNumber), "--watch", "--fail-fast", "--interval", "30"],
      { cwd: this.cwd, timeoutMs: this.timeoutMs },
    );
    if (watch.timedOut) return { state: "fail", failed: ["checks-watch-timeout"] };
    // "no checks" is an exit-0 case with that text on stderr/stdout.
    const blob = (watch.stdout + watch.stderr).toLowerCase();
    if (watch.ok && /no checks|nothing to check/.test(blob)) {
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

  /** Merge a PR and delete its branch. */
  async mergePr(prNumber: number, strategy: MergeStrategy): Promise<void> {
    const flag = strategy === "squash" ? "--squash" : strategy === "rebase" ? "--rebase" : "--merge";
    await mustRun(["gh", "pr", "merge", String(prNumber), flag, "--delete-branch"], { cwd: this.cwd });
  }

  /** Close an issue with an explanatory comment. */
  async closeIssue(number: number, comment: string): Promise<void> {
    await mustRun(["gh", "issue", "close", String(number), "--comment", comment], { cwd: this.cwd });
  }
}
