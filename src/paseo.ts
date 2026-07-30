import { run } from "./shell.ts";
import { readFileSync } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ReviewVerdict, Ticket } from "./types.ts";
import type {
  AgentPort,
  BranchPort,
  Dispatcher,
  DispatchOpts,
  DispatchResult,
  EventSink,
  ImplFailReason,
  ImplResult,
  Logger,
  ReconcileResult,
  StepResult,
} from "./ports.ts";
import { normalizeBase, remoteRef, withLog } from "./ports.ts";
import { parseReviewVerdict } from "./parse.ts";
import { EVT } from "./events.ts";
import { NULL_SINK } from "./ports.ts";
import { branchFor } from "./gitgh.ts";

/**
 * Provider selection mirrors Paseo's `orchestration-preferences.json`:
 * impl/research use the workhorse, review/triage use a different provider so
 * the reviewer catches the implementer's blind spots. When the prefs file is
 * absent we fall back to sensible category defaults.
 */
export interface ProviderPrefs {
  impl: string;
  review: string;
  research: string;
  triage: string;
}

const FALLBACK_PREFS: ProviderPrefs = {
  impl: "codex/gpt-5.4",
  review: "claude/opus",
  research: "codex/gpt-5.4",
  triage: "claude/opus",
};

/**
 * Read the top-level `model = "…"` line from the user's `~/.codex/config.toml`.
 *  Only matches BEFORE the first `[table]` header so a `model =` inside a
 *  `[mcp_servers.x]` block can't win. Returns undefined when the file is
 *  absent / unreadable / has no top-level model. Pure string scan — no TOML
 *  dependency (codex's config is small + flat at the level we care about).
 *
 *  0.2.0 feedback A3: the hardcoded `codex/gpt-5.4` default ignored a user's
 *  real codex model. This lets the codex config drive the impl default when no
 *  paseo prefs file (and no --provider) is set, so dag-tickets stops silently
 *  running a model the user didn't configure.
 */
export function readCodexModel(home: string): string | undefined {
  let toml: string;
  try {
    // readFileSync keeps this sync + node-portable; the codex config is small.
    toml = readFileSync(`${home}/.codex/config.toml`, "utf8");
  } catch {
    return undefined;
  }
  for (const line of toml.split(/\r?\n/)) {
    // Stop at the first table header — `model` is only load-bearing at top level.
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
    if (m) return m[1]!;
  }
  return undefined;
}

export async function loadPrefs(): Promise<ProviderPrefs> {
  const home = process.env.HOME ?? "";
  if (!home) return { ...FALLBACK_PREFS };
  try {
    const f = Bun.file(`${home}/.paseo/orchestration-preferences.json`);
    if (await f.exists()) {
      const j = (await f.json()) as { providers?: Record<string, string> };
      const p = j.providers ?? {};
      return {
        impl: p.impl ?? FALLBACK_PREFS.impl,
        review: p.audit ?? FALLBACK_PREFS.review,
        research: p.research ?? FALLBACK_PREFS.research,
        triage: p.planning ?? FALLBACK_PREFS.triage,
      };
    }
  } catch {
    /* unreadable prefs → fall back */
  }
  // 0.2.0 feedback A3: no paseo prefs file → honour the user's codex config
  // (model = "…") instead of the hardcoded `gpt-5.4` default. Keeps review /
  // research / triage on their category defaults.
  const codexModel = readCodexModel(home);
  if (codexModel) {
    return {
      impl: `codex/${codexModel}`,
      review: FALLBACK_PREFS.review,
      research: `codex/${codexModel}`,
      triage: FALLBACK_PREFS.triage,
    };
  }
  return { ...FALLBACK_PREFS };
}

/**
 * 0.2.0 feedback A3 (the warn half the original PR dropped): when dag-tickets
 *  overrides the model the user configured in `~/.codex/config.toml`, say so.
 *  Returns a human warning string when a codex-bearing provider the run will use
 *  (impl / research) diverges from `codex/<codexModel>`, or `undefined` when
 *  there's nothing to override (no codex config, or the prefs already honour
 *  it). review/triage use category defaults (typically a non-codex provider), so
 *  they aren't checked — only the skills whose default is the codex provider.
 *
 *  Pure + exported so the policy is unit-testable without driving main(); the
 *  cli computes it AFTER applying `--provider` so a CLI override warns too.
 */
export function modelOverrideWarning(
  prefs: ProviderPrefs,
  home: string = process.env.HOME ?? "",
): string | undefined {
  const codexModel = readCodexModel(home);
  if (!codexModel) return undefined; // nothing configured to override
  const configured = `codex/${codexModel}`;
  const diverges = (p: string): boolean => p.startsWith("codex/") && p !== configured;
  const skills: string[] = [];
  if (diverges(prefs.impl)) skills.push(`implement=${prefs.impl}`);
  if (diverges(prefs.research)) skills.push(`research=${prefs.research}`);
  if (skills.length === 0) return undefined;
  return (
    `overriding codex config model ${configured} with: ${skills.join(", ")} ` +
    `(align ~/.paseo/orchestration-preferences.json or pass --provider to match, ` +
    `or ignore if intentional)`
  );
}

const DEFAULT_RUN_MS = 60 * 60 * 1000; // 60 min per agent run

/**
 * Recognised thinking levels (0.3.0 feedback A1). These are the `:thinking`
 * suffixes a user may append to a provider spec (`pi/zai/glm-5.2:max`) AND the
 * values `paseo run --thinking <id>` accepts. Pinned here (not discovered at
 * runtime) so a typo in a provider string fails loudly at preflight instead of
 * silently running at the default thinking level — the exact silent-intent
 * violation the feedback reported. Add a level here when paseo grows one.
 */
export const THINKING_LEVELS: ReadonlySet<string> = Object.freeze(
  new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
);

/**
 * Parse a provider spec of the form `provider/model[:thinking]` into its
 * dispatch-ready pieces (0.3.0 feedback A1).
 *
 * Paseo's `--provider` accepts `provider` or `provider/model` but does NOT parse
 * a `:thinking` suffix off it — so `pi/zai/glm-5.2:max` ran at the provider's
 * *default* thinking, silently discarding the user's `:max`. This helper is the
 * single source that splits the suffix back out so `dispatch()` can forward it
 * as `--thinking <id>`.
 *
 * Splitting rules (deliberately conservative — a false positive here silently
 * downgrades reasoning):
 *  - The thinking suffix is the token after the LAST `:`.
 *  - It is extracted ONLY when it is a recognised {@link THINKING_LEVELS} value.
 *    An unrecognised suffix is left on the provider string (paseo / preflight
 *    will reject an unknown model) rather than risk mis-parsing a provider name
 *    that happens to contain a colon.
 *  - A provider spec without `:` is returned verbatim (no thinking).
 *
 * Examples:
 *   `codex/gpt-5.4`            -> { provider: "codex/gpt-5.4" }
 *   `pi/zai/glm-5.2:max`       -> { provider: "pi/zai/glm-5.2", thinking: "max" }
 *   `claude/opus:high`         -> { provider: "claude/opus",  thinking: "high" }
 *   `codex/gpt-5.4:balanced`   -> { provider: "codex/gpt-5.4:balanced" } (unrecognised)
 *
 * Pure + exported so the parse rule is unit-tested directly, independent of
 * dispatch / preflight / the agent adapter that all consume it.
 */
export function parseProviderSpec(spec: string): {
  provider: string;
  thinking?: string;
} {
  const colon = spec.lastIndexOf(":");
  if (colon <= 0) return { provider: spec }; // no colon, or leading colon — not a thinking suffix
  const suffix = spec.slice(colon + 1);
  // Reject empty suffix / suffixes with a slash (a port-ish or path-ish token,
  // never a thinking id) so `host:8080`-style strings stay intact.
  if (!suffix || suffix.includes("/")) return { provider: spec };
  if (!THINKING_LEVELS.has(suffix)) return { provider: spec }; // unrecognised — leave intact
  return { provider: spec.slice(0, colon), thinking: suffix };
}

/** Grace margin so `paseo run`'s own `--wait-timeout` fires before run()'s
 *  hard kill: proportional to `waitMs`, floored at 1s and capped at 60s. Capped
 *  at 60s so a real long run (default 60min) keeps the unchanged prod margin;
 *  a tiny `waitMs` (e.g. the e2e suite via DAG_AGENT_TIMEOUT_MS) gets a tiny
 *  grace so the kill lands in ~ms instead of waiting a flat 60s. */
const dispatchGraceMs = (waitMs: number): number => Math.min(60_000, Math.max(1_000, waitMs));

/** Interval between `paseo logs` reads while waiting for the agent's transcript
 *  to stop changing. Read at call time (not module load) so a caller can adjust
 *  it via env between dispatches — prod leaves it unset → 2000ms (unchanged). */
const paseoLogPollMs = (): number => Number(process.env.DAG_PASEO_LOG_POLL_MS ?? 2000);

function msToDuration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
}

const RATE_LIMIT_RE = /\b429\b|usage limit reached|rate[ -]?limit|quota|too many requests/i;

/** Detect provider rate-limiting / quota exhaustion in agent output. */
export function isRateLimited(output: string): boolean {
  return RATE_LIMIT_RE.test(output);
}

/**
 * Relay/stream transport failure signatures. A transport blip (TCP reset,
 * dropped SSE stream, undici `fetch failed`, …) makes `paseo run` exit
 * non-zero even though the paseo daemon auto-recovers the agent. Such a
 * failure is transient — a backoff-and-retry clears it — so it's classified
 * distinctly from a hard agent failure (`implement-failed`). Mirrors the
 * shape of {@link RATE_LIMIT_RE}: a case-insensitive alternation over the
 * real errno codes / human phrases the relay prints.
 *
 * Includes `ETIMEDOUT` (the socket errno): a connect/read timeout is a
 * transport failure and belongs here. It can overlap with the wall-clock
 * {@link DispatchResult.timedOut} path (`agent-timeout`); both are transient,
 * so when both fire the only difference is the post-mortem label, not the
 * retry decision — see {@link implFailReason} for the precedence.
 */
const CONNECTION_ERROR_RE =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|\bETIMEDOUT\b|fetch failed|socket hang up|stream (?:closed|ended|aborted)|connection (?:reset|refused|closed|aborted)/i;

/** Detect a relay/stream transport failure in agent output. */
export function isConnectionError(output: string): boolean {
  return CONNECTION_ERROR_RE.test(output);
}

/**
 * Map a failed dispatch to its implement-failure reason, in precedence order:
 * rate-limited → connection-error → timeout → failed.
 *
 * - rate-limited first: `dispatchWithFallback` already retried across
 *   providers, so a surviving rate-limit is the dominant signal.
 * - connection-error before timeout: a transport reset that also burned the
 *   wall clock is labelled by its root cause. Both reasons are transient, so
 *   the retry decision is identical either way — this only sets the
 *   post-mortem label.
 *
 * Extracted from `PaseoAgent.implement` so the rule is named and directly
 * unit-testable (the ternary there had grown to a 4-way cascade).
 */
export function implFailReason(r: {
  rateLimited: boolean;
  connectionError: boolean;
  timedOut: boolean;
}): ImplFailReason {
  return r.rateLimited
    ? "rate-limited"
    : r.connectionError
      ? "connection-error"
      : r.timedOut
        ? "timeout"
        : "failed";
}

/**
 * Run-wide shared provider-rate-limit health (0.3.0 feedback C1).
 *
 * One instance per run, shared across every ticket's PaseoAgent dispatch.
 * When one agent detects a 429 on a provider, it marks that provider "hot" for
 * a cooldown window; every other agent about to dispatch on the SAME provider
 * waits until the window lapses instead of stampeding it in lockstep — the
 * correlation that, in the 0.3.0 field run, saw all three concurrent agents hit
 * glm simultaneously and then all switch to deepseek simultaneously, depleting
 * both. Cooperative backpressure, not authoritative circuit-breaking: a wait
 * is capped so a provider that stays hot can't stall the batch indefinitely,
 * and a dispatch still proceeds (and re-marks) once the window lapses.
 *
 * `now` / `sleep` / `random` are injectable so the backoff curve is deterministic
 * under test (mirrors retry.ts). Pure state (no I/O) so it unit-tests without a
 * clock. Exported from here (not its own module) because it's consumed only by
 * {@link PaseoAgent} and the cli that wires a single shared instance.
 */
export class ProviderHealth {
  private readonly hotUntil = new Map<string, number>();
  /**
   * @param now        injectable clock (test determinism)
   * @param sleep      injectable sleeper (test collapses to ~ms)
   * @param random     injectable RNG for fallback jitter (test determinism)
   * @param cooldownMs how long a provider stays "hot" after a 429 is observed.
   *                  60s mirrors a typical short provider rate-limit window;
   *  					long enough that peers in the same wave back off, short enough that a
   *  					batch keeps moving once it clears.
   * @param maxWaitMs  cap on a single waitIfHot so a persistently-hot provider
   *                  can't stall a ticket's slot for the whole cooldown.
   * @param jitterMs   ceiling on the fallback-switch jitter (full jitter below it).
   * @param log        optional human channel — one warn per actual backoff wait.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    private readonly random: () => number = Math.random,
    private readonly cooldownMs = 60_000,
    private readonly maxWaitMs = 90_000,
    private readonly jitterMs = 5_000,
    private readonly log?: Logger,
  ) {}

  /** Record that `provider` just returned a 429; peers should back off. Idempotent
   *  + extends the window if called again before it lapses (a fresh 429 resets
   *  the cooldown so a flapping provider stays hot). */
  markRateLimited(provider: string): void {
    this.hotUntil.set(provider, this.now() + this.cooldownMs);
  }

  /** Wait until `provider`'s cooldown window lapses before dispatching on it.
   *  No-op when the provider isn't hot. Capped at {@link maxWaitMs} so a hot
   *  provider can't stall the batch forever — after the cap the dispatch
   *  proceeds and will re-mark on a fresh 429. */
  async waitIfHot(provider: string): Promise<void> {
    const deadline = this.hotUntil.get(provider);
    if (deadline === undefined) return;
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      this.hotUntil.delete(provider);
      return;
    }
    const wait = Math.min(remaining, this.maxWaitMs);
    this.log?.("warn", `provider ${provider} recently rate-limited; backing off ${Math.round(wait / 1000)}s before dispatch`);
    await this.sleep(wait);
  }

  /** 0.3.0 feedback C1: a jittered delay before a fallback switch so concurrent
   *  agents don't deplete the fallback provider in lockstep (the second half of
   *  the correlation). Full jitter: `random() * jitterMs`, so the spread is
   *  [0, jitterMs] and peers desynchronise. */
  async fallbackJitter(): Promise<void> {
    const jitter = Math.round(this.random() * this.jitterMs);
    if (jitter > 0) await this.sleep(jitter);
  }

  /** Is `provider` currently inside its cooldown window? Observability / test hook. */
  isHot(provider: string): boolean {
    const deadline = this.hotUntil.get(provider);
    return deadline !== undefined && deadline > this.now();
  }
}

/**
 * Run one Paseo agent in a fresh worktree. `paseo run --json --new-workspace
 * worktree` creates the worktree + agent and blocks until the agent finishes.
 *
 * `paseo run`'s stdout is NOT the agent's answer — it's a status envelope
 * (`{agentId, status, provider, cwd, title}`). The agent's actual answer text
 * lives in `paseo logs <agentId>`. We fetch it with `--filter text` and strip
 * `[User]` lines so the prompt (which echoes the literal `REVIEW_VERDICT:`
 * instruction tokens) cannot false-match the verdict parser; the parser also
 * takes the LAST verdict match as a second line of defence.
 */
export async function dispatch(prompt: string, opts: DispatchOpts): Promise<DispatchResult> {
  const waitMs = opts.timeoutMs ?? DEFAULT_RUN_MS;
  // 0.3.0 feedback A1: parse the `:thinking` suffix off the provider spec HERE —
  // the single paseo-runner — so EVERY dispatch (the primary AND each fallback
  // in runWithFallback, which re-dispatches with `{...opts, provider: fb}`)
  // resolves its OWN thinking from its OWN provider string. An explicit
  // `opts.thinking` (the --thinking CLI override) wins over the parsed suffix,
  // applying one level across every provider; absent both, paseo's provider
  // default applies (unchanged behaviour). Paseo does not parse the suffix off
  // `--provider`, so stripping it here is what stops a `:max` spec from silently
  // running at medium.
  const { provider: providerSpec, thinking: parsedThinking } = parseProviderSpec(opts.provider);
  const thinking = opts.thinking ?? parsedThinking;
  const args = [
    "paseo",
    "run",
    "--json",
    "--provider",
    providerSpec,
    "--title",
    opts.title,
    "--worktree-slug",
    opts.slug,
    "--new-workspace",
    "worktree",
    "--wait-timeout",
    msToDuration(waitMs),
  ];
  if (opts.mode) args.push("--mode", opts.mode);
  if (thinking) args.push("--thinking", thinking);
  if (opts.branchMode === "branch-off") {
    args.push("--worktree-mode", "branch-off");
    if (opts.newBranch) args.push("--new-branch", opts.newBranch);
    if (opts.base) args.push("--base", opts.base);
  } else {
    args.push("--worktree-mode", "checkout-branch");
    if (opts.branch) args.push("--branch", opts.branch);
  }
  args.push(prompt);

  const r = await run(args, { cwd: opts.cwd, timeoutMs: waitMs + dispatchGraceMs(waitMs) });
  let status = r.ok ? "completed" : "failed";
  let output = r.stdout;
  // 0.2.0 feedback D1: the agent's worktree cwd (from the JSON envelope) so the
  // real-run stdout can show where work is happening. Declared outside the try
  // (where the envelope is parsed) so the return below can read it.
  let worktreeCwd: string | undefined;
  if (r.ok) {
    try {
      const j = JSON.parse(r.stdout) as { agentId?: string; status?: string; cwd?: string };
      if (typeof j.status === "string") status = j.status;
      const agentId = j.agentId;
      const worktreeCwdVal = typeof j.cwd === "string" ? j.cwd : undefined;
      worktreeCwd = worktreeCwdVal;
      if (agentId) {
        // The paseo log store can lag behind agent completion: reading once
        // right after `paseo run` returns sometimes captures a partial
        // transcript (missing the agent's final lines — e.g. REVIEW_VERDICT).
        // Poll until the filtered output stops changing so we capture the full
        // text instead of truncating mid-generation.
        let prev = "";
        for (let attempt = 0; attempt < 4; attempt++) {
          const lr = await run(["paseo", "logs", agentId, "--filter", "text"], {
            cwd: opts.cwd,
            timeoutMs: 60_000,
          });
          if (!lr.ok) break;
          const cur = lr.stdout
            .split(/\r?\n/)
            .filter((line) => !/^\[User\]/.test(line))
            .join("\n");
          output = cur;
          if (cur.length > 0 && cur === prev) break;
          prev = cur;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, paseoLogPollMs()));
        }
      }
    } catch {
      /* non-JSON stdout (older paseo) → keep the status envelope as output */
    }
  }
  const rateLimited = isRateLimited(output);
  // Transport failures (ECONNRESET / fetch failed / stream closed) classically
  // land on STDERR as an uncaught stack trace, not in the status envelope on
  // stdout — and on the !r.ok path `output` is stdout only (the JSON/log
  // polling above is skipped). Scan both streams so a relay blip reported to
  // stderr is still classified transient instead of falling through to a
  // terminal `implement-failed` (issue #39). rateLimited stays stdout-only to
  // avoid widening its (working) detection surface here.
  const connectionError = isConnectionError(output) || isConnectionError(r.stderr);
  // 0.2.0 feedback A1: persist the dispatch's full output (agent transcript +
  // relay stderr + exit code) so a failed step is debuggable from the run dir.
  // Best-effort + never throws: a write failure must not break the dispatch —
  // the human stderr log + events.jsonl still carry the outcome. `output` here
  // is the agent transcript on success (after stable-log polling) or the raw
  // status envelope on failure, which is exactly what an operator needs.
  const logPath = writeDispatchLog(opts, r, output);
  return {
    ok: r.ok && (status === "completed" || status === "idle"),
    output,
    timedOut: r.timedOut,
    rateLimited,
    connectionError,
    ...(logPath ? { logPath } : {}),
    ...(worktreeCwd ? { worktreeCwd } : {}),
  };
}

/**
 * 0.2.0 feedback A1: best-effort write of one dispatch's full output to
 *  `opts.logFile`. Returns the path written (so the caller can thread it onto
 *  the {@link DispatchResult}), or `undefined` when no logFile was requested
 *  (unit tests / no run dir) or the write failed. Never throws — a logging
 *  failure must not break the agent dispatch.
 *
 *  Exported so the log format (agent transcript + relay stderr + exit code) is
 *  unit-testable without spawning a real `paseo run`.
 */
export function writeDispatchLog(
  opts: DispatchOpts,
  r: { code: number; stderr: string; timedOut: boolean },
  output: string,
): string | undefined {
  if (!opts.logFile) return undefined;
  try {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    const body = [
      `# paseo run — ${opts.title}`,
      `# provider: ${opts.provider}`,
      `# worktree-slug: ${opts.slug}`,
      `# exit: ${r.code}${r.timedOut ? " (timed-out)" : ""}`,
      "",
      "## agent output",
      output || "(empty)",
      "",
      "## stderr",
      r.stderr || "(empty)",
      "",
    ].join("\n");
    writeFileSync(opts.logFile, body, "utf8");
    return opts.logFile;
  } catch {
    return undefined;
  }
}

/**
 * The rate-limit fallback loop — single source of truth shared by the real
 * {@link Dispatcher} (bound to {@link dispatch}) and by test fakes bound to a
 * scripted dispatch. Running the real loop over a fake dispatch is what lets
 * the retry ordering (onSwitch per fallback, stop on first success, skip the
 * primary if it reappears in the fallback list) be exercised without a
 * `paseo run`.
 *
 * `onSwitch` runs before each retry so the caller can reset worktree/branch
 * state (branch-off retries need a clean branch). A result that is still
 * rate-limited after exhausting fallbacks is marked !ok.
 */
export async function runWithFallback(
  dispatchFn: Dispatcher["dispatch"],
  prompt: string,
  opts: DispatchOpts,
  fallbacks: string[],
  onSwitch?: (nextProvider: string) => Promise<void>,
  /** 0.3.0 feedback C1: fires with the provider that just returned a 429,
   *  BEFORE the switch (or before giving up if it's the last fallback). The
   *  PaseoAgent wires this to {@link ProviderHealth.markRateLimited} so peers
   *  about to dispatch on the SAME provider back off instead of stampeding it
   *  in lockstep. Optional + additive so existing callers/tests are unchanged. */
  onRateLimited?: (provider: string) => void,
): Promise<DispatchResult> {
  let result = await dispatchFn(prompt, opts);
  if (result.rateLimited) onRateLimited?.(opts.provider);
  for (const fb of fallbacks) {
    if (!result.rateLimited) break;
    if (fb === opts.provider) continue;
    if (onSwitch) await onSwitch(fb);
    result = await dispatchFn(prompt, { ...opts, provider: fb });
    if (result.rateLimited) onRateLimited?.(fb);
  }
  if (result.rateLimited) result.ok = false;
  return result;
}

/**
 * Real {@link Dispatcher}: `dispatch` is the module-level run (stable-log
 * polling + JSON-envelope parsing); `dispatchWithFallback` binds that same
 * dispatch into {@link runWithFallback}, so prod behaviour is byte-identical to
 * the pre-injection implementation. Frozen so the default wiring is constant.
 * Passed as the default dispatcher to {@link PaseoAgent}.
 */
export const realDispatcher: Dispatcher = Object.freeze({
  dispatch,
  dispatchWithFallback: (
    prompt: string,
    opts: DispatchOpts,
    fallbacks: string[],
    onSwitch?: (nextProvider: string) => Promise<void>,
    onRateLimited?: (provider: string) => void,
  ): Promise<DispatchResult> => runWithFallback(dispatch, prompt, opts, fallbacks, onSwitch, onRateLimited),
});

// ---------------------------------------------------------------------------
// Prompt builders. The receiving Paseo agent starts with zero context, so each
// prompt is a self-contained briefing (per the paseo-handoff principle).
// ---------------------------------------------------------------------------

export function implementPrompt(t: Ticket, branch: string): string {
  return `You are implementing one GitHub issue in isolation. The mattpocock skills (/implement, /tdd, /code-review) are available in this session — use /implement to drive the work.

## Task
Implement issue #${t.number}: ${t.title}
Issue URL: ${t.url}

## Issue body
${t.body || "(no body)"}

## How to work
- Use /tdd at the repo's pre-agreed test seams where possible.
- Run typechecking regularly, single test files regularly, and the full test suite once at the end.
- Commit your work to the current branch (${branch}) with clear messages.
- When done, push the branch: \`git push -u origin ${branch}\`.

## Constraints
- DO NOT open a pull request — the orchestrator creates and merges the PR.
- DO NOT modify the issue tracker (no comments, label changes, or closes).
- Stay within the issue's scope; do not gold-plate.

Report a short summary of what you implemented and the final test result.`;
}

export function reviewPrompt(t: Ticket, baseRef: string): string {
  return `You are reviewing a fresh implementation in isolation. The /code-review skill is available — run it.

## Task
Review the work for issue #${t.number}: ${t.title} on the current branch.
Fixed point for the diff: \`origin/${baseRef}\` (the repo's default branch).

Run /code-review with that fixed point. Report findings under the Standards and Spec axes exactly as the skill prescribes.

## Verdict (required)
After your full report, your VERY LAST line must be EXACTLY one of these (copy verbatim, on its own line, nothing after it):
REVIEW_VERDICT: CLEAN
REVIEW_VERDICT: ISSUES 3

Replace 3 with the actual count of actionable findings. Do not embed the verdict inside a sentence or wrap it in markdown — it must be a standalone line so the orchestrator can parse it.

Do not modify any code. Do not commit or push.`;
}

export function fixPrompt(t: Ticket, reviewOutput: string, branch: string): string {
  return `You are fixing code-review findings on an in-flight implementation. The /implement and /tdd skills are available.

## Task
Issue #${t.number}: ${t.title}. A code review on this branch produced the findings below. Address every actionable finding.

## Review findings
${reviewOutput.trim() || "(no detail extracted)"}

## How to work
- Run the relevant tests after each fix; run the full suite once before finishing.
- Commit to the current branch (${branch}) and push: \`git push\`.

## Constraints
- DO NOT open a pull request.
- Only fix what the review raised — no drive-by refactors.

Report what you changed and the final test result.`;
}

export function singleShotPrompt(skill: string, t: Ticket): string {
  // Unattended /triage runs without a maintainer to confirm destructive
  // actions, so it is fenced at the write boundary (ADR-0001): non-destructive
  // transitions + comments are fine; closing the issue or applying `wontfix`
  // is not — those need a human. Research writes a markdown asset, not the
  // tracker, so the fence only applies to triage.
  const triageBoundary = skill === "triage" ? `
## Write boundary (unattended)
There is no maintainer to confirm destructive actions.
- You MAY apply non-destructive state transitions (label \`needs-info\` or \`ready-for-agent\`) and post comments / agent briefs via \`gh\`.
- You MUST NOT close the issue or apply the \`wontfix\` label — irreversible. If you recommend \`wontfix\`, post the rationale as a comment and leave the issue open for a human.` : "";
  return `You are working one GitHub issue in isolation. The /${skill} skill is available — run it.

## Task
Issue #${t.number}: ${t.title}
Issue URL: ${t.url}

## Issue body
${t.body || "(no body)"}
${triageBoundary}

Run /${skill} for this issue. When finished, post any required comment/output on the issue via \`gh\` per the skill's contract, then report a one-paragraph summary.`;
}

/**
 * 0.2.0 feedback A2: one throwaway dispatch to confirm a provider is reachable
 *  + authed before the run starts. A 401 / broken model fails fast (one short
 *  dispatch) instead of cascading silently across every ticket. Lightweight: no
 *  stable-log polling (we only care whether the dispatch completed), a short
 *  wall budget, and a `dag-preflight-<provider>` slug so a leftover preflight
 *  agent is recognisable. Never throws — the outcome is reported, not raised.
 */
export async function preflightProvider(
  provider: string,
  cwd?: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; error?: string }> {
  // 0.3.0 feedback A1 / D5: parse the `:thinking` suffix off the provider spec
  // so preflight exercises the SAME (provider, thinking) the real dispatches
  // use. A spec whose `:max` would have been silently dropped now fails fast at
  // preflight (or, once forwarded, runs at max) instead of cascading for 68min.
  const { provider: providerSpec, thinking } = parseProviderSpec(provider);
  const slug = `dag-preflight-${provider.replace(/[^a-z0-9]+/gi, "-").slice(0, 30)}`;
  const args = [
    "paseo",
    "run",
    "--json",
    "--provider",
    providerSpec,
    "--title",
    "dag-tickets preflight",
    "--worktree-slug",
    slug,
    "--new-workspace",
    "worktree",
    "--wait-timeout",
    msToDuration(timeoutMs),
  ];
  if (thinking) args.push("--thinking", thinking);
  args.push("ping");
  const r = await run(args, { cwd, timeoutMs: timeoutMs + 60_000 });
  if (r.timedOut) return { ok: false, error: "preflight timed out" };
  if (!r.ok) {
    // Surface the relay's own diagnostic (stderr holds the 401 / model error);
    // fall back to stdout / a bare exit code so the message is never empty.
    const detail = (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split(/\r?\n/)[0];
    return { ok: false, error: detail };
  }
  // A completed dispatch with a non-completed status (e.g. `error`) is still a
  // reachable-but-broken provider — treat anything but completed/idle as broken.
  try {
    const j = JSON.parse(r.stdout) as { status?: string };
    const status = j.status;
    if (status && status !== "completed" && status !== "idle") {
      return { ok: false, error: `agent status: ${status}` };
    }
  } catch {
    /* non-JSON stdout (older paseo) — the ok exit is enough */
  }
  return { ok: true };
}

/** One provider's preflight outcome. */
export interface PreflightResult {
  provider: string;
  ok: boolean;
  error?: string;
}

/**
 * 0.2.0 feedback A2: run `check` against every distinct provider the run would
 *  use, returning the per-provider outcome. Pure orchestration over an injected
 *  `check` so the ordering + dedupe + short-circuit are unit-testable without a
 *  real `paseo run`. Distinct providers are checked once each (a fallback that
 *  duplicates the primary isn't pinged twice). Sequential, not parallel: a
 *  provider that's down is the common case the flag exists to catch, and a
 *  parallel fan-out would stampede the same rate-limited provider.
 */
export async function preflight(
  providers: string[],
  check: (provider: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<PreflightResult[]> {
  const distinct = [...new Set(providers.filter(Boolean))];
  const out: PreflightResult[] = [];
  for (const p of distinct) out.push({ provider: p, ...(await check(p)) });
  return out;
}

/** True iff every preflight result passed. Convenience for the cli's abort gate. */
export function preflightOk(results: PreflightResult[]): boolean {
  return results.every((r) => r.ok);
}

/** Human-readable preflight summary for the top-level log. */
export function preflightSummary(results: PreflightResult[]): string {
  return results
    .map((r) =>
      r.ok ? `${r.provider}: ok` : `${r.provider}: FAIL${r.error ? ` (${r.error})` : ""}`,
    )
    .join(", ");
}

const SLUG = (n: number) => `dag-${n}`;

/**
 * Does a worktree path's final segment belong to ticket `n`? The worktree
 * layout contract in ONE place: a ticket's agent lives in a dir whose final
 * segment is `dag-<n>` (implement/fix) or `dag-<n>-…` (`-review`, or a
 * `-<counter>` reuse suffix). Requiring the segment to equal {@link SLUG} or
 * continue with `-` disambiguates siblings — `dag-1` / `dag-1-review` never
 * match `dag-12-1` / `dag-11-review-1`. Co-located with {@link SLUG} so the
 * `dag-<n>` shape has a single source (it was previously re-derived here and
 * in the slug itself).
 */
/** Does a worktree path's final segment belong to ANY ticket (the `dag-<n>`
 *  layout)? The single source of the `dag-<n>` shape: a ticket's agent lives in
 *  a dir whose final segment is `dag-<n>` (implement/fix) or `dag-<n>-…`
 *  (`-review`, or a `-<counter>` reuse suffix). Exported so `gc` reuses this
 *  instead of re-deriving `/^dag-\d+(-|$)/` (the Duplicated-Code smell the
 *  0.2.0 review flagged). The per-ticket {@link ownsWorktreeSegment} below adds
 *  the `=== SLUG(n)` exactness on top of this general predicate. */
export const isDagWorktreeSegment = (dir: string): boolean => {
  const seg = dir.split("/").pop() ?? "";
  return /^dag-\d+(-|$)/.test(seg);
};

/**
 * Does a worktree path's final segment belong to ticket `n` specifically?
 * Tighter than {@link isDagWorktreeSegment}: requiring the segment to equal
 * {@link SLUG} or continue with `-` disambiguates siblings — `dag-1` /
 * `dag-1-review` never match `dag-12-1` / `dag-11-review-1`.
 */
const ownsWorktreeSegment = (dir: string, n: number): boolean => {
  const seg = dir.split("/").pop() ?? "";
  return seg === SLUG(n) || seg.startsWith(`${SLUG(n)}-`);
};

/**
 * List every Paseo agent whose worktree belongs to ticket `ticketNumber`, in
 * ANY state (running / idle / error). The shared lookup behind both
 * {@link stopRunningAgent} (which filters to running) and
 * {@link archiveTicketAgents} (which takes all). Best-effort and never throws:
 * `paseo` may be absent in unit-test envs, unreachable, or emit malformed
 * output; `run()` itself throws on a missing executable (ENOENT), so the whole
 * body is guarded. Returns `[]` on any failure → the caller proceeds with
 * nothing to act on. Worktree ownership is decided by {@link ownsWorktreeSegment},
 * the single source of the `dag-<n>` layout.
 */
async function listOwnedAgents(
  cwd: string | undefined,
  ticketNumber: number,
): Promise<Array<{ id?: string; status?: string; cwd?: string }>> {
  try {
    const r = await run(["paseo", "ls", "--json"], { cwd });
    if (!r.ok) return [];
    let agents: Array<{ id?: string; status?: string; cwd?: string }> = [];
    try {
      const j = JSON.parse(r.stdout) as unknown;
      agents = Array.isArray(j) ? (j as typeof agents) : ((j as { agents?: typeof agents }).agents ?? []);
    } catch {
      return []; // malformed `paseo ls` output — nothing to act on
    }
    return agents.filter(
      (a) => typeof a.cwd === "string" && ownsWorktreeSegment(a.cwd, ticketNumber),
    );
  } catch {
    return []; // paseo missing / spawn error → nothing to act on
  }
}

/**
 * Stop every running Paseo agent whose worktree belongs to ticket `ticketNumber`
 * (#20). Best-effort and never throws: a lookup that finds nothing (the
 * dispatch already finished — lost race) is a no-op; the caller still cleans
 * the branch. Delegates the listing to {@link listOwnedAgents} so the worktree-
 * ownership rule has one home shared with {@link archiveTicketAgents}.
 */
export async function stopRunningAgent(
  cwd: string | undefined,
  ticketNumber: number,
): Promise<void> {
  const owned = await listOwnedAgents(cwd, ticketNumber);
  for (const a of owned) {
    if (a.status !== "running" || !a.id) continue;
    try {
      await run(["paseo", "stop", a.id], { cwd });
    } catch {
      /* one bad stop doesn't skip the rest — matches stopInFlight's contract */
    }
  }
}

/**
 * Archive every Paseo agent whose worktree belongs to ticket `ticketNumber`,
 * in ANY state (0.3.0 feedback E1). Each rate-limit fallback + each ticket
 * retry spawns a fresh Paseo agent; without archiving, a single run left 15+
 * orphan (stopped-but-not-archived) agents + duplicate workspaces per branch.
 * The git worktree is reclaimed by `cleanBranch`; this reclaims the Paseo agent
 * RECORD so `paseo ls` stays clean across runs. The agent transcript is already
 * captured per-step in the run's logs/ dir (0.2.0 A1), so archiving loses no
 * post-mortem evidence.
 *
 * Best-effort and never throws (mirrors {@link stopRunningAgent}): a missing
 * `paseo`, a malformed `ls`, or one bad `archive` never blocks the caller — the
 * settle / exit that calls this must proceed regardless. `--force` so a still-
 * running agent (a lost stop race) is interrupted-then-archived, not skipped.
 */
export async function archiveTicketAgents(
  cwd: string | undefined,
  ticketNumber: number,
): Promise<void> {
  const owned = await listOwnedAgents(cwd, ticketNumber);
  for (const a of owned) {
    if (!a.id) continue;
    try {
      await run(["paseo", "archive", a.id, "--force"], { cwd });
    } catch {
      /* one bad archive doesn't skip the rest — best-effort */
    }
  }
}

/**
 * Real {@link AgentPort} adapter. Owns the worktree-cleanup invariant (each
 * step starts on a clean branch), the rate-limit fallback chain, and verdict
 * parsing — so the lifecycle orchestrator branches on outcomes, never on
 * dispatch mechanics. The stable-log polling that guarantees a complete
 * transcript lives inside {@link dispatch}.
 *
 * Dispatch is injected via {@link Dispatcher}: prod wiring passes the default
 * {@link realDispatcher} (byte-identical to a bare module call), while focused
 * unit tests pass a fake that returns scripted {@link DispatchResult}s — so the
 * dispatch-result → {@link ImplResult}.reason map and the adapter-originated
 * unknown-verdict path are covered without spawning a process.
 */
export class PaseoAgent implements AgentPort {
  constructor(
    private readonly branch: BranchPort,
    private readonly prefs: ProviderPrefs,
    private readonly fallbacks: string[],
    private readonly log: Logger,
    private readonly cwd?: string,
    private readonly timeoutMs: number = DEFAULT_RUN_MS,
    private readonly dispatcher: Dispatcher = realDispatcher,
    // Defaulted (not required like RunContext.events) for two reasons: TS forbids
    // a required param after optional ones, and the dispatch-mechanics tests
    // above intentionally stay focused on dispatch — they rely on this NULL_SINK
    // default. Prod wiring and the event-asserting tests pass an explicit sink.
    private readonly events: EventSink = NULL_SINK,
    /** #20: stop the running Paseo agent for a ticket number. Injected so the
     *  abort path is unit-testable without `paseo ls|stop`; defaults to the
     *  module-level {@link stopRunningAgent} bound to this agent's cwd. */
    private readonly stopAgent: (ticketNumber: number) => Promise<void> = (n) =>
      stopRunningAgent(this.cwd, n),
    /** 0.2.0 feedback A1: directory to persist each dispatch's full output
     *  (`<n>-<step>.log`). Absent in unit tests → no logs written, dispatch
     *  still works. The cli sets it to the run's `.scratch/.../logs/` dir. */
    private readonly stepLogDir?: string,
    /** 0.3.0 feedback A1: a `--thinking <id>` CLI override applied to EVERY
     *  dispatch regardless of provider. Wins over a `:thinking` suffix baked
     *  into a provider string (dispatch honours opts.thinking before parsing).
     *  Absent → each provider's own `:thinking` suffix (or paseo's default)
     *  applies, so impl/review/fallback can each carry their own level. */
    private readonly thinkingOverride?: string,
    /** 0.3.0 feedback C1: run-wide shared provider-rate-limit health. When one
     *  ticket's dispatch detects a 429 on a provider, peers about to dispatch on
     *  the SAME provider back off (waitIfHot) instead of stampeding it in
     *  lockstep, and fallback switches are jittered so they don't deplete the
     *  fallback together. Absent in unit tests → no backpressure (unchanged
     *  behaviour); the cli wires ONE shared instance so every ticket consults
     *  the same cooldown state. */
    private readonly health?: ProviderHealth,
  ) {}

  /**
   * 0.2.0 feedback A1: absolute path for one dispatch's output log, or
   *  `undefined` when no run dir is wired (unit tests). Fix rounds get a
   *  `-r<round>` suffix so repeated rounds don't clobber each other.
   */
  private logFileFor(n: number, step: string, round?: number): string | undefined {
    if (!this.stepLogDir) return undefined;
    const suffix = round ? `-r${round}` : "";
    return `${this.stepLogDir.replace(/\/$/, "")}/${n}-${step}${suffix}.log`;
  }

  /** #40: best-effort stop of the ticket's running agent. Swallowed so a stop
   *  failure (paseo unreachable, lost race, a throwing injected fake) never
   *  blocks the caller — the rate-limit fallback / exit cleanup still proceeds.
   *  Mirrors the stop swallow in {@link abort}.
   */
  private async tryStop(t: Ticket): Promise<void> {
    try {
      await this.stopAgent(t.number);
    } catch {
      /* best-effort: a stop failure must not block the fallback or the exit */
    }
  }

  /**
   * #40: the shared half of every rate-limit fallback switch — log the switch,
   *  emit `provider.switch` (#19), stop the prior agent, and free the branch so
   *  the retry isn't blocked by a stale worktree. Stop-first ordering matters:
   *  cleaning a worktree a live agent is still editing races the agent (the
   *  orphan-agent accumulation #40 fixed). Extracted so the stop lives in ONE
   *  spot instead of being copy-pasted across review/fix (via onRateLimited)
   *  and implement (its inline callback, which adds deleteBranch after this).
   */
  private async switchAway(
    skill: string,
    from: string,
    next: string,
    t: Ticket,
    branch: string,
  ): Promise<void> {
    this.log("warn", `${skill} rate-limited; retrying on ${next}`, t.number);
    this.events.emit(EVT.PROVIDER_SWITCH, t.number, {
      skill,
      from,
      to: next,
      reason: "rate-limited",
    });
    await this.tryStop(t);
    await this.branch.cleanBranch(branch);
    // 0.3.0 feedback C1: jitter before the fallback dispatch so concurrent agents
    // switching at the same instant don't deplete the fallback in lockstep (the
    // second half of the rate-limit correlation). Per-provider HOT marking is
    // owned by the onRateLimited callback (precise: marks the provider that
    // actually 429'd, including each exhausted fallback); jitter is owned here.
    // Both no-op when no shared health is wired (unit tests).
    await this.health?.fallbackJitter();
  }

  /**
   * Rate-limit-retry hook shared by review() and fix(): a thin binder over
   * {@link switchAway} that closes over the skill + the primary provider.
   * implement() builds its own callback (a branch-off retry also has to
   * deleteBranch before re-creating).
   */
  private onRateLimited(
    skill: string,
    fromProvider: string,
    t: Ticket,
    branch: string,
  ): (next: string) => Promise<void> {
    return (next) => this.switchAway(skill, fromProvider, next, t, branch);
  }

  /** Fetch `origin/<base>` and return the resolved remote-tracking ref, or
   *  `null` if the fetch failed (offline / no remote / non-fast-forward).
   *
   *  A dependent ticket that starts after its blocker merged in the same run
   *  must branch off a base containing that merge; only a confirmed fetch makes
   *  that merge visible at `origin/<base>`. On `null` the caller MUST fail the
   *  ticket rather than branch off a possibly-stale tip (issue #15). */
  private async resolveBranchOffBase(base: string): Promise<string | null> {
    const bare = normalizeBase(base);
    const ok = await this.branch.ensureBaseRefFresh(bare);
    return ok ? remoteRef(bare) : null;
  }

  async implement(t: Ticket, branch: string, base: string): Promise<ImplResult> {
    const baseRef = await this.resolveBranchOffBase(base);
    if (baseRef === null) {
      // Failing beats a silent stale branch-off: a dependent composing on
      // pre-merge code is exactly the CI/merge-conflict failure #15 prevents.
      this.log("warn", `could not fetch ${remoteRef(base)} (offline?); failing implement to avoid a stale branch-off`, t.number);
      return { ok: false, commits: 0, reason: "stale-base" };
    }
    // 0.3.0 feedback C1: back off if a peer just rate-limited this provider.
    await this.health?.waitIfHot(this.prefs.impl);
    const r = await this.dispatcher.dispatchWithFallback(
      implementPrompt(t, branch),
      {
        provider: this.prefs.impl,
        title: `implement #${t.number}`,
        slug: SLUG(t.number),
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        branchMode: "branch-off",
        newBranch: branch,
        base: baseRef,
        logFile: this.logFileFor(t.number, "implement"),
        thinking: this.thinkingOverride,
      },
      this.fallbacks,
      async (next) => {
        // A branch-off retry must re-create the branch: switchAway (#40) stops
        // the prior agent + frees the worktree, then the branch is dropped so
        // git can re-create it (git forbids a branch in >1 worktree).
        await this.switchAway("implement", this.prefs.impl, next, t, branch);
        await this.branch.deleteBranch(branch);
      },
      this.markHot,
    );
    if (!r.ok) {
      return { ok: false, commits: 0, reason: implFailReason(r), ...withLog(r) };
    }
    // 0.2.0 feedback D1: print the worktree path as soon as the dispatch
    // succeeded (envelope parsed) — before the commit count — so an operator
    // can match `paseo worktree list` / `ls` even when the implement later
    // fails for another reason (e.g. empty). Review/fix reuse this worktree,
    // so a ticket prints its path exactly once (at implement), not per step.
    if (r.worktreeCwd) this.log("dim", `worktree: ${r.worktreeCwd}`, t.number);
    // A rate-limited or empty agent still "completes" with no diff — count
    // against the fetched origin/<base> so a stale local main can't mask it.
    const commits = await this.branch.commitCount(baseRef, branch);
    if (commits === 0) return { ok: false, commits: 0, reason: "empty", ...withLog(r) };
    return { ok: true, commits, ...withLog(r) };
  }

  /**
   * 0.3.0 feedback C1: bound callback that marks a provider hot when its
   *  dispatch returned a 429. Passed as runWithFallback's `onRateLimited` so
   *  the SHARED {@link ProviderHealth} learns about a rate-limit the instant a
   *  peer observes it — peers about to dispatch on the same provider then back
   *  off (waitIfHot) instead of stampeding it in lockstep. Arrow-bound (not a
   *  method) so it can be passed as a bare callback without losing `this`. A
   *  no-op when no health is wired (unit tests).
   */
  private readonly markHot = (provider: string): void => {
    this.health?.markRateLimited(provider);
  };

  /** Single review attempt. Stable-log polling in dispatch guarantees the full
   *  output, so an unparseable verdict means the agent genuinely didn't emit one. */
  async review(t: Ticket, branch: string, base: string): Promise<ReviewVerdict> {
    await this.branch.cleanBranch(branch);
    // 0.3.0 feedback C1: back off if a peer just rate-limited this provider.
    await this.health?.waitIfHot(this.prefs.review);
    const r = await this.dispatcher.dispatchWithFallback(
      reviewPrompt(t, base),
      {
        provider: this.prefs.review,
        title: `review #${t.number}`,
        slug: `${SLUG(t.number)}-review`,
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        branchMode: "checkout-branch",
        branch,
        logFile: this.logFileFor(t.number, "review"),
        thinking: this.thinkingOverride,
      },
      this.fallbacks,
      this.onRateLimited("review", this.prefs.review, t, branch),
      this.markHot,
    );
    if (!r.ok) {
      this.log("warn", `review agent failed${r.timedOut ? " (timeout)" : ""}`, t.number);
      return { kind: "unknown", issueCount: 0, raw: r.output.slice(-800), ...withLog(r) };
    }
    const v = parseReviewVerdict(r.output);
    return { ...v, ...withLog(r) };
  }

  async fix(t: Ticket, verdict: ReviewVerdict, branch: string, round: number): Promise<StepResult> {
    await this.branch.cleanBranch(branch);
    // 0.3.0 feedback C1: back off if a peer just rate-limited this provider.
    await this.health?.waitIfHot(this.prefs.impl);
    const r = await this.dispatcher.dispatchWithFallback(
      fixPrompt(t, verdict.raw, branch),
      {
        provider: this.prefs.impl,
        title: `fix #${t.number} r${round}`,
        slug: SLUG(t.number),
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        branchMode: "checkout-branch",
        branch,
        logFile: this.logFileFor(t.number, "fix", round),
        thinking: this.thinkingOverride,
      },
      this.fallbacks,
      this.onRateLimited("fix", this.prefs.impl, t, branch),
      this.markHot,
    );
    return { ok: r.ok, timedOut: r.timedOut, rateLimited: r.rateLimited, ...withLog(r) };
  }

  async singleShot(skill: string, t: Ticket, branch: string, base: string): Promise<StepResult> {
    const provider = skill === "research" ? this.prefs.research : this.prefs.triage;
    const baseRef = await this.resolveBranchOffBase(base);
    if (baseRef === null) {
      this.log("warn", `could not fetch ${remoteRef(base)} (offline?); failing ${skill} to avoid a stale branch-off`, t.number);
      return { ok: false, timedOut: false, rateLimited: false };
    }
    const r = await this.dispatcher.dispatch(singleShotPrompt(skill, t), {
      provider,
      title: `${skill} #${t.number}`,
      slug: SLUG(t.number),
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      branchMode: "branch-off",
      newBranch: branch,
      base: baseRef,
      logFile: this.logFileFor(t.number, skill),
      thinking: this.thinkingOverride,
    });
    // 0.2.0 feedback D1: single-shot tickets (triage/research) create their own
    // worktree too — print its path so an operator can find it post-run, the
    // same way implement-kind tickets do.
    if (r.worktreeCwd) this.log("dim", `worktree: ${r.worktreeCwd}`, t.number);
    return { ok: r.ok, timedOut: r.timedOut, rateLimited: r.rateLimited, ...withLog(r) };
  }

  providerLabel(skill: "implement" | "review" | "triage" | "research"): string {
    switch (skill) {
      case "implement":
        return this.prefs.impl;
      case "review":
        return this.prefs.review;
      case "triage":
        return this.prefs.triage;
      case "research":
        return this.prefs.research;
    }
  }

  /**
   * #20: abort an in-flight ticket — stop its running agent dispatch and clean
   * its worktree so a cascade-doomed dependent doesn't burn a full
   * implement→review→fix→CI cycle. Called by the scheduler when a dependent's
   * blocker settles failed/skipped. Best-effort and never throws: the scheduler
   * has ALREADY recorded the dependent cascade-skipped, so a stop/clean that
   * finds nothing (lost race) or fails leaves the persisted state correct.
   */
  async abort(t: Ticket): Promise<void> {
    try {
      await this.stopAgent(t.number);
    } catch {
      /* best-effort: scheduler already recorded cascade-skipped */
    }
    const branch = branchFor(t.number, t.title);
    try {
      await this.branch.cleanBranch(branch);
    } catch {
      /* a stale/missing worktree is fine — the agent stop is the load-bearing part */
    }
    this.log("warn", `cascade-abort: stopped agent + cleaned worktree ${branch}`, t.number);
  }

  /**
   * #40: stop every agent this run still has in flight — called on graceful
   *  exit (try/finally) and on signal/crash exit (SIGINT/SIGTERM,
   *  uncaughtException, unhandledRejection) so a stopped or crashed run doesn't
   *  orphan running agents on the worktree. Best-effort and never throws: a
   *  per-ticket stop failure doesn't skip the rest, and a stop of an
   *  already-stopped / never-started agent is a no-op. Worktrees are left
   *  intact (cleaned at the next step's cleanBranch, or harmless on resume) —
   *  this is the agent-only half of cleanup; {@link abort} does stop+clean for
   *  the cascade-doomed path. Snapshots the iterable so a concurrent settle
   *  mutating the caller's Set can't corrupt the iteration.
   */
  async stopInFlight(ticketNumbers: Iterable<number>): Promise<void> {
    for (const n of [...ticketNumbers]) {
      try {
        await this.stopAgent(n);
      } catch {
        /* best-effort: keep going so one bad stop doesn't leak the rest */
      }
    }
  }

  /**
   * #29: rebase an overlapping in-flight dependent onto its just-merged blocker.
   * Called when a blocker settles `done` while the dependent is still in flight
   * (it launched via overlap). `blockerTipSha` is the blocker tip the dependent
   * branched from; `base` is the integration branch whose `origin/<base>` now
   * holds the merge. Returns the outcome so the caller can fail the dependent on
   * conflict. Never throws: a failed fetch → `stale-base`; a conflicting rebase
   * → `overlap-rebase`; any throw → `overlap-rebase`. Best-effort like
   * {@link abort} — a missing worktree (lost race) is a clean success.
   *
   * Operational note: rebasing the branch checked out in a worktree while its
   * agent is mid-dispatch is racy. The safe wiring is the pull model — call
   * this at the dependent's create-Pr boundary (between dispatches), not mid-run.
   */
  async reconcile(t: Ticket, blockerTipSha: string, base: string): Promise<ReconcileResult> {
    const branch = branchFor(t.number, t.title);
    try {
      const fresh = await this.branch.ensureBaseRefFresh(base);
      if (!fresh) {
        this.log(
          "warn",
          `overlap-reconcile: could not fetch ${remoteRef(base)} (offline?); failing rebase to avoid a stale base`,
          t.number,
        );
        return { ok: false, reason: "stale-base" };
      }
      const ok = await this.branch.rebaseOnto(branch, blockerTipSha, remoteRef(base));
      if (!ok) {
        this.log(
          "warn",
          `overlap-reconcile: rebase of ${branch} onto ${remoteRef(base)} conflicted; dependent needs human resolution`,
          t.number,
        );
        return { ok: false, reason: "overlap-rebase" };
      }
      this.log("ok", `overlap-reconcile: rebased ${branch} onto ${remoteRef(base)}`, t.number);
      return { ok: true };
    } catch {
      return { ok: false, reason: "overlap-rebase" };
    }
  }
}
