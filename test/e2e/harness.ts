/**
 * End-to-end harness for dag-tickets.
 *
 * Spins up a REAL local git repo with a local bare `origin` (so git fetch / push
 * / rev-parse / worktree all run for real, no network) and installs the gh /
 * paseo shims onto a temp PATH. Then calls the real `main()` in-process — the
 * exact same parseArgs → main → ShellBranch / ShellPullRequest / PaseoAgent →
 * Bun.spawn path a real run takes. Nothing is module-mocked: every external
 * command is a real subprocess resolved through PATH.
 *
 * Each test gets its own temp root (repo + origin + shim bin + scenario/state
 * files), so there are no cross-test collisions on the repo-wide lock, the
 * module-level repoInfo cache (bypassed via --cwd anyway), or the mutable shim
 * state.
 *
 * ISOLATION CAVEAT: the harness mutates process.env (PATH / HOME / DAG_E2E_*)
 * and captureStderr() monkeypatches process.stderr.write. try/finally in each
 * test restores these on exit, but the restoration is PROCESS-WIDE, so the
 * e2e suite is NOT safe to parallelise within one process (two concurrent
 * tests would clobber each other's env / stderr). bun:test runs files in
 * separate processes, which keeps the within-file tests sequential — keep the
 * suite in one file or run e2e files with --concurrency 1 if you split them.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli.ts";
import type { EventEnvelope } from "../../src/events.ts";
import type { RunState } from "../../src/state.ts";
// DEFAULT_STATE is the single source of the shim scratch shape; importing it
// here (rather than re-declaring a parallel literal) keeps the harness reader
// and both shims from drifting. util.js ships no types, so the binding is `any`
// — fine for a plain read/merge in test code.
import { DEFAULT_STATE, type ShimState } from "./shims/util.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_GH = join(__dirname, "shims", "gh.js");
const SHIM_PASEO = join(__dirname, "shims", "paseo.js");
const SHIM_UTIL = join(__dirname, "shims", "util.ts");
/** Fixed run-id so state.json / events.jsonl land at a known path per repo. */
export const RUN_ID = "e2e";

export interface IssueSpec {
  number: number;
  title: string;
  body?: string;
  /** Defaults to ["ready-for-agent"] for open issues, [] for closed. */
  labels?: string[];
  state?: "open" | "closed";
  /** Injected into the body as `Blocked by #N, ...` so discovery parses edges. */
  blockedBy?: number[];
}

export interface ScenarioOpts {
  issues: IssueSpec[];
  /** parent issue number -> sub-issue numbers (gh api graphql). */
  parents?: Record<string, number[]>;
  /** Global CI outcome served by `gh pr checks --watch`. Default "none". */
  checks?: "pass" | "fail" | "none";
  /** Per-ticket review-verdict sequence, consumed one per review run. */
  verdicts?: Record<string, string[]>;
  /** Ticket numbers whose implement produces NO commit (→ implement-empty). */
  implementFails?: number[];
  /** Ticket numbers whose `paseo run` returns status "failed" (→ implement-failed). */
  runFails?: number[];
  /** Per-ticket CI outcome sequence served one per `gh pr checks --watch` call
   *  (e.g. `["fail","pass"]` → attempt 1 CI fails, attempt 2 passes). Drives
   *  the transient-retry loop with a real transient-then-success outcome. */
  checksSeq?: Record<string, string[]>;
  /** Ticket numbers whose first primary-provider dispatch emits a 429 body
   *  (→ rate-limited) so runWithFallback retries on the fallback provider. */
  rateLimited?: number[];
  /** Overlap choreography: a ticket whose implement blocks until the ticket in
   *  the value has pushed its head (`loop/<v>-` appears in prHeads), so a
   *  dependent can overlap-launch while its blocker is still in flight. */
  pacerUntil?: Record<string, number>;
  /** Ticket number whose `pr checks --watch` blocks until a dependent's
   *  implement has actually run (state.dependentLaunched) — holding it in
   *  flight so the dependent overlap-launches and reaches reconcile (#29).
   *  Holding on the dependent's implement (not the pacer's merge) removes the
   *  race where the blocker would settle before the dependent launched. */
  holdWatch?: number[];
  /** Ticket numbers whose implement dispatch sets state.dependentLaunched = true
   *  (the release signal for a held `holdWatch` blocker). */
  dependentImpl?: number[];
}

export interface Env {
  root: string;
  repo: string;
  origin: string;
  shimBin: string;
  scenarioPath: string;
  statePath: string;
  prevPath: string;
  prevHome: string | undefined;
  prevRetryBase: string | undefined;
  prevRetryMax: string | undefined;
}

/** Run a command synchronously, throwing a formatted error on non-zero exit. */
function sh(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${r.status}) in ${cwd ?? "."}\n${r.stderr}${r.stdout}`,
    );
  }
}

/** Copy a shim source to `dest` (named `gh` / `paseo`) with an absolute-bun
 *  shebang so it executes even when bun isn't on the child's PATH. Strips any
 *  source shebang first so only one shebang line remains. */
async function installShim(src: string, dest: string): Promise<void> {
  const body = await Bun.file(src).text();
  const stripped = body.replace(/^#![^\n]*\n/, "");
  const shebang = `#!${process.execPath}\n`;
  await writeFile(dest, shebang + stripped);
  await chmod(dest, 0o755);
}

/** Copy util.js next to the installed shims so their `import "./util.js"`
 *  resolves from the temp bin (the shims reference shared helpers there). */
async function installShimUtil(destDir: string): Promise<void> {
  await writeFile(join(destDir, "util.ts"), await Bun.file(SHIM_UTIL).text());
}

/** Build the read-only scenario JSON the gh/paseo shims serve. */
function buildScenario(opts: ScenarioOpts): Record<string, unknown> {
  const issues: Record<string, object> = {};
  const labels: Record<string, number[]> = {};
  for (const s of opts.issues) {
    const issueLabels = s.labels ?? (s.state === "closed" ? [] : ["ready-for-agent"]);
    let body = s.body ?? "";
    if (s.blockedBy && s.blockedBy.length) {
      body += `\n\nBlocked by ${s.blockedBy.map((b) => "#" + b).join(", ")}`;
    }
    issues[String(s.number)] = {
      number: s.number,
      title: s.title,
      body,
      url: `https://github.com/e2e/test/issues/${s.number}`,
      state: s.state ?? "open",
      labels: issueLabels.map((name) => ({ name })),
    };
    for (const l of issueLabels) {
      (labels[l] ??= []).push(s.number);
    }
  }
  return {
    issues,
    labels,
    parents: opts.parents ?? {},
    checks: opts.checks ?? "none",
    verdicts: opts.verdicts ?? {},
    implementFails: opts.implementFails ?? [],
    runFails: opts.runFails ?? [],
    checksSeq: opts.checksSeq ?? {},
    rateLimited: opts.rateLimited ?? [],
    pacerUntil: opts.pacerUntil ?? {},
    holdWatch: opts.holdWatch ?? [],
    dependentImpl: opts.dependentImpl ?? [],
  };
}

/** Set up an isolated e2e environment for one scenario. Pair with teardown(). */
export async function setup(opts: ScenarioOpts): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "dag-e2e-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const shimBin = join(root, "bin");
  const scenarioPath = join(root, "scenario.json");
  const statePath = join(root, "state.json");

  await mkdir(shimBin, { recursive: true });
  await installShim(SHIM_GH, join(shimBin, "gh"));
  await installShim(SHIM_PASEO, join(shimBin, "paseo"));
  await installShimUtil(shimBin);

  // Bare origin with HEAD → main (push target; no network).
  sh("git", ["init", "--bare", origin]);
  sh("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);

  // Working repo on main with one commit, origin → bare repo.
  sh("git", ["init", repo]);
  sh("git", ["config", "user.email", "e2e@test.local"], repo);
  sh("git", ["config", "user.name", "e2e"], repo);
  sh("git", ["config", "commit.gpgsign", "false"], repo);
  await writeFile(join(repo, "README.md"), "# e2e\n");
  sh("git", ["add", "README.md"], repo);
  sh("git", ["symbolic-ref", "HEAD", "refs/heads/main"], repo);
  sh("git", ["commit", "-m", "init"], repo);
  sh("git", ["remote", "add", "origin", origin], repo);
  sh("git", ["push", "-q", "origin", "main"], repo);
  sh("git", ["fetch", "-q", "origin"], repo);

  // Scenario + mutable shim state. The on-disk file starts empty; the shims
  // merge DEFAULT_STATE (shims/util.js) under it so the shape is defined once
  // and new fields default sanely without rewriting every test's seed.
  await Bun.write(scenarioPath, JSON.stringify(buildScenario(opts), null, 2));
  await Bun.write(statePath, JSON.stringify({}, null, 2));

  // Point the test process's env at this scenario; children spawned by main()
  // inherit process.env, so the shims see these. PATH is prepended with the
  // shim bin so `gh`/`paseo` resolve there while `git` still resolves to the
  // real system git. HOME is redirected so loadPrefs() can't read the real
  // ~/.paseo/orchestration-preferences.json (deterministic fallback prefs).
  const prevPath = process.env.PATH ?? "";
  const prevHome = process.env.HOME;
  const prevRetryBase = process.env.DAG_RETRY_BASE_MS;
  const prevRetryMax = process.env.DAG_RETRY_MAX_MS;
  process.env.PATH = `${shimBin}:${prevPath}`;
  process.env.HOME = root;
  process.env.DAG_E2E_SCENARIO = scenarioPath;
  process.env.DAG_E2E_STATE = statePath;
  // Shrink the paseo stable-log polling interval to 0 so multi-dispatch tests
  // (review→fix→review, the fix-loop) don't each burn the prod 2s poll sleep.
  process.env.DAG_PASEO_LOG_POLL_MS = "0";
  // Shrink the transient-retry backoff base/max to ~0 so a transient-then-
  // success test (a real runWithRetry second attempt) doesn't burn the prod
  // 30s/5min caps. The retry loop + real setTimeout still execute — only the
  // wait is collapsed. Prod reads these too (documented in README), so the
  // default caps stay unchanged there.
  process.env.DAG_RETRY_BASE_MS = "1";
  process.env.DAG_RETRY_MAX_MS = "1";

  return { root, repo, origin, shimBin, scenarioPath, statePath, prevPath, prevHome, prevRetryBase, prevRetryMax };
}

/** Restore env + remove the temp root. Safe to call in afterEach. */
export async function teardown(env: Env): Promise<void> {
  if (env.prevPath !== undefined) process.env.PATH = env.prevPath;
  if (env.prevHome !== undefined) process.env.HOME = env.prevHome;
  else delete process.env.HOME;
  delete process.env.DAG_E2E_SCENARIO;
  delete process.env.DAG_E2E_STATE;
  if (env.prevRetryBase === undefined) delete process.env.DAG_RETRY_BASE_MS;
  else process.env.DAG_RETRY_BASE_MS = env.prevRetryBase;
  if (env.prevRetryMax === undefined) delete process.env.DAG_RETRY_MAX_MS;
  else process.env.DAG_RETRY_MAX_MS = env.prevRetryMax;
  await rm(env.root, { recursive: true, force: true });
}

/** Run main() in-process with --cwd and a fixed --run-id injected. */
export async function runMain(env: Env, args: string[]): Promise<number> {
  return main([...args, "--cwd", env.repo, "--run-id", RUN_ID]);
}

/** The shim's mutable state (see shims/util.js DEFAULT_STATE for the shape). */
export async function readShimState(env: Env): Promise<{
  prCounter: number;
  merged: number[];
  prHeads: Record<string, string>;
  prTickets: Record<string, number>;
  mergedStrategies: Record<string, string>;
  closed: number[];
  reviewIdx: Record<string, number>;
  currentVerdict: Record<string, string>;
  rateLimitedHit: Record<string, boolean>;
  checksIdx: Record<string, number>;
  providers: Record<string, Record<string, string>>;
  dependentLaunched: boolean;
}> {
  // Merge DEFAULT_STATE so a test reads defaulted values even when the shims
  // never wrote the file (dry-run / no dispatch) — the shims do the same merge
  // on read, so this keeps the two views identical.
  const raw = JSON.parse(await Bun.file(env.statePath).text()) as Partial<ShimState>;
  return { ...DEFAULT_STATE, ...raw };
}

/** The PR number a ticket's head resolved to (first prHead whose branch is
 *  `loop/<n>-…`), or undefined if the ticket never opened a PR. */
export async function prForTicket(env: Env, n: number): Promise<number | undefined> {
  const s = await readShimState(env);
  for (const [pr, head] of Object.entries(s.prHeads)) {
    if (typeof head === "string" && head.startsWith(`loop/${n}-`)) return parseInt(pr, 10);
  }
  return undefined;
}

/** Resolve a ref against the bare origin (e.g. `loop/1-add-foo`) to prove a
 *  real `git push` landed it there. Returns the resolved SHA or null. */
export function revParseOrigin(env: Env, ref: string): string | null {
  const r = spawnSync("git", ["-C", env.origin, "rev-parse", ref], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const sha = (r.stdout ?? "").trim();
  return sha || null;
}

/** The run's persisted state.json (absent if main never wrote one). */
export async function readState(env: Env): Promise<RunState | null> {
  const p = join(env.repo, ".scratch", "dag-tickets", RUN_ID, "state.json");
  const f = Bun.file(p);
  if (!(await f.exists())) return null;
  return (await f.json()) as RunState;
}

/** The run's events.jsonl, parsed into envelopes (absent → null). */
export async function readEvents(env: Env): Promise<EventEnvelope[] | null> {
  const p = join(env.repo, ".scratch", "dag-tickets", RUN_ID, "events.jsonl");
  const f = Bun.file(p);
  if (!(await f.exists())) return null;
  const txt = await f.text();
  return txt
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EventEnvelope);
}

/** Event types scoped to one ticket, in emit order. */
export function ticketEventTypes(events: EventEnvelope[], n: number): string[] {
  return events.filter((e) => e.ticket === n).map((e) => e.type);
}

/** Capture process.stderr (main logs there) into a string buffer. */
export function captureStderr(): { restore: () => void; text: () => string } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: unknown) => {
    buf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = orig;
    },
    text: () => buf,
  };
}

/** Does the repo-wide run lock exist at the standard path? */
export function lockExists(env: Env): boolean {
  return existsSync(join(env.repo, ".scratch", "dag-tickets", "run.lock"));
}

/** Write a live run.lock (own pid) so acquireLock sees a live holder. */
export async function writeLiveLock(env: Env): Promise<void> {
  await writeLock(env, process.pid, "ghost");
}

/** Write a run.lock whose holder pid is almost certainly dead (a very high
 *  pid that no real process owns) so acquireLock's stale-recovery reclaims it
 *  instead of failing fast — the documented "if the holder is already dead,
 *  re-run dag-tickets" path. Pass a real dead pid (e.g. a just-exited child's)
 *  to exercise the genuine stale-pid recovery rather than the invalid-holder
 *  shortcut. */
export async function writeDeadLock(env: Env, pid: number = 999_999): Promise<void> {
  await writeLock(env, pid, "ghost-dead");
}

async function writeLock(env: Env, pid: number, runId: string): Promise<void> {
  const p = join(env.repo, ".scratch", "dag-tickets", "run.lock");
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(
    p,
    JSON.stringify(
      {
        pid,
        runId,
        startedAt: new Date().toISOString(),
        hostname: "e2e",
        nonce: "fixed",
      },
      null,
      2,
    ) + "\n",
  );
}
