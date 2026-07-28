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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_GH = join(__dirname, "shims", "gh.js");
const SHIM_PASEO = join(__dirname, "shims", "paseo.js");
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

  // Scenario + mutable shim state.
  await Bun.write(scenarioPath, JSON.stringify(buildScenario(opts), null, 2));
  await Bun.write(
    statePath,
    JSON.stringify(
      { prCounter: 1000, merged: [], prHeads: {}, reviewIdx: {}, currentVerdict: {} },
      null,
      2,
    ),
  );

  // Point the test process's env at this scenario; children spawned by main()
  // inherit process.env, so the shims see these. PATH is prepended with the
  // shim bin so `gh`/`paseo` resolve there while `git` still resolves to the
  // real system git. HOME is redirected so loadPrefs() can't read the real
  // ~/.paseo/orchestration-preferences.json (deterministic fallback prefs).
  const prevPath = process.env.PATH ?? "";
  const prevHome = process.env.HOME;
  process.env.PATH = `${shimBin}:${prevPath}`;
  process.env.HOME = root;
  process.env.DAG_E2E_SCENARIO = scenarioPath;
  process.env.DAG_E2E_STATE = statePath;
  // Shrink the paseo stable-log polling interval to 0 so multi-dispatch tests
  // (review→fix→review, the fix-loop) don't each burn the prod 2s poll sleep.
  process.env.DAG_PASEO_LOG_POLL_MS = "0";

  return { root, repo, origin, shimBin, scenarioPath, statePath, prevPath, prevHome };
}

/** Restore env + remove the temp root. Safe to call in afterEach. */
export async function teardown(env: Env): Promise<void> {
  if (env.prevPath !== undefined) process.env.PATH = env.prevPath;
  if (env.prevHome !== undefined) process.env.HOME = env.prevHome;
  else delete process.env.HOME;
  delete process.env.DAG_E2E_SCENARIO;
  delete process.env.DAG_E2E_STATE;
  await rm(env.root, { recursive: true, force: true });
}

/** Run main() in-process with --cwd and a fixed --run-id injected. */
export async function runMain(env: Env, args: string[]): Promise<number> {
  return main([...args, "--cwd", env.repo, "--run-id", RUN_ID]);
}

/** The shim's mutable state (PR counter, merged set, verdict pointers). */
export async function readShimState(env: Env): Promise<{
  prCounter: number;
  merged: number[];
  prHeads: Record<string, string>;
  reviewIdx: Record<string, number>;
  currentVerdict: Record<string, string>;
}> {
  return JSON.parse(await Bun.file(env.statePath).text());
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
  const p = join(env.repo, ".scratch", "dag-tickets", "run.lock");
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(
    p,
    JSON.stringify(
      {
        pid: process.pid,
        runId: "ghost",
        startedAt: new Date().toISOString(),
        hostname: "e2e",
        nonce: "fixed",
      },
      null,
      2,
    ) + "\n",
  );
}
