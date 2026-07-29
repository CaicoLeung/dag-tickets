#!/usr/bin/env bun
/**
 * e2e shim for `git`, installed onto the temp PATH ONLY when a scenario sets
 * `fetchFailBase` (the stale-base test). It intercepts `git fetch` and fails
 * the first `fetchFailBase` base-refresh fetches (self-limiting: this shim
 * advances its own counter under the state lock, so no external "repair" is
 * needed between attempts), then passes through to the REAL git. Every other
 * git subcommand (push / rev-parse / worktree / commit-tree / …) passes
 * through untouched, so the rest of the real git surface — ShellBranch /
 * ShellPullRequest and the paseo shim — runs unchanged.
 *
 * Why a git shim and not a broken origin: `ensureBaseRefFresh` runs `git fetch`
 * in the MAIN process and `stale-base` returns BEFORE the agent dispatch, so
 * there is no subprocess between attempt N's failed fetch and attempt N+1's
 * fetch that could "repair" a broken origin. This shim makes the failure
 * self-limiting instead: the counter it advances IS the recovery signal.
 *
 * The real git binary path arrives via DAG_E2E_REAL_GIT (resolved by the
 * harness against the pre-shim PATH, so it never resolves back to this shim).
 * Shares DAG_E2E_SCENARIO (read-only) / DAG_E2E_STATE (mutable, same file the
 * gh/paseo shims write) so the fetch-fail counter stays coherent. Self-
 * contained at runtime (Bun globals + ./util.ts).
 */
import {
  DEFAULT_STATE,
  readJson,
  writeJson,
  withStateLock,
  withDefaults,
} from "./util.ts";

const argv = process.argv.slice(2);
const SCEN = process.env.DAG_E2E_SCENARIO;
const STATE = process.env.DAG_E2E_STATE;
const REAL_GIT = process.env.DAG_E2E_REAL_GIT;

if (!REAL_GIT) {
  process.stderr.write("git shim: DAG_E2E_REAL_GIT not set\n");
  process.exit(70); // EX_SOFTWARE — harness wiring bug, not a test outcome
}

const scen = await readJson(SCEN, {});

// Intercept `git fetch` — the base-refresh fetch issued by
// ensureBaseRefFresh / resolveBranchOffBase (`git fetch origin
// +<base>:refs/remotes/origin/<base>`). In a non-overlap run these are the
// ONLY fetches, so matching argv[0]==="fetch" is exact for the stale-base
// scenario. Fail the first `fetchFailBase`, then pass through. The counter is
// advanced BEFORE failing (so the retry's fetch sees it bumped even though the
// failing fetch itself writes nothing), making the failure self-limiting.
const failBudget = Number(scen.fetchFailBase) || 0;
if (argv[0] === "fetch" && failBudget > 0) {
  let fail = false;
  await withStateLock(STATE, async () => {
    const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
    s.baseFetchFails = s.baseFetchFails || 0;
    if (s.baseFetchFails < failBudget) {
      fail = true;
      s.baseFetchFails++;
    }
    await writeJson(STATE, s);
  });
  if (fail) {
    // Mirror real git's "remote unreadable" stderr so a human triaging the
    // event trace sees a plausible fetch failure (the reason is `stale-base`).
    process.stderr.write("fatal: could not read from remote repository.\n");
    process.exit(1);
  }
}

// Passthrough to the real git, inheriting stdio + cwd so run()'s captured
// stdout/stderr/exit behave exactly as a direct git invocation.
const r = Bun.spawnSync({
  cmd: [REAL_GIT, ...argv],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(typeof r.exitCode === "number" ? r.exitCode : 1);
