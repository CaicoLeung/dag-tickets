import { buildGraph, CycleError } from "./graph.ts";
import { runBatch } from "./scheduler.ts";
import { processTicket, type OverlapContext, type RunContext } from "./lifecycle.ts";
import { loadPrefs, PaseoAgent, type ProviderPrefs } from "./paseo.ts";
import { runWithRetry, isTransient } from "./retry.ts";
import { DEFAULT_ROUTING, type RoutingConfig } from "./config.ts";
import {
  listSubIssues,
  searchByLabel,
  fetchIssues,
} from "./discover.ts";
import { branchFor, repoInfo, ShellBranch, ShellPullRequest } from "./gitgh.ts";
import { remoteRef, type Logger, type MergeStrategy } from "./ports.ts";
import type { FailureReason, SettleReason, Ticket, TicketStatus } from "./types.ts";
import { loadState, saveState, ticketsWithStatus, type RunState, type TicketState } from "./state.ts";
import { EVT, JsonlEventLog } from "./events.ts";
import { acquireLock, LockAcquireError, LockHeldError, type LockHandle } from "./lock.ts";
import pkg from "../package.json";

/**
 * Process exit codes. `2` is reserved for usage / config / discovery failures
 * (unknown args, missing repo info, dependency cycles, missing run state). A
 * lock conflict is a retryable concurrency condition, so it gets distinct
 * codes a script can branch on instead of being indistinguishable from a
 * usage error.
 */
const EXIT_LOCK_HELD = 75; // EX_TEMPFAIL — another live run owns the lock; retry shortly.
const EXIT_LOCK_FAILED = 76; // couldn't settle the lock after retries; investigate.

/** Exponential-backoff schedule for transient whole-ticket retries (issue #21).
 *  Full-jitter is applied on top (delay = random() * computeBackoff), so these
 *  are caps: base 30s ± jitter, doubling, capped at 5 min. Long enough that a
 *  rate-limit window / CI queue drains, short enough that a batch still
 *  converges in a working session.
 *
 *  The base/cap are env-tunable (`DAG_RETRY_BASE_MS` / `DAG_RETRY_MAX_MS`) so a
 *  host running quick local batches (or the e2e suite, which collapses the wait
 *  to prove the real retry loop without burning 30s) can shrink them. Defaults
 *  are unchanged when unset. Read at call time so a caller can adjust between
 *  dispatches. */
const MS_PER_MINUTE = 60_000;
const retryBaseMs = (): number => Number(process.env.DAG_RETRY_BASE_MS ?? 30_000) || 30_000;
const retryMaxMs = (): number => Number(process.env.DAG_RETRY_MAX_MS ?? 5 * MS_PER_MINUTE) || 5 * MS_PER_MINUTE;

/** Resolve the `gh pr checks --watch` ceiling in ms. The raw-ms
 *  `DAG_CI_WATCH_TIMEOUT_MS` escape hatch (e2e / per-host override) wins when
 *  set + valid — a hard override, exactly like `DAG_RETRY_*`; otherwise the
 *  `--ci-watch-timeout-minutes` flag (whole minutes) applies. `0` flag /
 *  flag-unset + env-unset → undefined → unbounded watch (the pre-flag
 *  behaviour). */
function ciWatchMsFromOpts(minutes: number): number | undefined {
  const envMs = Number(process.env.DAG_CI_WATCH_TIMEOUT_MS);
  if (Number.isFinite(envMs) && envMs > 0) return envMs;
  return minutes > 0 ? minutes * MS_PER_MINUTE : undefined;
}

/** Per-agent-run wall budget override (ms). Unset → undefined → PaseoAgent's
 *  DEFAULT_RUN_MS (60min). Read at call time so a caller can adjust between
 *  dispatches; the e2e suite collapses it to ~ms (paired with the paseo shim's
 *  `timeouts` knob) to exercise the agent-timeout → transient retry path
 *  without burning 60min. */
const agentTimeoutMs = (): number | undefined => {
  const n = Number(process.env.DAG_AGENT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Default ceiling on `gh pr checks --watch`, in minutes. A stuck / never-
 *  completing check otherwise polls indefinitely and starves a concurrency slot
 *  for the rest of the batch — the one load-bearing availability risk in an
 *  unattended run. The ceiling turns that into a transient `ci-failed` (the
 *  existing `checks-watch-timeout` path), which the retry loop backs off and
 *  retries, so the run self-heals instead of hanging on one bad job. 30m is
 *  long enough for normal CI and short enough that an overnight batch keeps
 *  moving. `--ci-watch-timeout-minutes 0` disables the bound (indefinite,
 *  pre-this-flag behaviour) for repos with legitimately long CI. */
const DEFAULT_CI_WATCH_MINUTES = 30;

interface ParsedArgs {
  parent?: number;
  label?: string;
  frontier: boolean;
  numbers: number[];
  concurrency: number;
  maxFixRounds: number;
  /** Whole-ticket retries after a transient failure (issue #21). 0 disables. */
  maxTicketRetries: number;
  /** Ceiling on `gh pr checks --watch` in minutes. 0 = no bound (indefinite). */
  ciWatchTimeoutMinutes: number;
  autoMerge: boolean;
  noAutoMerge: boolean;
  mergeStrategy: MergeStrategy;
  requireChecks: boolean;
  dryRun: boolean;
  provider?: string;
  fallbackProviders: string[];
  reviewProvider?: string;
  cwd?: string;
  runId?: string;
  resume?: string;
  implLabel?: string;
  triageLabel?: string;
  researchLabel?: string;
  categoryLabels: string[];
  skipLabels: string[];
  help: boolean;
  version: boolean;
}

const HELP = `dag-tickets — DAG-aware batch driver for mattpocock-skills tickets.

Drives a batch of GitHub issues through implement -> code-review -> fix-loop ->
PR -> auto-merge, fanning independent tickets out across Paseo worktrees and
serialising any whose "Blocked by" edges gate them.

USAGE
  dag-tickets                       # all open \`ready-for-agent\` (the frontier)
  dag-tickets --frontier            #   (explicit)
  dag-tickets --label ready-for-agent
  dag-tickets --parent 42           # sub-issues of parent #42
  dag-tickets 12 15 23              # explicit issue numbers

OPTIONS
  --parent <n>            Process sub-issues of parent issue <n>.
  --label <name>          Process open issues with this label.
  --frontier              Process the open implement-label frontier (default).
  --concurrency <n>       Max tickets in flight (default 3).
  --max-fix-rounds <n>    implement<->review fix iterations (default 2).
  --max-ticket-retries <n> Whole-ticket retries after a transient failure
                         (CI flake / rate-limit / merge race) with exponential
                         backoff. 0 disables. Default 2.
  --auto-merge            Merge when review clean + CI green (default).
  --no-auto-merge         Stop before merge; leave PRs for you to merge.
  --merge-strategy <s>    squash | merge | rebase (default squash).
  --require-checks        A PR with no CI does NOT satisfy the merge gate.
  --ci-watch-timeout-minutes <n>  Ceiling on \`gh pr checks --watch\` (default 30).
                         A stuck check otherwise polls forever and starves a
                         slot; the timeout is a transient ci-failed (retried
                         with backoff). 0 = no bound (indefinite watch).
  --provider <p>          Override the implement/fix provider.
  --review-provider <p>   Override the review provider.
  --fallback-provider <p> Provider tried when the primary is rate-limited (repeat / comma-sep).
  --impl-label <l>        Override the implement-routing label.
  --triage-label <l>      Override the triage-routing label.
  --research-label <l>    Override the research-routing label.
  --category-label <l>    Add a category role to the orphan-detection set
                         (default bug, enhancement; repeat / comma-sep). An
                         issue with a category role but no state role is triaged.
  --skip-label <l>        Add a state role the driver intentionally skips
                         (default needs-info, ready-for-human, wontfix;
                         repeat / comma-sep).
  --cwd <path>            Operate on a different checkout.
  --run-id <id>           Name this run (for the state file).
  --resume <id>           Resume a previous run; skip its merged/failed tickets.
  --dry-run               Print the per-ticket plan and dispatch nothing.
  -h, --help              Show this help.
  -V, --version           Show the version and exit.

The driver reads \`~/.paseo/orchestration-preferences.json\` for providers and
falls back to codex/gpt-5.4 (impl) + claude/opus (review) when absent.
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const a: ParsedArgs = {
    frontier: false,
    numbers: [],
    concurrency: 3,
    maxFixRounds: 2,
    maxTicketRetries: 2,
    ciWatchTimeoutMinutes: DEFAULT_CI_WATCH_MINUTES,
    autoMerge: false,
    noAutoMerge: false,
    mergeStrategy: "squash",
    requireChecks: false,
    dryRun: false,
    fallbackProviders: [],
    categoryLabels: [],
    skipLabels: [],
    help: false,
    version: false,
  };
  const num = (v: string): number | undefined => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  // Like num(), but also admits 0 — for flags where 0 is a valid "disable"
  // sentinel (--max-ticket-retries, --ci-watch-timeout-minutes), distinct from
  // the strictly-positive --concurrency / --max-fix-rounds.
  const nonNegInt = (v: string): number | undefined => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case "-h":
      case "--help":
        a.help = true; break;
      case "-V":
      case "--version":
        a.version = true; break;
      case "--dry-run":
        a.dryRun = true; break;
      case "--frontier":
        a.frontier = true; break;
      case "--auto-merge":
        a.autoMerge = true; break;
      case "--no-auto-merge":
        a.noAutoMerge = true; break;
      case "--require-checks":
        a.requireChecks = true; break;
      case "--parent":
        a.parent = num(next()!); break;
      case "--label":
        a.label = next(); break;
      case "--concurrency":
        a.concurrency = num(next()!) ?? a.concurrency; break;
      case "--max-fix-rounds":
        a.maxFixRounds = num(next()!) ?? a.maxFixRounds; break;
      case "--max-ticket-retries":
        // 0 disables retry — nonNegInt admits 0 where num() would not.
        a.maxTicketRetries = nonNegInt(next()!) ?? a.maxTicketRetries;
        break;
      case "--ci-watch-timeout-minutes":
        // 0 disables the ceiling (indefinite watch) — nonNegInt admits 0.
        a.ciWatchTimeoutMinutes = nonNegInt(next()!) ?? a.ciWatchTimeoutMinutes;
        break;
      case "--merge-strategy": {
        const s = next() as MergeStrategy;
        if (s === "squash" || s === "merge" || s === "rebase") a.mergeStrategy = s;
        break;
      }
      case "--provider":
        a.provider = next(); break;
      case "--review-provider":
        a.reviewProvider = next(); break;
      case "--fallback-provider":
        a.fallbackProviders.push(...(next()?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])); break;
      case "--impl-label":
        a.implLabel = next(); break;
      case "--triage-label":
        a.triageLabel = next(); break;
      case "--research-label":
        a.researchLabel = next(); break;
      case "--category-label":
        a.categoryLabels.push(...(next()?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])); break;
      case "--skip-label":
        a.skipLabels.push(...(next()?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])); break;
      case "--cwd":
        a.cwd = next(); break;
      case "--run-id":
        a.runId = next(); break;
      case "--resume":
        a.resume = next(); break;
      default:
        if (arg.startsWith("--") && arg.includes("=")) {
          // Re-handle --flag=value by splicing; simplest: split and re-feed.
          const [k, v] = arg.split("=", 2);
          argv.splice(i, 1, k!, v!);
          i--;
        } else if (/^\d+$/.test(arg)) {
          a.numbers.push(parseInt(arg, 10));
        } else {
          throw new Error(`unknown argument: ${arg}`);
        }
    }
  }
  return a;
}

/**
 * #40: best-effort stop of every agent this run still has in flight. Pure
 *  helper (captures nothing) so the guard + swallow contract is unit-tested
 *  directly — the cli wires its live `agentRef` / `inflightTickets` through it.
 *
 *  Honours `AgentPort.stopInFlight`'s OPTIONAL contract: a missing agent, or
 *  one whose fake doesn't implement `stopInFlight`, is a clean no-op (the
 *  pre-#40 behaviour) rather than a silently-swallowed `TypeError`. Never
 *  throws — the exit/cleanup that calls this must proceed regardless.
 */
export async function stopInFlightAgents(
  agent: { stopInFlight?(ticketNumbers: Iterable<number>): Promise<void> } | undefined,
  tickets: Iterable<number>,
): Promise<void> {
  if (!agent?.stopInFlight) return;
  try {
    await agent.stopInFlight(tickets);
  } catch {
    /* best-effort: the exit/cleanup that follows must proceed regardless */
  }
}

/** Dependencies RunExit drives on every catchable exit. Each is a thunk so
 *  the coordinator closes over nothing module-global — main() wires the live
 *  lock handle / event log / stop helper, and tests wire fakes. */
interface RunExitDeps {
  /** #40: stop every agent this run still has in flight. */
  stop(): Promise<void>;
  /** Flush the staged event trace so a non-graceful exit leaves an ordered prefix. */
  flush(): Promise<void>;
  /** Release the run lock (idempotent). */
  release(): Promise<void>;
  /** Human log so an operator sees the exit reason in stderr. */
  log: Logger;
  /** Exit action. Defaults to `process.exit`; tests inject a recorder so they
   *  observe the intended exit code without terminating the test process. */
  exit?(code: number): void;
}

/**
 * #40: coordinates cleanup (stop in-flight agents + flush events + release the
 *  run lock) across EVERY catchable exit path — signal (SIGINT/SIGTERM) and
 *  crash (uncaughtException / unhandledRejection). Graceful exit is covered by
 *  main()'s try/finally, which also calls `detach()` so a later signal keeps
 *  Node's default behaviour.
 *
 *  Extracted from main() so the wiring is unit-tested directly instead of by
 *  inspection: a regression that drops a handler registration, the stop, the
 *  flush, or the release fails the RunExit tests — not just an unattended
 *  orphan-agent run. `process.exit` is injected (defaults to the real one) so
 *  tests observe the intended exit code without terminating the test process.
 *
 *  Handlers use `process.once` (not `.on`): a second crash during the async
 *  cleanExit window must not re-enter cleanup. `detach()` removeListener's as a
 *  no-op-if-already-removed safety net (once auto-removes after the first fire).
 */
export class RunExit {
  private readonly exit: (code: number) => void;
  readonly onSignal: (sig: NodeJS.Signals) => void;
  readonly onUncaught: () => void;
  readonly onRejection: () => void;

  constructor(deps: RunExitDeps) {
    this.exit = deps.exit ?? ((code) => process.exit(code));
    // Best-effort throughout: a failure in any step must not block the exit
    // that follows — the .catch swallows, the .finally still exits. Order is
    // load-bearing: stop the agent BEFORE releasing the lock (a released lock
    // lets the next run spawn on the same worktree) and flush BEFORE release so
    // the trace lands even if release throws.
    const cleanExit = async (code: number): Promise<void> => {
      await deps.stop();
      await deps.flush();
      await deps.release();
    };
    this.onSignal = (sig: NodeJS.Signals) => {
      deps.log("warn", `${sig} received; stopping in-flight agents, releasing run lock and exiting`);
      // 128 + signal number: 130 for SIGINT, 143 for SIGTERM (shell convention).
      const code = 128 + (sig === "SIGINT" ? 2 : 15);
      cleanExit(code)
        .catch(() => {})
        .finally(() => this.exit(code));
    };
    // The "not graceful" half of "clean up agents on exit (graceful or not)":
    // an uncaught / unhandled rejection bypasses the try/finally, so these
    // stop the in-flight agents + release the lock before a non-zero exit.
    const exitOnCrash = (kind: string): (() => void) => () => {
      deps.log("warn", `${kind}: stopping in-flight agents, releasing run lock before exit`);
      cleanExit(1)
        .catch(() => {})
        .finally(() => this.exit(1));
    };
    this.onUncaught = exitOnCrash("uncaught exception");
    this.onRejection = exitOnCrash("unhandled rejection");
  }

  /** Register every catchable-exit handler on process. Uses `.once` so a
   *  second event during the async cleanExit window can't re-enter cleanup. */
  register(): void {
    process.once("SIGINT", this.onSignal);
    process.once("SIGTERM", this.onSignal);
    process.once("uncaughtException", this.onUncaught);
    process.once("unhandledRejection", this.onRejection);
  }

  /** Remove every handler. Called in main()'s try/finally so a later, unrelated
   *  signal keeps Node's default behaviour. A no-op for any listener that
   *  already auto-removed via `.once`. */
  detach(): void {
    process.removeListener("SIGINT", this.onSignal);
    process.removeListener("SIGTERM", this.onSignal);
    process.removeListener("uncaughtException", this.onUncaught);
    process.removeListener("unhandledRejection", this.onRejection);
  }
}

function buildRouting(a: ParsedArgs): RoutingConfig {
  const cfg: RoutingConfig = {
    implementLabels: [...DEFAULT_ROUTING.implementLabels],
    triageLabels: [...DEFAULT_ROUTING.triageLabels],
    researchLabels: [...DEFAULT_ROUTING.researchLabels],
    categoryLabels: [...DEFAULT_ROUTING.categoryLabels],
    skipLabels: [...DEFAULT_ROUTING.skipLabels],
  };
  if (a.implLabel) cfg.implementLabels = [a.implLabel];
  if (a.triageLabel) cfg.triageLabels = [a.triageLabel];
  if (a.researchLabel) cfg.researchLabels = [a.researchLabel];
  cfg.categoryLabels.push(...a.categoryLabels);
  cfg.skipLabels.push(...a.skipLabels);
  return cfg;
}

async function discoverTickets(a: ParsedArgs, cfg: RoutingConfig): Promise<Ticket[]> {
  const cwd = a.cwd;
  if (a.parent) return listSubIssues(a.parent, cwd, cfg);
  if (a.label) return searchByLabel(a.label, cwd, cfg);
  if (a.numbers.length > 0) return fetchIssues(a.numbers, cwd, cfg);
  return searchByLabel(cfg.implementLabels[0] ?? "ready-for-agent", cwd, cfg);
}

const ANSI: Record<string, string> = {
  info: "\x1b[36m",
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

function makeLogger(dryRun: boolean): Logger {
  return (level, msg, n) => {
    const prefix = n ? `[#${n}]` : "";
    const head = dryRun ? "[dry-run]" : "";
    process.stderr.write(`${ANSI[level] ?? ""}${head}${prefix} ${msg}${ANSI.reset}\n`);
  };
}

function stateFromOutcome(
  status: TicketStatus,
  o?: {
    branch?: string;
    pr?: number;
    rounds?: number;
    attempts?: number;
    reason?: FailureReason;
    error?: string;
    skipReason?: SettleReason;
  },
): TicketState {
  return {
    status,
    branch: o?.branch,
    pr: o?.pr,
    rounds: o?.rounds,
    attempts: o?.attempts,
    reason: o?.reason,
    error: o?.error,
    skipReason: o?.skipReason,
  };
}

/**
 * #29 overlap coordinator: owns the run-wide bookkeeping that gates frontier
 * relaxation, extracted out of main() so the orchestrator stops growing a new
 * field + closure per overlap reason. Three concerns, one home:
 *  - `pushedHeads`: admits a dependent once its blocker has pushed its head
 *    (createPr ran) — the canOverlap policy reads it.
 *  - `settled` + `waiters`: gate an overlap-dependent's createPr on its blocker
 *    merging (no premature PR); seeded from resume sets so a dependent
 *    overlapping an already-done blocker resolves immediately.
 * Exposed as the slim RunContext hooks (markHeadPushed / waitForBlockers) plus
 * the scheduler's canOverlap policy; main() wires them, this class owns them.
 */
class OverlapCoordinator {
  private readonly pushedHeads = new Set<number>();
  private readonly settled: Set<number>;
  private readonly waiters = new Map<number, Array<() => void>>();

  constructor(seedSettled: Iterable<number>) {
    this.settled = new Set(seedSettled);
  }

  /** Scheduler overlap policy: both implement AND the blocker has pushed its
   *  head (createPr ran) so a dependent never branches off a missing tip. */
  readonly canOverlap = (dep: Ticket, blocker: Ticket): boolean =>
    dep.kind === "implement" &&
    blocker.kind === "implement" &&
    this.pushedHeads.has(blocker.number);

  /** RunContext hook: ticket `n` pushed its head → admit its dependents. */
  readonly markHeadPushed = (n: number): void => {
    this.pushedHeads.add(n);
  };

  /** RunContext hook: gate createPr on every blocker settling. Overlap can't
   *  trigger at concurrency 1, so a blocker always holds its own slot while a
   *  dependent waits here — no deadlock. */
  readonly waitForBlockers = async (blockers: number[]): Promise<void> => {
    await Promise.all(blockers.map((b) => this.awaitOne(b)));
  };

  /** Scheduler onSettle hook: record `n` settled and release any overlap-
   *  dependent waiting on it. Called before state persist so a resumed run
   *  sees the blocker as settled too. */
  noteSettled(n: number): void {
    this.settled.add(n);
    const w = this.waiters.get(n);
    if (w) {
      this.waiters.delete(n);
      for (const fn of w) fn();
    }
  }

  private awaitOne = (n: number): Promise<void> =>
    this.settled.has(n)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const arr = this.waiters.get(n) ?? [];
          arr.push(resolve);
          this.waiters.set(n, arr);
        });
}

export async function main(argv: string[]): Promise<number> {
  let a: ParsedArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (a.version) {
    process.stdout.write(`dag-tickets ${pkg.version}\n`);
    return 0;
  }
  if (a.help || argv.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const log = makeLogger(a.dryRun);
  const cfg = buildRouting(a);

  // Resolve base branch from the checkout (or fail loudly).
  let baseBranch = "main";
  try {
    baseBranch = (await repoInfo(a.cwd)).defaultBranch;
  } catch (e) {
    process.stderr.write(`Could not resolve repo info (are you in a git repo with gh?): ${(e as Error).message}\n`);
    return 2;
  }

  // Providers: prefs file <- CLI overrides.
  const prefs: ProviderPrefs = await loadPrefs();
  if (a.provider) prefs.impl = a.provider;
  if (a.reviewProvider) prefs.review = a.reviewProvider;

  // Discover.
  let tickets: Ticket[];
  try {
    tickets = await discoverTickets(a, cfg);
  } catch (e) {
    process.stderr.write(`Discovery failed: ${(e as Error).message}\n`);
    return 2;
  }

  const open = tickets.filter((t) => t.state === "open");
  const closedSkipped = tickets.length - open.length;
  if (closedSkipped > 0) log("warn", `skipping ${closedSkipped} already-closed ticket(s)`);

  const actionable = open.filter((t) => t.kind !== "unknown" && t.kind !== "skip");
  const unrouted = open.filter((t) => t.kind === "unknown");
  const intentionalSkips = open.filter((t) => t.kind === "skip");
  for (const t of unrouted) {
    log("warn", `no routing label (need one of ${[...cfg.implementLabels, ...cfg.triageLabels, ...cfg.researchLabels].join("/")} or a category role like ${cfg.categoryLabels.join("/")}); skipping`, t.number);
  }
  for (const t of intentionalSkips) {
    log("info", `intentional skip — [${t.labels.join(", ")}] is for a human / interactive /triage, not a batch agent`, t.number);
  }
  if (actionable.length === 0) {
    log("info", "no actionable tickets found.");
    return 0;
  }

  // Build the dependency graph.
  let graph;
  try {
    graph = buildGraph(actionable);
  } catch (e) {
    if (e instanceof CycleError) {
      process.stderr.write(`Aborting: ${e.message}\nFix the Blocked-by cycle before batching.\n`);
      return 2;
    }
    throw e;
  }

  log("info", `planned ${actionable.length} ticket(s); concurrency ${a.concurrency}; base ${baseBranch}; ${a.dryRun ? "DRY RUN" : a.noAutoMerge ? "manual merge" : "auto-merge " + a.mergeStrategy}${a.maxTicketRetries > 0 ? `; transient-retry ×${a.maxTicketRetries}` : ""}`);

  const runId = a.runId ?? a.resume ?? defaultRunId(a);
  let state: RunState;
  if (a.resume) {
    const loaded = await loadState(a.resume, a.cwd);
    if (!loaded) {
      process.stderr.write(`No saved state for run "${a.resume}" at ${`.scratch/dag-tickets/${a.resume}/state.json`}\n`);
      return 2;
    }
    state = loaded;
    log("info", `resuming run ${a.runId ?? a.resume}`);
  } else {
    state = {
      runId,
      target: describeTarget(a),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tickets: {},
    };
  }

  const seedCompleted = ticketsWithStatus(state, "done");
  const seedFailed = ticketsWithStatus(state, "failed");
  const seedSkipped = ticketsWithStatus(state, "skipped");

  // Structured event log (issue #19): append-only JSONL alongside state.json.
  // Always on (including dry-run / resume). No existing stderr line is altered:
  // the event file is the sibling of state.json (same `<runId>/` dir, shown in
  // the existing `state:` line), so it stays discoverable without a new log line.
  // `log` is passed so a persistently failing write surfaces one warn instead
  // of silently dropping the post-mortem channel.
  const events = new JsonlEventLog(runId, a.cwd, log);
  await events.ensure();

  // Acquire the repo-wide run lock so a concurrent dag-tickets on this
  // checkout can't fight over the shared dag-<n> worktrees/branches. --dry-run
  // dispatches nothing, so it stays lock-free (and never blocks a real run).
  let lockHandle: LockHandle | null = null;
  // #40: tickets currently in flight (launched, not yet settled) so a
  // graceful / signal / thrown exit can stop the agents this run spawned
  // instead of orphaning them on the worktree. `agentRef` is assigned inside
  // the try below; the exit coordinator (registered before try) reads it by ref.
  const inflightTickets = new Set<number>();
  let agentRef: PaseoAgent | undefined;
  // #40: delegate bound to this run's live agentRef + inflightTickets. The
  // guard + swallow live in the exported stopInFlightAgents() (unit-tested)
  // so a missing agent / optional stopInFlight is a clean no-op, not a
  // swallowed TypeError. Never throws; never blocks the next step.
  const stopInFlight = () => stopInFlightAgents(agentRef, inflightTickets);
  // #40: the exit-path coordinator (stop + flush + release across signal +
  // crash exits). Built + registered once the lock is held; detached in the
  // finally so a later, unrelated signal keeps Node's default behaviour. Null
  // on dry-run (nothing dispatched → no cleanup to wire).
  let guard: RunExit | null = null;
  if (!a.dryRun) {
    try {
      lockHandle = await acquireLock({ cwd: a.cwd, runId });
    } catch (e) {
      // Distinguish the two lock failures from discovery/usage errors (exit 2):
      // a held lock is transient (retry later); an acquire failure means
      // recovery couldn't settle and the human should investigate.
      if (e instanceof LockHeldError) {
        log("error", e.message);
        return EXIT_LOCK_HELD;
      }
      if (e instanceof LockAcquireError) {
        log("error", e.message);
        return EXIT_LOCK_FAILED;
      }
      throw e;
    }
    // Release on Ctrl-C / SIGTERM / crash too, not just clean exit. RunExit
    // owns handler registration + cleanup; detach() in the finally restores
    // default signal behaviour. handle.release() is idempotent, so a double
    // call (signal path + finally) is harmless.
    const handle = lockHandle;
    guard = new RunExit({
      stop: stopInFlight,
      flush: () => events.flush(),
      release: () => handle.release(),
      log,
    });
    guard.register();
  }

  // try/finally flushes staged event appends on throw / exit / SIGTERM so the
  // trace stays complete and ordered (SIGKILL is a best-effort ordered prefix;
  // see events.ts), and releases the run lock + detaches the signal handlers
  // on every exit path.
  let exitCode = 0;
  try {
    events.emit(EVT.RUN_START, undefined, {
      target: describeTarget(a),
      ticketCount: actionable.length,
      concurrency: a.concurrency,
      autoMerge: a.noAutoMerge ? false : true,
      baseBranch,
      dryRun: a.dryRun,
      resume: !!a.resume,
      maxTicketRetries: a.maxTicketRetries,
    });

    const branch = new ShellBranch(a.cwd);
    // Only a positive budget becomes a ms ceiling. 0 → undefined → unbounded
    // watch (the pre-flag behaviour); negatives never reach here because
    // nonNegInt rejects them at parse time, leaving the default in place.
    //
    // DAG_CI_WATCH_TIMEOUT_MS (raw ms) overrides the flag when set + valid, so
    // the e2e suite can collapse a stuck-check timeout to ~ms (the flag is in
    // whole minutes — too coarse for a fast test) exactly like DAG_RETRY_*
    // collapses the backoff. Prod leaves it unset → the flag/default stands.
    const ciWatchMs = ciWatchMsFromOpts(a.ciWatchTimeoutMinutes);
    const pullRequest = new ShellPullRequest(a.cwd, ciWatchMs);
    const agent = new PaseoAgent(branch, prefs, a.fallbackProviders, log, a.cwd, agentTimeoutMs(), undefined, events);
    agentRef = agent;
    // #29: overlap bookkeeping (head-pushed admits, blocker-settle gates
    // createPr) lives in one coordinator instead of scattered sets/closures in
    // main() — see OverlapCoordinator. Seeded from the resume sets so a
    // dependent overlapping an already-done blocker resolves immediately.
    const overlap = new OverlapCoordinator([...seedCompleted, ...seedFailed, ...seedSkipped]);
    const ctx: RunContext = {
      agent,
      pullRequest,
      baseBranch,
      maxFixRounds: a.maxFixRounds,
      mergeStrategy: a.mergeStrategy,
      autoMerge: a.noAutoMerge ? false : a.autoMerge ? true : true,
      requireChecks: a.requireChecks,
      dryRun: a.dryRun,
      log,
      events,
      markHeadPushed: overlap.markHeadPushed,
      waitForBlockers: overlap.waitForBlockers,
    };

    const result = await runBatch(graph, {
      concurrency: a.concurrency,
      seedCompleted,
      seedFailed,
      seedSkipped,
      events,
      canOverlap: overlap.canOverlap,
      process: async (n, info) => {
        // #40: track this ticket as in flight so a graceful/signal exit can
        // stop its agent. Removed once it settles normally; a throw leaves it
        // in the set (the scheduler settles it failed externally) so exit
        // cleanup still stops a possibly-running agent — harmless if not.
        inflightTickets.add(n);
        const t = graph.byNumber.get(n)!;
        // #29: a launch via overlap composes on the blocker's pushed head +
        // captures its tip for the pre-createPr reconcile. A missing tip (lost
        // race: blocker head not resolvable) falls back to a strict launch off
        // the integration base. Dry-run dispatches nothing, so skip overlap.
        let overlap: OverlapContext | undefined;
        if (info?.overlapBlocker !== undefined && !a.dryRun) {
          const blocker = graph.byNumber.get(info.overlapBlocker);
          if (blocker) {
            const head = branchFor(blocker.number, blocker.title);
            const tip = await branch.resolveRemoteTip(head);
            if (tip) overlap = { blockerHead: remoteRef(head), blockerTipSha: tip };
          }
        }
        // Wrap one processTicket() pass in the transient-retry loop (issue #21):
        // a transient failure (CI flake / rate-limit / merge race) backs off and
        // retries up to --max-ticket-retries times before settling terminal and
        // cascading. onAttempt persists `attempts` after each pass so a killed
        // run records how far it got; the scheduler only ever sees the final
        // terminal status, so a cascade still fires exactly once the budget is
        // exhausted. Dry-run returns `done` immediately, so no retry/sleep ever
        // happens there.
        // Resume continuity (issue #21, between-attempt kill): a ticket killed
        // mid-backoff is persisted `running` with its attempt count + transient
        // reason. Carry that count forward as startAttempt so the loop's
        // numbering stays cumulative and the configured --max-ticket-retries cap
        // holds across the resume (a resumed ticket can't gain a fresh budget).
        // Killing the agent *mid-attempt* (no attempt to persist) is the harder
        // cancel-semantics case and remains T05.
        const prior = state.tickets[n];
        const priorAttempts = prior?.status === "running" ? prior.attempts : undefined;
        const startAttempt =
          typeof priorAttempts === "number" && isTransient(prior?.reason)
            ? priorAttempts + 1
            : undefined;
        const outcome = await runWithRetry(
          () => processTicket(t, ctx, overlap, info?.signal),
          {
            maxRetries: a.maxTicketRetries,
            baseDelayMs: retryBaseMs(),
            maxDelayMs: retryMaxMs(),
            log,
            events,
            ticketNumber: n,
            startAttempt,
            onAttempt: async (attempt, o) => {
              // A transient failure that still has retry budget is in-flight
              // (about to back off and retry), NOT terminal. Persist it as
              // `running` with the attempt count so a run killed during the
              // sleep resumes by re-launching the ticket instead of wrongly
              // cascading it as a permanent failure. The final pass (terminal
              // reason, or budget exhausted) fails the guard and persists its
              // real status. Budget continuity across resume is handled via
              // startAttempt above; the remaining cancel-semantics work (T05)
              // is killing the agent *mid-attempt*, which has no completed
              // attempt to persist.
              const inflight =
                o.status === "failed" &&
                attempt <= a.maxTicketRetries &&
                isTransient(o.reason);
              const persistStatus = inflight ? "running" : o.status;
              state.tickets[n] = stateFromOutcome(persistStatus, { ...o, attempts: attempt });
              if (!a.dryRun) await saveState(state, a.cwd);
            },
          },
        );
        state.tickets[n] = stateFromOutcome(outcome.status, outcome);
        if (!a.dryRun) await saveState(state, a.cwd);
        inflightTickets.delete(n); // settled normally → agent dispatch is done
        return outcome.status;
      },
      // #20: when a running dependent's blocker settles failed/skipped, kill the
      // dependent's agent dispatch + clean its worktree instead of letting it
      // burn a full implement→review→fix→CI cycle on a doomed branch. Wired
      // unconditionally to mirror the sibling `onSettle` shape; the internal
      // dry-run guard matches `saveState`'s (nothing dispatched → nothing to
      // kill, and the scheduler's dry-run cascade never reaches the abort path).
      abort: async (n: number) => {
        if (a.dryRun) return;
        const t = graph.byNumber.get(n);
        if (t) await agent.abort(t);
      },
      onSettle: async (n, status, reason) => {
        // #29: this ticket settled — release any overlap-dependent waiting in
        // its pre-createPr gate (waitForBlockers). Recorded before state persist
        // so a dependent resumed after a kill sees the blocker as settled too.
        overlap.noteSettled(n);
        // A cascade-abort `reason` is persisted on its own field (not overloaded
        // onto `error`) so a resumed run distinguishes a killed dependent from a
        // genuine error or an unknown-kind skip without scraping `error`.
        state.tickets[n] = stateFromOutcome(status, { ...state.tickets[n], ...(reason ? { skipReason: reason } : {}) });
        if (!a.dryRun) await saveState(state, a.cwd);
      },
    });

    if (!a.dryRun) await saveState(state, a.cwd);

    exitCode = result.failed.length > 0 ? 1 : 0;
    events.emit(EVT.RUN_END, undefined, {
      completed: result.completed,
      failed: result.failed,
      skipped: result.skipped,
      exitCode,
    });

    log("ok", `done: ${result.completed.length} merged/complete, ${result.failed.length} failed, ${result.skipped.length} skipped`);
    if (result.failed.length > 0) {
      log("error", `failed tickets: ${result.failed.map((n) => "#" + n).join(", ")}`);
    }
    log("dim", `state: ${`.scratch/dag-tickets/${runId}/state.json`}`);
  } finally {
    // #40: stop any agent still in flight (thrown error / a crash whose handler
    // didn't reach process.exit) so it doesn't keep editing the worktree after
    // the orchestrator has exited. No-op on a clean run (in-flight is empty once
    // runBatch returns) and on dry-run (nothing dispatched). Best-effort.
    await stopInFlight();
    await events.flush();
    guard?.detach();
    if (lockHandle) await lockHandle.release();
  }
  return exitCode;
}

function defaultRunId(a: ParsedArgs): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${describeTarget(a).replace(/[^a-z0-9]+/gi, "-").slice(0, 30)}-${stamp}`;
}

function describeTarget(a: ParsedArgs): string {
  if (a.parent) return `parent-${a.parent}`;
  if (a.label) return `label-${a.label}`;
  if (a.numbers.length) return `issues-${a.numbers.join(",")}`;
  return "frontier";
}
