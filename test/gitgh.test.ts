import { test, expect, describe } from "bun:test";
import { branchFor, ensureMergedBase, mergedReference, ShellBranch, ShellPullRequest } from "../src/gitgh.ts";
import { run } from "../src/shell.ts";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("branchFor", () => {
  test("truncation never leaves a trailing hyphen (#457 regression)", () => {
    // Title slugifies to 50+ chars; slice(0,40) used to land on "...via-".
    const got = branchFor(
      457,
      "I2 — Deepen SafariWebExtensionHandler via the Shared Kernel",
    );
    expect(got).toBe("loop/457-i2-deepen-safariwebextensionhandler-via");
    expect(got.endsWith("-")).toBe(false);
  });

  test("lowercases and hyphenates a short title", () => {
    expect(branchFor(12, "Dedup Word Tap Dispatch")).toBe(
      "loop/12-dedup-word-tap-dispatch",
    );
  });

  test("strips leading/trailing punctuation", () => {
    expect(branchFor(1, "  --Hello, World!!  ")).toBe("loop/1-hello-world");
  });

  test("falls back to 'ticket' when the slug is empty", () => {
    expect(branchFor(1, "### ???")).toBe("loop/1-ticket");
  });

  test("result never ends with a hyphen across long titles", () => {
    const titles = [
      "Some Very Long Title That Definitely Exceeds Forty Characters Easily",
      "A B C D E F G H H I J K L M N O P Q R S T U V W X Y Z More Words Here",
    ];
    for (const t of titles) {
      const got = branchFor(99, t);
      expect(got.endsWith("-")).toBe(false);
    }
  });
});

describe("ShellBranch.resolveRemoteTip (#29)", () => {
  test("fetches a pushed ref and resolves its 40-char tip SHA; null when absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dag-tip-"));
    const origin = join(tmp, "origin.git");
    const work = join(tmp, "work");
    const other = join(tmp, "other");
    const g = (args: string[], cwd?: string) =>
      run(["git", ...args], {
        cwd,
        env: {
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });

    await g(["init", "--bare", origin]);
    await g(["clone", "--quiet", origin, work]);
    await writeFile(join(work, "a.txt"), "x");
    await g(["add", "-A"], work);
    await g(["commit", "--quiet", "-m", "init"], work);
    await g(["branch", "loop/42-foo"], work);
    await g(["push", "--quiet", "origin", "loop/42-foo"], work);

    // A fresh clone plays the dependent's repo: `origin` is wired, and the
    // blocker's head ref is reachable via fetch.
    await g(["clone", "--quiet", origin, other]);
    const sb = new ShellBranch(other);

    const sha = await sb.resolveRemoteTip("loop/42-foo");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // A ref never pushed → null (blocker hasn't reached its createPr step).
    expect(await sb.resolveRemoteTip("loop/99-missing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ShellPullRequest.mergePr (#38): `gh pr merge --delete-branch` exits non-zero
// when the local branch can't be deleted (checked out in a worktree) even
// though the server-side merge landed. mergePr must reconcile against GitHub's
// authoritative PR state and treat a MERGED PR as success — otherwise the
// lifecycle misclassifies it as a retryable `merge-race` and re-implements the
// already-merged ticket (duplicate PRs).
// ---------------------------------------------------------------------------

/** Options for the tiny gh shim installed for mergePr tests.
 *  - mergeExit: exit code for `gh pr merge` (the local --delete-branch step).
 *  - serverMerged: whether the server-side merge landed → drives
 *    `gh pr view --json state` (MERGED vs OPEN).
 *  - viewFailsBeforeSuccess: how many `gh pr view` calls fail (exit 1) before
 *    the state is returned — exercises mergePr's reconciliation retry on a
 *    non-zero exit.
 *  - viewGarbledBeforeSuccess: how many `gh pr view` calls return malformed
 *    JSON (exit 0) before the state is returned — exercises the retry on a
 *    garbled/truncated response, the symmetric half of the transient path. */
interface GhShimOpts {
  mergeExit: number;
  serverMerged: boolean;
  viewFailsBeforeSuccess?: number;
  viewGarbledBeforeSuccess?: number;
}

/** Install an executable `gh` on a temp PATH that simulates a merge whose
 *  local --delete-branch step can fail while the server-side merge may still
 *  have landed. Returns a restore() that puts PATH back. The shim is
 *  self-contained (reads its behaviour from a JSON cfg) and uses an absolute
 *  bun shebang so it runs even if bun isn't on the child's PATH. */
async function installGhShim(opts: GhShimOpts): Promise<{ restore: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), "dag-ghshim-"));
  const cfg = join(dir, "cfg.json");
  // Persistent view-call counter across the separate shim processes, so a test
  // can script "the first N pr-view calls flake, then succeed".
  const views = join(dir, "views.txt");
  await Bun.write(
    cfg,
    JSON.stringify({
      ...opts,
      viewFails: opts.viewFailsBeforeSuccess ?? 0,
      viewGarbled: opts.viewGarbledBeforeSuccess ?? 0,
    }),
  );
  await Bun.write(views, "0");
  const ghPath = join(dir, "gh");
  const src =
    `#!${process.execPath}\n` +
    `import { readFileSync, writeFileSync } from "node:fs";\n` +
    `const cfg = JSON.parse(readFileSync(${JSON.stringify(cfg)}, "utf8"));\n` +
    `const a = process.argv.slice(2);\n` +
    `const out = (s) => process.stdout.write(s);\n` +
    `const exit = (c) => process.exit(c);\n` +
    `if (a[0] === "pr" && a[1] === "merge") {\n` +
    `  out(cfg.mergeExit === 0 ? "" : "delete-branch failed\\n");\n` +
    `  exit(cfg.mergeExit);\n` +
    `}\n` +
    `if (a[0] === "pr" && a[1] === "view" && a.includes("--json")) {\n` +
    `  const ctr = ${JSON.stringify(views)};\n` +
    `  let n = parseInt(readFileSync(ctr, "utf8") || "0", 10) || 0;\n` +
    `  n++;\n` +
    `  writeFileSync(ctr, String(n));\n` +
    `  if (cfg.viewFails && n <= cfg.viewFails) { process.stderr.write("transient gh error\\n"); exit(1); }\n` +
    `  if (cfg.viewGarbled && n <= cfg.viewGarbled) { out("{ not json\\n"); exit(0); }\n` +
    `  out(JSON.stringify({ state: cfg.serverMerged ? "MERGED" : "OPEN" }) + "\\n");\n` +
    `  exit(0);\n` +
    `}\n` +
    `process.stderr.write("gh-shim: unhandled " + JSON.stringify(process.argv) + "\\n");\n` +
    `exit(2);\n`;
  await Bun.write(ghPath, src);
  await chmod(ghPath, 0o755);
  const prev = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${prev}`;
  return { restore: () => { process.env.PATH = prev; } };
}

describe("ShellPullRequest.mergePr (#38)", () => {
  test("non-zero exit but PR MERGED on GitHub → resolves (no throw)", async () => {
    // The worktree-can't-delete-branch case: gh pr merge exits 1 after the
    // server-side squash already landed. Reconciling via pr view must turn
    // this into a success so the ticket isn't re-implemented.
    const { restore } = await installGhShim({ mergeExit: 1, serverMerged: true });
    try {
      const pr = new ShellPullRequest();
      await expect(pr.mergePr(42, "squash")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("non-zero exit and PR still OPEN → throws (genuine merge failure)", async () => {
    // A real merge failure (base moved / conflict): the PR is still open, so
    // the merge-race retry path must be preserved.
    const { restore } = await installGhShim({ mergeExit: 1, serverMerged: false });
    try {
      const pr = new ShellPullRequest();
      await expect(pr.mergePr(42, "squash")).rejects.toThrow(/gh pr merge failed/);
    } finally {
      restore();
    }
  });

  test("exit 0 → resolves without consulting pr view", async () => {
    // Happy path: gh pr merge succeeds outright; no reconciliation needed.
    const { restore } = await installGhShim({ mergeExit: 0, serverMerged: false });
    try {
      const pr = new ShellPullRequest();
      await expect(pr.mergePr(42, "squash")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("transient gh pr view failure after a landed merge → still resolves (retry)", async () => {
    // Closes the residual #38 gap: `gh pr view` itself can flake (non-zero
    // exit) right after a merge that already landed. reconcilePrState retries
    // so a transient failure doesn't make mergePr throw → merge-race → dup PR.
    const { restore } = await installGhShim({
      mergeExit: 1,
      serverMerged: true,
      viewFailsBeforeSuccess: 2, // tolerated by the bounded retry (3 attempts)
    });
    try {
      const pr = new ShellPullRequest();
      await expect(pr.mergePr(42, "squash")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("transient malformed gh pr view output after a landed merge → still resolves (retry)", async () => {
    // Symmetric half of the retry: `gh pr view` exits 0 but returns
    // malformed/truncated JSON. Pre-fix this short-circuited to null → mergePr
    // threw → merge-race → duplicate PR, so the hardening only covered a
    // non-zero exit. reconcilePrState now retries a parse failure too.
    const { restore } = await installGhShim({
      mergeExit: 1,
      serverMerged: true,
      viewGarbledBeforeSuccess: 2, // tolerated by the bounded retry (3 attempts)
    });
    try {
      const pr = new ShellPullRequest();
      await expect(pr.mergePr(42, "squash")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback B2 — mergedReference: detect work already merged on base via a
// precise commit-message reference (#N squash-merge title, or a Closes/Fixes/
// Resolves trailer) so dag-tickets skips re-implementing it.
// ---------------------------------------------------------------------------
describe("mergedReference (B2) — already-merged-on-base heuristic", () => {
  const GENV = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  /** Build a bare origin + clone whose `main` has the given commit specs. */
  async function repoWith(subjects: Array<{ subject: string; body?: string }>): Promise<string> {
    const origin = await mkdtemp(join(tmpdir(), "dag-mr-origin-"));
    const work = await mkdtemp(join(tmpdir(), "dag-mr-work-"));
    const g = (args: string[], cwd?: string) => run(["git", ...args], { cwd, env: GENV });
    await g(["init", "--bare", "-b", "main", origin]);
    await g(["init", "-b", "main", work]);
    await g(["remote", "add", "origin", origin], work);
    await writeFile(join(work, "a.txt"), "init\n");
    await g(["add", "-A"], work);
    await g(["commit", "--quiet", "-m", "init"], work);
    for (const c of subjects) {
      await writeFile(join(work, "a.txt"), `${c.subject}\n`);
      await g(["add", "-A"], work);
      // commit message = subject (+ optional body)
      await g(["commit", "--quiet", "-m", c.subject, ...c.body ? ["-m", c.body] : []], work);
    }
    await g(["push", "--quiet", "-u", "origin", "main"], work);
    return work;
  }

  test("a squash-merge title (#465) is detected", async () => {
    const cwd = await repoWith([
      { subject: "feat: cut over DictionaryModels (#465)" },
      { subject: "docs: unrelated (#4650)" },
    ]);
    const r = await mergedReference(465, "main", cwd);
    expect(r.merged).toBe(true);
    expect(r.subject).toContain("(#465)");
  });

  test("a number only present as #4650 does NOT match #465 (no false positive)", async () => {
    const cwd = await repoWith([{ subject: "refactor: relates to #4650" }]);
    const r = await mergedReference(465, "main", cwd);
    expect(r.merged).toBe(false);
  });

  test("a Closes/Fixes/Resolves trailer in the body is detected", async () => {
    const cwd = await repoWith([
      { subject: "merge: land thing", body: "This closes #471." },
    ]);
    expect((await mergedReference(471, "main", cwd)).merged).toBe(true);
    expect((await mergedReference(472, "main", cwd)).merged).toBe(false);
  });

  test("a number with no merge reference returns merged:false", async () => {
    const cwd = await repoWith([{ subject: "feat: x (#465)" }]);
    expect((await mergedReference(999, "main", cwd)).merged).toBe(false);
  });

  // Architectural fix: the original precise alternation `(^|[^\d])#N(?!\d)` matched
  // ANY standalone #N in prose — "relates to #465", "see #465" — and falsely
  // skipped work that hadn't actually merged. The feedback explicitly lists
  // "relates to #465" as a case that must NOT match. Only (#N) (the squash-merge
  // title trailer) or a Closes/Fixes/Resolves trailer counts.
  test("a bare #N in prose is NOT a merge (no false positive on 'relates to #N')", async () => {
    const cwd = await repoWith([
      { subject: "docs: see relates to #465 for context" },
      { subject: "chore: a note about #465 and friends" },
    ]);
    expect((await mergedReference(465, "main", cwd)).merged).toBe(false);
  });

  test("(#N) with surrounding prose parens is NOT a match (no '(see #N …)' false positive)", async () => {
    const cwd = await repoWith([
      { subject: "refactor: cleanup (see #465 and #466 for details)" },
    ]);
    expect((await mergedReference(465, "main", cwd)).merged).toBe(false);
    expect((await mergedReference(466, "main", cwd)).merged).toBe(false);
  });

  test("ensureMergedBase + { fetch: false } skips the per-ticket fetch (batch path)", async () => {
    // The batch path calls ensureMergedBase once then scans N tickets with
    // { fetch: false }. Prove the { fetch: false } path still reads the same
    // origin/base as the default (fetch: true) path — they agree on the verdict.
    const cwd = await repoWith([
      { subject: "feat: cut over X (#500)" },
    ]);
    await ensureMergedBase("main", cwd);
    const withFetch = await mergedReference(500, "main", cwd, { fetch: true });
    const withoutFetch = await mergedReference(500, "main", cwd, { fetch: false });
    expect(withFetch.merged).toBe(true);
    expect(withoutFetch.merged).toBe(true);
    // A number referenced by no commit stays unmerged under either path.
    expect((await mergedReference(999, "main", cwd, { fetch: false })).merged).toBe(false);
  });
});
