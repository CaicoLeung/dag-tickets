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
 *   DAG_E2E_STATE    — mutable per-run scratch: PR counter, merged set, and
 *                      the paseo shim's verdict pointer (shared so a review
 *                      `paseo run` advances the verdict that `paseo logs`
 *                      then serves stably across polling).
 *
 * Self-contained: only Bun globals (Bun.file/Bun.write/process) so the file
 * runs identically whether executed by name on PATH or re-shebang'd by the
 * harness with an absolute bun path.
 */
(async () => {
  const argv = process.argv.slice(2);
  const SCEN = process.env.DAG_E2E_SCENARIO;
  const STATE = process.env.DAG_E2E_STATE;

  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);
  const exit = (c) => process.exit(c);

  const readJson = async (p, fb) => {
    if (!p) return fb;
    try {
      return JSON.parse(await Bun.file(p).text());
    } catch {
      return fb;
    }
  };
  const writeJson = async (p, v) => {
    if (p) await Bun.write(p, JSON.stringify(v, null, 2));
  };

  const scen = await readJson(SCEN, {});
  const state = await readJson(STATE, {
    prCounter: 1000,
    merged: [],
    prHeads: {},
    reviewIdx: {},
    currentVerdict: {},
  });

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

  // gh api graphql -f query=...  (listSubIssues: parent number parsed from query)
  if (cmd === "api" && sub === "graphql") {
    const qi = argv.indexOf("-f");
    const qstr = qi >= 0 ? argv[qi + 1] : "";
    const m = /issue\(number:\s*(\d+)\)/.exec(qstr);
    const parent = m ? m[1] : null;
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
    state.prCounter = (state.prCounter || 1000) + 1;
    const pr = state.prCounter;
    state.prHeads = state.prHeads || {};
    state.prHeads[String(pr)] = head;
    await writeJson(STATE, state);
    out(`https://github.com/e2e/test/pull/${pr}\n`);
    exit(0);
  }

  // gh pr checks <n> --watch --fail-fast --interval 30
  if (cmd === "pr" && sub === "checks" && argv.includes("--watch")) {
    const outcome = scen.checks || "none";
    if (outcome === "none") {
      err("No checks.\n");
      exit(0);
    }
    if (outcome === "pass") exit(0);
    exit(1); // fail
  }

  // gh pr checks <n> --json name,state   (gathered after a --watch failure)
  if (cmd === "pr" && sub === "checks" && argv.includes("--json")) {
    out(JSON.stringify([{ name: "ci", state: "FAILURE" }]) + "\n");
    exit(0);
  }

  // gh pr merge <n> squash|merge|rebase --delete-branch
  if (cmd === "pr" && sub === "merge") {
    const n = parseInt(argv[2], 10);
    state.merged = state.merged || [];
    if (!state.merged.includes(n)) state.merged.push(n);
    await writeJson(STATE, state);
    exit(0);
  }

  // gh issue close <n> --comment ...
  if (cmd === "issue" && sub === "close") {
    exit(0);
  }

  err(`gh shim: unhandled argv: ${JSON.stringify(argv)}\n`);
  exit(2);
})();
