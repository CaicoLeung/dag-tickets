import { test, expect, describe } from "bun:test";
import { branchFor, ShellBranch } from "../src/gitgh.ts";
import { run } from "../src/shell.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
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
