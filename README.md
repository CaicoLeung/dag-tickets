# dag-tickets

A DAG-aware batch driver for [mattpocock-skills](https://github.com/mattpocock/skills) tickets. It chews through a batch of GitHub issues — a parent issue's sub-issues, everything labelled `ready-for-agent`, or an explicit list — and drives each through the full per-ticket lifecycle you normally do by hand:

```
implement  →  code-review  →  fix-loop  →  PR  →  CI  →  (auto-)merge  →  close
```

Independent tickets fan out across **Paseo worktrees in parallel**; tickets whose `Blocked by` edges gate them are **serialised** in dependency order. You stop being the scheduler.

## When to use it

You already work ticket-by-ticket in Paseo: `/implement`, then a fresh session for `/code-review`, then fix, push, merge. Doing that for 5+ tickets is the pain this removes. Hand it a batch and walk away.

## Prerequisites

- **Paseo** CLI on PATH (`paseo --version`). Agents run via `paseo run --new-workspace worktree`.
- **gh** authenticated (`gh auth status`) with repo + PR + merge permissions.
- The target repo set up with mattpocock-skills: `/setup-matt-pocock-skills` run once, so issues carry the triage labels (`ready-for-agent`, etc.) and the agents have `/implement`, `/code-review`, `/tdd` available.
- **Bun** ≥ 1.1.

Provider defaults come from `~/.paseo/orchestration-preferences.json` (categories `impl`/`audit`/`research`/`planning`). If absent, dag-tickets falls back to `codex/gpt-5.4` for implement/fix and `claude/opus` for review — review deliberately uses a *different* provider so the reviewer catches the implementer's blind spots.

Any provider string accepts a `:thinking` suffix (e.g. `pi/zai/glm-5.2:max`) that dag-tickets parses and forwards to `paseo run --thinking <id>` — paseo itself does **not** parse the suffix off `--provider`, so without this a `:max` spec would silently run at the provider's default thinking level. Use `--thinking <id>` to force one level across every dispatch.

## Install

Prebuilt binaries (no Bun or Node required at runtime) for macOS (Apple Silicon
+ Intel) and Linux (x64 + arm64) are published with each release.

**Homebrew** (macOS):

```bash
brew tap CaicoLeung/tap
brew install dag-tickets
```

**Installer script** (macOS or Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/CaicoLeung/dag-tickets/main/install.sh | bash
```

Installs to `~/.dag-tickets/bin` and prints the PATH line for your shell.

**From source** (development):

```bash
git clone https://github.com/CaicoLeung/dag-tickets && cd dag-tickets
bun install            # dev deps (typescript, @types/bun)
bun run bin/dag-tickets.ts --help
```

## Usage

Run from inside the project repo (where `gh` + paseo resolve), or pass `--cwd`.

```bash
dag-tickets                         # the frontier: all open ready-for-agent
dag-tickets --frontier              #   (explicit)
dag-tickets --parent 42             # sub-issues of parent issue #42
dag-tickets --label ready-for-agent
dag-tickets 12 15 23                # explicit issue numbers

dag-tickets --dry-run 12 15         # print the plan, dispatch nothing
dag-tickets --concurrency 5 --label ready-for-agent
dag-tickets --no-auto-merge 12 15   # stop before merge; leave PRs for you
dag-tickets --resume <run-id>       # pick up a killed run where it left off
```

### Flags

| flag | default | meaning |
| --- | --- | --- |
| `--parent <n>` | — | process sub-issues of parent issue `<n>` (native sub-issues, else `#N` refs in its body) |
| `--label <name>` | — | process open issues with this label |
| `--frontier` | on | process the open implement-label frontier (the default target) |
| `--concurrency <n>` | `3` | max tickets in flight |
| `--max-fix-rounds <n>` | `2` | implement↔review fix iterations before escalating |
| `--max-ticket-retries <n>` | `2` | whole-ticket retries after a transient failure (CI flake / rate-limit / merge race) with exponential backoff. `0` disables |
| `--auto-merge` / `--no-auto-merge` | auto | merge when review is clean + CI green (`--no-auto-merge` leaves PRs for you) |
| `--merge-strategy <s>` | `squash` | `squash` \| `merge` \| `rebase` |
| `--require-checks` | off | a PR with no CI does **not** satisfy the merge gate |
| `--ci-watch-timeout-minutes <n>` | `30` | ceiling on `gh pr checks --watch`; a stuck check otherwise polls forever and starves a slot. The timeout becomes a transient `ci-failed` (retried with backoff). `0` = no bound |
| `--provider <p>` | prefs/`codex/gpt-5.4` | override the implement/fix provider. Accepts a `:thinking` suffix (e.g. `pi/zai/glm-5.2:max`) forwarded to `paseo run --thinking` |
| `--review-provider <p>` | prefs/`claude/opus` | override the review provider (same `:thinking` suffix honoured) |
| `--thinking <id>` | — | thinking level (`off\|minimal\|low\|medium\|high\|xhigh\|max`) forwarded to **every** dispatch. Overrides any `:thinking` suffix baked into a provider string; without it the suffix is honoured per-provider |
| `--impl-label` / `--triage-label` / `--research-label` | mattpocock defaults | override routing labels |
| `--cwd <path>` | `.` | operate on a different checkout |
| `--run-id <id>` | derived | name this run (state file path) |
| `--resume <id>` | — | resume a previous run; skip its merged/failed tickets |
| `--dry-run` | off | print the per-ticket plan, dispatch nothing |
| `-h, --help` | | show help |
| `-V, --version` | | show the version and exit |

## How a ticket flows

1. **Route by label** (on the **state** role). `ready-for-agent` → implement lifecycle (PR + merge). `needs-triage` → `/triage` single-shot. Research labels → `/research` single-shot. An issue with a **category** role (`bug`/`enhancement`) but *no* state role is an "orphan" → `/triage`. `needs-info` / `ready-for-human` / `wontfix` are intentionally skipped (not for a batch agent). Override any list with `--impl-label` / `--triage-label` / `--category-label` / `--skip-label`.
2. **Build the DAG.** `Blocked by` edges are read from each issue body — both `#NN` references and **title references** (e.g. `Blocked by: T2 — Ticket-type labels + routing dispatch`), which are matched to batch tickets by normalised title. A cycle aborts the run.
3. **Walk the frontier.** Tickets with all blockers done launch up to `--concurrency` at a time. Each runs in its own fresh Paseo worktree. When one finishes, its dependents become eligible.
4. **Per implement ticket:** `paseo run` `/implement` (branch-off from the default branch) → fresh `paseo run` `/code-review` against `origin/<default>` → if the verdict is `ISSUES`, a bounded fix-loop (fix agent → re-review) up to `--max-fix-rounds` → `gh pr create` → `gh pr checks --watch` → `gh pr merge` + close the issue.
5. **The review verdict** is the contract between agent and driver. The review prompt asks the agent to end with `REVIEW_VERDICT: CLEAN` or `REVIEW_VERDICT: ISSUES <n>`. An unparseable verdict is retried once, then escalated — the driver **never auto-merges on an unknown verdict**. The fix-loop is regression-guarded: if a fix round produces *more* issues than the prior review, the loop aborts immediately (`fix-regression`) instead of diverging, and the per-round count trail (`r1:2 → r2:5`) is logged + recorded on the failure.
6. **Transient failures retry, terminal ones cascade.** A ticket that fails for a transient reason (CI flake, momentary rate-limit, merge race, an offline base-ref fetch, a relay connection/stream error like `ECONNRESET`) is retried with exponential backoff up to `--max-ticket-retries` before being declared terminal and cascading to its dependents. Each failure is tagged with a machine-readable `reason` (recorded in `state.json` and `events.jsonl`) so the post-mortem no longer conflates *"issues remain after N rounds"* with *"verdict unknown"*. Terminal causes (`review-issues`, `implement-empty`, `fix-regression`, …) are never retried — they cascade immediately, exactly as before.

## Safety

- **Auto-merge is gated on a clean review AND green CI.** A failing check leaves the PR open for you. `--require-checks` additionally blocks merge when a repo has no CI.
- **A failed or skipped ticket cascades** to its not-yet-started dependents (marked the same status, not retried), so a doomed branch can't hang the run. Dependents already in flight are left to settle.
- **Resume is idempotent.** State lives at `.scratch/dag-tickets/<run-id>/state.json`. It's seeded at `run.start` (every actionable ticket `pending`) and persisted before the first dispatch, so even a run killed mid-first-ticket leaves a resumable file. Re-running `--resume <id>` skips merged tickets, restarts in-flight ones, and keeps failed ones failed.
- **Interrupted runs leave a bounded trace.** `SIGINT`/`SIGTERM`/a crash stops in-flight agents, emits a terminal `run.interrupted` event, flushes `events.jsonl`, and releases the run lock — a consumer sees the run was interrupted, not an unbounded "in flight" tail.
- **Rate-limit backpressure is cooperative.** When one ticket's dispatch hits a 429, the provider is marked hot for a cooldown; peers about to dispatch on the *same* provider back off instead of stampeding it in lockstep, and fallback switches are jittered so concurrent agents don't deplete the fallback together.
- **One run per checkout.** The driver takes a repo-wide lock at `.scratch/dag-tickets/run.lock` before dispatching, so two `dag-tickets` runs can't fight over the shared `dag-<n>` worktrees/branches — the second run aborts with a clear message. A lock left behind by a killed run (the holder pid is dead) is recovered automatically on the next start. The lock is released on normal exit **and** on `SIGINT`/`SIGTERM`. `--dry-run` is lock-free (it dispatches nothing, so it never blocks a real run).
- The driver never edits issue bodies; it only opens PRs, merges, and closes with a linking comment.

## Environment

A few timings are env-tunable so a host running quick local batches (or the
self-tests, which collapse the waits) can shrink them. All default to the prod
caps below when unset.

| Variable | Default | What it bounds |
| --- | --- | --- |
| `DAG_PASEO_LOG_POLL_MS` | `2000` | Interval between `paseo logs` reads while waiting for the review transcript to stop changing. Lower it on hosts whose paseo log store updates quickly. |
| `DAG_RETRY_BASE_MS` | `30000` | Base for the whole-ticket transient-retry backoff (full-jitter is applied on top). |
| `DAG_RETRY_MAX_MS` | `300000` | Cap for the same backoff curve. |
| `DAG_CI_WATCH_TIMEOUT_MS` | unset → flag default | Raw-ms override for the `--ci-watch-timeout-minutes` ceiling (the flag is whole minutes, too coarse where a tight bound is wanted). When set + valid it wins over the flag, exactly like the `DAG_RETRY_*` hard overrides; unset leaves the flag/default standing. |
| `DAG_AGENT_TIMEOUT_MS` | unset → `3600000` (60min) | Per-agent-run wall budget. Unset leaves `PaseoAgent`'s 60min default; set to shrink it for quick local batches. |

## Verify before trusting it

```bash
bun test                 # 284 tests: unit (DAG/frontier/cascade/cycles/parsing/args)
                         #          + real-CLI e2e (concurrency, overlap, retry, fallback)
bun run typecheck        # tsc --noEmit
dag-tickets --dry-run --parent 42   # see the plan before any agent runs
```

## Design notes

- **Hybrid driver.** The script owns the deterministic skeleton (DAG, scheduling, PR, CI, merge). Only the implement↔review iteration is delegated to agents, bounded by `--max-fix-rounds`. No LLM is spent on orchestration itself.
- **Why no Orca orchestration.** The steps are mechanical; a deterministic CLI is debuggable, resumable, and token-free to run. Paseo worktrees give the isolation Orca would.
- **Worktrees persist in Paseo** after each step (named `dag-<n>`), so you can inspect or kill them in the Paseo UI. The driver does not auto-archive — you stay in control of the machines.
