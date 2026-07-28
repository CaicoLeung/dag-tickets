#!/usr/bin/env bun
/**
 * e2e shim for the `paseo` CLI.
 *
 * Installed onto a temp PATH as `paseo` so the real dispatch path in
 * src/paseo.ts (paseo run / paseo logs / paseo ls / paseo stop) is exercised
 * for real through `Bun.spawn` — no module mocking.
 *
 * Two jobs:
 *   1. `paseo run` (branch-off, implement/single-shot): create a REAL git
 *      branch carrying one commit ahead of base, using commit-tree + update-ref
 *      so the working tree and index are never touched (concurrency-safe, and
 *      matches what PaseoAgent.implement verifies via BranchPort.commitCount).
 *   2. Review verdicts: a review `paseo run` advances the per-ticket verdict
 *      pointer in DAG_E2E_STATE; `paseo logs dag-<n>-review` then serves that
 *      verdict STABLY across the stable-log polling loop (dispatch polls until
 *      output stops changing), so one review = one verdict — and the next
 *      review run advances to the next verdict in the scripted sequence
 *      (driving the fix-loop: ["issues:2","clean"]).
 *
 * Shares DAG_E2E_SCENARIO (read-only) + DAG_E2E_STATE (mutable, same file the
 * gh shim writes) so PR/verdict counters stay coherent. Self-contained: Bun
 * globals only.
 */
(async () => {
  const argv = process.argv.slice(2);
  const SCEN = process.env.DAG_E2E_SCENARIO;
  const STATE = process.env.DAG_E2E_STATE;
  const cwd = process.cwd();

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

  // Synchronous git (the shim is a short-lived process; spawnSync keeps the
  // commit-tree dance sequential and simple). Returns parsed stdout.
  const git = (args) => {
    const r = Bun.spawnSync({ cmd: ["git", ...args], cwd });
    const stdout = r.stdout ? r.stdout.toString() : "";
    return { ok: r.exitCode === 0, stdout };
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

  // paseo ls --json  (abort path: nothing running)
  if (cmd === "ls") {
    out(JSON.stringify({ agents: [] }) + "\n");
    exit(0);
  }

  // paseo stop <id>
  if (cmd === "stop") {
    exit(0);
  }

  if (cmd === "run") {
    const pick = (flag) => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : "";
    };
    const slug = pick("--worktree-slug") || "agent";
    const wtMode = pick("--worktree-mode");
    const title = pick("--title") || "";
    const base = pick("--base") || "origin/main";
    const branch = wtMode === "branch-off" ? pick("--new-branch") : pick("--branch");

    // Skill + ticket number come from the title PaseoAgent sets
    // ("implement #N" / "review #N" / "fix #N rR" / "triage #N" / "research #N").
    const tm = /^(\w+)\s+#(\d+)/.exec(title);
    const skill = tm ? tm[1] : "";
    const num = tm ? parseInt(tm[2], 10) : 0;

    // branch-off (implement / single-shot): materialise the branch with one
    // commit ahead of base, unless the scenario scripts an empty implement.
    if (wtMode === "branch-off" && branch) {
      const emptyImpl =
        Array.isArray(scen.implementFails) && scen.implementFails.includes(num);
      if (!emptyImpl) {
        const baseSha = git(["rev-parse", base]).stdout.trim();
        const tree = baseSha ? git(["rev-parse", `${base}^{tree}`]).stdout.trim() : "";
        if (baseSha && tree) {
          const commit = git([
            "commit-tree",
            tree,
            "-p",
            baseSha,
            "-m",
            `e2e shim impl #${num}`,
          ]).stdout.trim();
          if (commit) git(["update-ref", `refs/heads/${branch}`, commit]);
        }
      }
    }

    // A review run advances the verdict pointer: pick the next scripted
    // verdict for this ticket and pin it as currentVerdict so `paseo logs`
    // serves it stably across polling. The pointer is cumulative across the
    // fix-loop's review rounds.
    if (skill === "review" && num) {
      const seq = (scen.verdicts || {})[String(num)];
      if (Array.isArray(seq) && seq.length) {
        state.reviewIdx = state.reviewIdx || {};
        const idx = state.reviewIdx[String(num)] || 0;
        const v = seq[Math.min(idx, seq.length - 1)];
        state.reviewIdx[String(num)] = idx + 1;
        state.currentVerdict = state.currentVerdict || {};
        state.currentVerdict[String(num)] = v;
        await writeJson(STATE, state);
      }
    }

    const failRun =
      Array.isArray(scen.runFails) && scen.runFails.includes(num) && skill !== "";
    out(JSON.stringify({ agentId: slug, status: failRun ? "failed" : "completed" }) + "\n");
    exit(0);
  }

  if (cmd === "logs") {
    // paseo logs <agentId> --filter text
    const agentId = argv[1];
    const m = /^dag-(\d+)-review$/.exec(agentId || "");
    if (m) {
      const num = m[1];
      const v = (state.currentVerdict || {})[num] ?? "clean";
      out(verdictText(v) + "\n");
      exit(0);
    }
    // implement/fix logs: generic summary (not parsed for a verdict).
    out("e2e shim: agent completed its work.\n");
    exit(0);
  }

  err(`paseo shim: unhandled argv: ${JSON.stringify(argv)}\n`);
  exit(2);

  function verdictText(v) {
    if (v === "clean" || v == null) return "Review complete.\nREVIEW_VERDICT: CLEAN";
    if (v === "unknown") return "Review done.\nREVIEW_VERDICT: BOGUS";
    if (typeof v === "string" && v.indexOf("issues") === 0) {
      const c = v.split(":")[1] || "1";
      return `Found ${c} actionable finding(s).\nREVIEW_VERDICT: ISSUES ${c}`;
    }
    return "REVIEW_VERDICT: CLEAN";
  }
})();
