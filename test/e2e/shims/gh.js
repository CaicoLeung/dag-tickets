#!/usr/bin/env bun
/**
 * e2e shim for the `gh` GitHub CLI.
 *
 * Used by test/e2e/harness.ts. Installed onto a temp PATH as an executable
 * named `gh`, so the real `src/shell.ts` → `Bun.spawn(["gh", ...])` boundary
 * in gitgh.ts/discover.ts is exercised for real — no module mocking.
 *
 * Behaviour is driven entirely by two files whose paths arrive via env:
 *   DAG_E2E_SCENARIO — read-only fixtures: issues, label→numbers, parents,
 *                      checks outcome (pass|fail|none), verdicts, etc.
 *   DAG_E2E_STATE    — mutable per-run scratch shared with the paseo shim:
 *                      PR counter, merged set, per-ticket verdict pointer,
 *                      merge strategy, closed issues, checks sequence index,
 *                      and the overlap watch-release latch. See shims/util.js
 *                      DEFAULT_STATE for the full shape.
 *
 * Served commands: repo view, issue view|list|close, api graphql (sub-issues),
 * pr create|checks(--watch|--json)|merge.
 *
 * Self-contained at runtime (only Bun globals + ./util.js). The harness copies
 * util.js next to the installed `gh` so the import resolves from the temp bin.
 */
import {
  DEFAULT_STATE,
  readJson,
  writeJson,
  withStateLock,
  withDefaults,
  ticketFromHead,
  sleep,
} from "./util.ts";

(async () => {
  const argv = process.argv.slice(2);
  const SCEN = process.env.DAG_E2E_SCENARIO;
  const STATE = process.env.DAG_E2E_STATE;

  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);
  const exit = (c) => process.exit(c);

  const scen = await readJson(SCEN, {});

  const cmd = argv[0];
  const sub = argv[1];

  // gh repo view --json nameWithOwner,defaultBranchRef
  if (cmd === "repo" && sub === "view") {
    out(JSON.stringify({ nameWithOwner: "e2e/test", defaultBranchRef: { name: "main" } }) + "\n");
    exit(0);
  }

  // gh issue view <n> --json number,title,body,url,state,labels
  if (cmd === "issue" && sub === "view") {
    const n = parseInt(argv[2], 10);
    const iss = (scen.issues || {})[String(n)];
    if (!iss) {
      err(`gh shim: issue #${n} not in scenario\n`);
      exit(1);
    }
    out(JSON.stringify(iss) + "\n");
    exit(0);
  }

  // gh issue list --label <l> --state open --json ... --limit 200
  if (cmd === "issue" && sub === "list") {
    const i = argv.indexOf("--label");
    const label = i >= 0 ? argv[i + 1] : "";
    const nums = (scen.labels || {})[label] || [];
    const arr = nums.map((n) => (scen.issues || {})[String(n)]).filter(Boolean);
    out(JSON.stringify(arr) + "\n");
    exit(0);
  }

  // gh api graphql -f query=... -F parent=...  (listSubIssues)
  if (cmd === "api" && sub === "graphql") {
    // parent is bound via -F parent=<n> (typed GraphQL variable, never interpolated).
    let parent: string | null = null;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "-F" && argv[i + 1]?.startsWith("parent=")) {
        parent = argv[i + 1].slice("parent=".length);
        break;
      }
    }
    let nodes = [];
    if (parent && scen.parents && scen.parents[parent]) {
      nodes = scen.parents[parent]
        .map((n) => (scen.issues || {})[String(n)])
        .filter(Boolean);
    }
    out(JSON.stringify({ data: { repository: { issue: { subIssues: { nodes } } } } }) + "\n");
    exit(0);
  }

  // gh pr create --title T --body B --head H --base B [--draft]
  if (cmd === "pr" && sub === "create") {
    const i = argv.indexOf("--head");
    const head = i >= 0 ? argv[i + 1] : "";
    const num = ticketFromHead(head);
    await withStateLock(STATE, async () => {
      const state = withDefaults(await readJson(STATE, DEFAULT_STATE));
      state.prCounter = (state.prCounter || 1000) + 1;
      const pr = state.prCounter;
      state.prHeads = state.prHeads || {};
      state.prTickets = state.prTickets || {};
      state.prHeads[String(pr)] = head;
      if (num) state.prTickets[String(pr)] = num;
      await writeJson(STATE, state);
      out(`https://github.com/e2e/test/pull/${pr}\n`);
    });
    exit(0);
  }

  // gh pr list --head <H> --state open --json number --limit 1
  // (#32 divergence guard): an open PR tracking the head means this is one of
  // our own re-attempts (retry / resumed run / prior batch), so the guard
  // overwrites the stale branch instead of refusing. Returns the first open
  // (non-merged) PR whose head matches, else [].
  if (cmd === "pr" && sub === "list") {
    const i = argv.indexOf("--head");
    const head = i >= 0 ? argv[i + 1] : "";
    const state = withDefaults(await readJson(STATE, DEFAULT_STATE));
    const merged = state.merged || [];
    let found = null;
    for (const [pr, h] of Object.entries(state.prHeads || {})) {
      if (h === head && !merged.includes(parseInt(pr, 10))) {
        found = { number: parseInt(pr, 10) };
        break;
      }
    }
    out(JSON.stringify(found ? [found] : []) + "\n");
    exit(0);
  }

  // gh pr checks <n> --watch --fail-fast --interval 30
  // Outcome, per PR's ticket (looked up via prTickets):
  //   - stuckChecksFirst[<n>] (first call only) → sleep past the parent's
  //     ci-watch ceiling so run() kills it (timedOut) → checks-watch-timeout.
  //     The latch is persisted BEFORE sleeping (the kill can't write it), so
  //     the retry's --watch falls through to the scripted outcome below.
  //   - checksSeq[<n>] = ["fail","pass",...] → serve one per watch call (transient CI)
  //   - holdWatch[<n>]   → block until state.releaseWatch flips true (overlap choreography)
  //   - else            → scen.checks ("pass"|"fail"|"none")
  if (cmd === "pr" && sub === "checks" && argv.includes("--watch")) {
    const pr = parseInt(argv[2], 10);
    let outcome = scen.checks || "none";

    // Resolve the ticket this PR belongs to, then apply per-ticket scripting.
    const state0 = withDefaults(await readJson(STATE, DEFAULT_STATE));
    const num = state0.prTickets[String(pr)] || 0;

    // stuckChecksFirst: the FIRST --watch for this ticket sleeps past the
    // parent's ci-watch timeout so run() kills it (timedOut) →
    // {state:"fail", failed:["checks-watch-timeout"]} → transient ci-failed.
    // Latch persisted BEFORE the sleep (the kill can't), so the retry falls
    // through to the scripted outcome below. Bounded sleep so a missing-
    // timeout bug fails loudly instead of hanging the suite.
    if (num && Array.isArray(scen.stuckChecksFirst) && scen.stuckChecksFirst.includes(num)) {
      let first = false;
      await withStateLock(STATE, async () => {
        const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
        s.stuckHit = s.stuckHit || {};
        first = !s.stuckHit[String(num)];
        if (first) s.stuckHit[String(num)] = true;
        await writeJson(STATE, s);
      });
      if (first) {
        await sleep(5000);
        exit(1); // fail — reached only if the timeout never fired (bug guard)
      }
      // not first → fall through to the scripted outcome below
    }

    if (num && scen.checksSeq && Array.isArray(scen.checksSeq[String(num)])) {
      // Advance the per-ticket pointer under the lock so concurrent watchers
      // (not used today, but the shape matches pr create) can't double-read.
      await withStateLock(STATE, async () => {
        const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
        s.checksIdx = s.checksIdx || {};
        const idx = s.checksIdx[String(num)] || 0;
        const seq = scen.checksSeq[String(num)];
        outcome = seq[Math.min(idx, seq.length - 1)];
        s.checksIdx[String(num)] = idx + 1;
        await writeJson(STATE, s);
      });
    } else if (num && scen.holdWatch && scen.holdWatch.includes(num)) {
      // Block until the overlap-dependent's implement has actually run
      // (state.dependentLaunched). Holding on the dependent's implement — not
      // a pacer's merge — removes the race where the blocker would settle
      // before the dependent overlap-launched. Bounded (~30s) so a broken
      // choreography fails loudly instead of hanging the test.
      // holdWatchFail: once released, serve `fail` (not `pass`) so the blocker
      // settles terminally failed — cascading an in-flight overlap-dependent
      // via the #20 abort branch.
      const fail = Array.isArray(scen.holdWatchFail) && scen.holdWatchFail.includes(num);
      for (let i = 0; i < 6000; i++) {
        const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
        if (s.dependentLaunched) {
          outcome = fail ? "fail" : "pass";
          break;
        }
        await sleep(5);
      }
      outcome = fail ? "fail" : "pass";
    }

    if (outcome === "none") {
      // Mirror real gh: a PR that triggers zero check workflows prints
      // "no checks reported on the '<branch>' branch" to stderr and exits
      // 1 (not 0). watchChecks must resolve this to `none` regardless of exit
      // code (#37).
      err("no checks reported on the 'head' branch\n");
      exit(1);
    }
    if (outcome === "pass") exit(0);
    exit(1); // fail
  }

  // gh pr checks <n> --json name,state   (gathered after a --watch failure)
  if (cmd === "pr" && sub === "checks" && argv.includes("--json")) {
    out(JSON.stringify([{ name: "ci", state: "FAILURE" }]) + "\n");
    exit(0);
  }

  // gh pr view <n> --json state   (authoritative PR state; used by mergePr
  // to reconcile a --delete-branch failure against the server-side merge
  // result. A PR is MERGED iff gh pr merge recorded it, else OPEN.)
  if (cmd === "pr" && sub === "view" && argv.includes("--json")) {
    const n = parseInt(argv[2], 10);
    const state = withDefaults(await readJson(STATE, DEFAULT_STATE));
    const merged = (state.merged || []).includes(n);
    out(JSON.stringify({ state: merged ? "MERGED" : "OPEN" }) + "\n");
    exit(0);
  }

  // gh pr merge <n> squash|merge|rebase --delete-branch
  // Records the merged PR + the strategy flag gh received (asserts
  // --merge-strategy). Scenario flag `mergeDeleteBranchFails` simulates the
  // #38 race: the server-side merge lands (recorded) but the local
  // --delete-branch step fails (branch checked out in a worktree) so gh exits
  // 1 — mergePr reconciles via `gh pr view --json state` instead of throwing.
  if (cmd === "pr" && sub === "merge") {
    const n = parseInt(argv[2], 10);
    // mergePr sends the strategy as a `--squash`/`--merge`/`--rebase` flag; pull
    // it out so a test can assert --merge-strategy reached the subprocess.
    const strat =
      argv.find((a, idx) => idx > 2 && /^--(squash|merge|rebase)$/.test(a))?.slice(2) ||
      "squash";
    let deleteBranchFails = false;
    await withStateLock(STATE, async () => {
      const state = withDefaults(await readJson(STATE, DEFAULT_STATE));
      // Server-side merge lands first, regardless of the local delete-branch
      // outcome — so `gh pr view --json state` reconciles to MERGED.
      state.merged = state.merged || [];
      if (!state.merged.includes(n)) state.merged.push(n);
      state.mergedStrategies = state.mergedStrategies || {};
      state.mergedStrategies[String(n)] = strat;
      const num = (state.prTickets || {})[String(n)] || 0;
      if (num && scen.mergeDeleteBranchFails && scen.mergeDeleteBranchFails.includes(num)) {
        deleteBranchFails = true;
      }
      await writeJson(STATE, state);
    });
    if (deleteBranchFails) {
      err("delete-branch failed: branch is checked out in a worktree\n");
      exit(1);
    }
    exit(0);
  }

  // gh issue close <n> --comment ...
  if (cmd === "issue" && sub === "close") {
    const n = parseInt(argv[2], 10);
    await withStateLock(STATE, async () => {
      const state = withDefaults(await readJson(STATE, DEFAULT_STATE));
      state.closed = state.closed || [];
      if (!state.closed.includes(n)) state.closed.push(n);
      await writeJson(STATE, state);
    });
    exit(0);
  }

  err(`gh shim: unhandled argv: ${JSON.stringify(argv)}\n`);
  exit(2);
})();
