import { buildGraph, CycleError } from "./graph.ts";
import { runBatch } from "./scheduler.ts";
import { processTicket, type RunContext, type Logger } from "./lifecycle.ts";
import { loadPrefs, type ProviderPrefs } from "./paseo.ts";
import { DEFAULT_ROUTING, type RoutingConfig } from "./config.ts";
import {
  listSubIssues,
  searchByLabel,
  fetchIssues,
} from "./discover.ts";
import { repoInfo, type MergeStrategy } from "./gitgh.ts";
import type { Ticket, TicketStatus } from "./types.ts";
import { loadState, saveState, type RunState, type TicketState } from "./state.ts";

interface ParsedArgs {
  parent?: number;
  label?: string;
  frontier: boolean;
  numbers: number[];
  concurrency: number;
  maxFixRounds: number;
  autoMerge: boolean;
  noAutoMerge: boolean;
  mergeStrategy: MergeStrategy;
  requireChecks: boolean;
  dryRun: boolean;
  provider?: string;
  reviewProvider?: string;
  cwd?: string;
  runId?: string;
  resume?: string;
  implLabel?: string;
  triageLabel?: string;
  researchLabel?: string;
  help: boolean;
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
  --auto-merge            Merge when review clean + CI green (default).
  --no-auto-merge         Stop before merge; leave PRs for you to merge.
  --merge-strategy <s>    squash | merge | rebase (default squash).
  --require-checks        A PR with no CI does NOT satisfy the merge gate.
  --provider <p>          Override the implement/fix provider.
  --review-provider <p>   Override the review provider.
  --impl-label <l>        Override the implement-routing label.
  --triage-label <l>      Override the triage-routing label.
  --research-label <l>    Override the research-routing label.
  --cwd <path>            Operate on a different checkout.
  --run-id <id>           Name this run (for the state file).
  --resume <id>           Resume a previous run; skip its merged/failed tickets.
  --dry-run               Print the per-ticket plan and dispatch nothing.
  -h, --help              Show this help.

The driver reads \`~/.paseo/orchestration-preferences.json\` for providers and
falls back to codex/gpt-5.4 (impl) + claude/opus (review) when absent.
`;

function parseArgs(argv: string[]): ParsedArgs {
  const a: ParsedArgs = {
    frontier: false,
    numbers: [],
    concurrency: 3,
    maxFixRounds: 2,
    autoMerge: false,
    noAutoMerge: false,
    mergeStrategy: "squash",
    requireChecks: false,
    dryRun: false,
    help: false,
  };
  const num = (v: string): number | undefined => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case "-h":
      case "--help":
        a.help = true; break;
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
      case "--merge-strategy": {
        const s = next() as MergeStrategy;
        if (s === "squash" || s === "merge" || s === "rebase") a.mergeStrategy = s;
        break;
      }
      case "--provider":
        a.provider = next(); break;
      case "--review-provider":
        a.reviewProvider = next(); break;
      case "--impl-label":
        a.implLabel = next(); break;
      case "--triage-label":
        a.triageLabel = next(); break;
      case "--research-label":
        a.researchLabel = next(); break;
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

function buildRouting(a: ParsedArgs): RoutingConfig {
  const cfg: RoutingConfig = {
    implementLabels: [...DEFAULT_ROUTING.implementLabels],
    triageLabels: [...DEFAULT_ROUTING.triageLabels],
    researchLabels: [...DEFAULT_ROUTING.researchLabels],
  };
  if (a.implLabel) cfg.implementLabels = [a.implLabel];
  if (a.triageLabel) cfg.triageLabels = [a.triageLabel];
  if (a.researchLabel) cfg.researchLabels = [a.researchLabel];
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

function stateFromOutcome(status: TicketStatus, o?: { branch?: string; pr?: number; rounds?: number; error?: string }): TicketState {
  return {
    status,
    branch: o?.branch,
    pr: o?.pr,
    rounds: o?.rounds,
    error: o?.error,
  };
}

export async function main(argv: string[]): Promise<number> {
  let a: ParsedArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
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

  const actionable = open.filter((t) => t.kind !== "unknown");
  const unrouted = open.filter((t) => t.kind === "unknown");
  for (const t of unrouted) {
    log("warn", `no routing label (need one of ${[...cfg.implementLabels, ...cfg.triageLabels, ...cfg.researchLabels].join("/")}); skipping`, t.number);
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

  log("info", `planned ${actionable.length} ticket(s); concurrency ${a.concurrency}; base ${baseBranch}; ${a.dryRun ? "DRY RUN" : a.noAutoMerge ? "manual merge" : "auto-merge " + a.mergeStrategy}`);

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

  const seedCompleted = Object.entries(state.tickets)
    .filter(([, s]) => s.status === "done")
    .map(([n]) => parseInt(n, 10));
  const seedFailed = Object.entries(state.tickets)
    .filter(([, s]) => s.status === "failed")
    .map(([n]) => parseInt(n, 10));

  const ctx: RunContext = {
    prefs,
    baseBranch,
    cwd: a.cwd,
    maxFixRounds: a.maxFixRounds,
    mergeStrategy: a.mergeStrategy,
    autoMerge: a.noAutoMerge ? false : a.autoMerge ? true : true,
    requireChecks: a.requireChecks,
    dryRun: a.dryRun,
    log,
  };

  const result = await runBatch(graph, {
    concurrency: a.concurrency,
    seedCompleted,
    seedFailed,
    process: async (n) => {
      const t = graph.byNumber.get(n)!;
      const outcome = await processTicket(t, ctx);
      state.tickets[n] = stateFromOutcome(outcome.status, outcome);
      if (!a.dryRun) await saveState(state, a.cwd);
      return outcome.status;
    },
    onSettle: async (n, status) => {
      state.tickets[n] = stateFromOutcome(status, state.tickets[n]);
      if (!a.dryRun) await saveState(state, a.cwd);
    },
  });

  if (!a.dryRun) await saveState(state, a.cwd);

  log("ok", `done: ${result.completed.length} merged/complete, ${result.failed.length} failed, ${result.skipped.length} skipped`);
  if (result.failed.length > 0) {
    log("error", `failed tickets: ${result.failed.map((n) => "#" + n).join(", ")}`);
  }
  log("dim", `state: ${`.scratch/dag-tickets/${runId}/state.json`}`);
  return result.failed.length > 0 ? 1 : 0;
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
