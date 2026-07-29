#!/usr/bin/env bun
/**
 * e2e shim for the `paseo` CLI.
 *
 * Installed onto a temp PATH as `paseo` so the real dispatch path in
 * src/paseo.ts (paseo run / paseo logs / paseo ls / paseo stop) is exercised
 * for real through `Bun.spawn` — no module mocking.
 *
 * Three jobs:
 *   1. `paseo run` (branch-off, implement/single-shot): create a REAL git
 *      branch carrying one commit ahead of base, using commit-tree +
 *      update-ref so the working tree and index are never touched
 *      (concurrency-safe, and matches what PaseoAgent.implement verifies via
 *      BranchPort.commitCount).
 *   2. Review verdicts: a review `paseo run` advances the per-ticket verdict
 *      pointer in DAG_E2E_STATE; `paseo logs dag-<n>-review` then serves that
 *      verdict STABLY across the stable-log polling loop (dispatch polls until
 *      output stops changing), so one review = one verdict — and the next
 *      review run advances to the next verdict in the scripted sequence
 *      (driving the fix-loop: ["issues:2","clean"]).
 *   3. Rate-limit simulation: a primary-provider implement/review dispatch for
 *      a ticket in `rateLimited` emits a 429 body on its FIRST call (so
 *      dispatch.rateLimited flips true and runWithFallback retries on the
 *      fallback), then proceeds normally. `paseo run` also records the
 *      --provider argv it received (proves --provider / --review-provider
 *      override wiring through the real subprocess).
 *
 * Shares DAG_E2E_SCENARIO (read-only) + DAG_E2E_STATE (mutable, same file the
 * gh shim writes) so PR/verdict/counter state stays coherent. Self-contained at
 * runtime (Bun globals + ./util.js); the harness installs util.js next to the
 * `paseo` executable.
 */
import {
  DEFAULT_STATE,
  readJson,
  writeJson,
  withStateLock,
  withDefaults,
  sleep,
} from "./util.ts";

(async () => {
  const argv = process.argv.slice(2);
  const SCEN = process.env.DAG_E2E_SCENARIO;
  const STATE = process.env.DAG_E2E_STATE;
  const cwd = process.cwd();

  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);
  const exit = (c) => process.exit(c);

  // Synchronous git (the shim is a short-lived process; spawnSync keeps the
  // commit-tree dance sequential and simple). Returns parsed stdout.
  const git = (args) => {
    const r = Bun.spawnSync({ cmd: ["git", ...args], cwd });
    const stdout = r.stdout ? r.stdout.toString() : "";
    return { ok: r.exitCode === 0, stdout };
  };

  const scen = await readJson(SCEN, {});

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
    const provider = pick("--provider") || "";
    const base = pick("--base") || "origin/main";
    const branch = wtMode === "branch-off" ? pick("--new-branch") : pick("--branch");

    // Skill + ticket number come from the title PaseoAgent sets
    // ("implement #N" / "review #N" / "fix #N rR" / "triage #N" / "research #N").
    const tm = /^(\w+)\s+#(\d+)/.exec(title);
    const skill = tm ? tm[1] : "";
    const num = tm ? parseInt(tm[2], 10) : 0;

    // Record the provider the dispatcher actually passed through argv, so a test
    // can assert --provider / --review-provider overrides reached the subprocess.
    if (num && skill) {
      await withStateLock(STATE, async () => {
        const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
        s.providers = s.providers || {};
        s.providers[String(num)] = s.providers[String(num)] || {};
        s.providers[String(num)][skill] = provider;
        await writeJson(STATE, s);
      });
    }

    // Overlap choreography pacer: a ticket in `pacerUntil` blocks its implement
    // dispatch until some other ticket has pushed its head (a loop/<that>- branch
    // exists in prHeads). This deterministically orders "blocker pushes head
    // before pacer settles", which is what lets a dependent overlap-launch.
    if (
      wtMode === "branch-off" &&
      skill === "implement" &&
      num &&
      scen.pacerUntil &&
      scen.pacerUntil[String(num)]
    ) {
      const waitHead = `loop/${scen.pacerUntil[String(num)]}-`;
      for (let i = 0; i < 6000; i++) {
        const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
        const heads = Object.values(s.prHeads || {});
        if (heads.some((h) => typeof h === "string" && h.startsWith(waitHead))) break;
        await sleep(5);
      }
    }

    // branch-off (implement / single-shot): materialise the branch with one
    // commit ahead of base, unless the scenario scripts an empty implement.
    const emptyImpl =
      Array.isArray(scen.implementFails) && scen.implementFails.includes(num);
    const failRun =
      Array.isArray(scen.runFails) && scen.runFails.includes(num) && skill !== "";

    // Overlap choreography: a dependent's implement flipping dependentLaunched
    // is the release signal for a held `holdWatch` blocker. Set it before the
    // commit materialisation so the blocker unblocks the moment the dependent
    // is genuinely in flight (its implement dispatch ran).
    if (
      wtMode === "branch-off" &&
      skill === "implement" &&
      num &&
      Array.isArray(scen.dependentImpl) &&
      scen.dependentImpl.includes(num)
    ) {
      await withStateLock(STATE, async () => {
        const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
        s.dependentLaunched = true;
        await writeJson(STATE, s);
      });
    }

    if (wtMode === "branch-off" && branch && !emptyImpl && !failRun) {
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

    // Rate-limit simulation: the FIRST primary dispatch for a ticket in
    // `rateLimited` emits a 429 body (non-JSON → dispatch keeps status
    // "completed" but isRateLimited(output) flips true → runWithFallback
    // retries on the fallback provider). The latch records that we've hit it so
    // the fallback dispatch proceeds normally.
    if (num && skill && Array.isArray(scen.rateLimited) && scen.rateLimited.includes(num)) {
      let hit = false;
      await withStateLock(STATE, async () => {
        const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
        s.rateLimitedHit = s.rateLimitedHit || {};
        hit = !!s.rateLimitedHit[String(num)];
        if (!hit) s.rateLimitedHit[String(num)] = true;
        await writeJson(STATE, s);
      });
      if (!hit) {
        // Non-JSON body: dispatch's JSON.parse throws → output stays this string,
        // status stays "completed", and isRateLimited(output) matches the 429.
        out("Error: 429 Too Many Requests — rate limit exceeded (quota).\n");
        exit(0);
      }
    }

    // A review run advances the verdict pointer: pick the next scripted
    // verdict for this ticket and pin it as currentVerdict so `paseo logs`
    // serves it stably across polling. The pointer is cumulative across the
    // fix-loop's review rounds.
    if (skill === "review" && num) {
      const seq = (scen.verdicts || {})[String(num)];
      if (Array.isArray(seq) && seq.length) {
        await withStateLock(STATE, async () => {
          const s = withDefaults(await readJson(STATE, DEFAULT_STATE));
          s.reviewIdx = s.reviewIdx || {};
          const idx = s.reviewIdx[String(num)] || 0;
          const v = seq[Math.min(idx, seq.length - 1)];
          s.reviewIdx[String(num)] = idx + 1;
          s.currentVerdict = s.currentVerdict || {};
          s.currentVerdict[String(num)] = v;
          await writeJson(STATE, s);
        });
      }
    }

    out(JSON.stringify({ agentId: slug, status: failRun ? "failed" : "completed" }) + "\n");
    exit(0);
  }

  if (cmd === "logs") {
    // paseo logs <agentId> --filter text
    const agentId = argv[1];
    const m = /^dag-(\d+)-review$/.exec(agentId || "");
    if (m) {
      const num = m[1];
      const state = withDefaults(await readJson(STATE, DEFAULT_STATE));
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
