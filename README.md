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
| `--auto-merge` / `--no-auto-merge` | auto | merge when review is clean + CI green (`--no-auto-merge` leaves PRs for you) |
| `--merge-strategy <s>` | `squash` | `squash` \| `merge` \| `rebase` |
| `--require-checks` | off | a PR with no CI does **not** satisfy the merge gate |
| `--provider <p>` | prefs/`codex/gpt-5.4` | override the implement/fix provider |
| `--review-provider <p>` | prefs/`claude/opus` | override the review provider |
| `--impl-label` / `--triage-label` / `--research-label` | mattpocock defaults | override routing labels |
| `--cwd <path>` | `.` | operate on a different checkout |
| `--run-id <id>` | derived | name this run (state file path) |
| `--resume <id>` | — | resume a previous run; skip its merged/failed tickets |
| `--dry-run` | off | print the per-ticket plan, dispatch nothing |
| `-h, --help` | | show help |

## How a ticket flows

1. **Route by label.** `ready-for-agent` → implement lifecycle (PR + merge). `needs-triage` → `/triage` single-shot. Research labels → `/research` single-shot. Unlabelled issues are skipped with a warning (override the routing labels if yours differ).
2. **Build the DAG.** `Blocked by` edges are read from each issue body — both `#NN` references and **title references** (e.g. `Blocked by: T2 — Ticket-type labels + routing dispatch`), which are matched to batch tickets by normalised title. A cycle aborts the run.
3. **Walk the frontier.** Tickets with all blockers done launch up to `--concurrency` at a time. Each runs in its own fresh Paseo worktree. When one finishes, its dependents become eligible.
4. **Per implement ticket:** `paseo run` `/implement` (branch-off from the default branch) → fresh `paseo run` `/code-review` against `origin/<default>` → if the verdict is `ISSUES`, a bounded fix-loop (fix agent → re-review) up to `--max-fix-rounds` → `gh pr create` → `gh pr checks --watch` → `gh pr merge` + close the issue.
5. **The review verdict** is the contract between agent and driver. The review prompt asks the agent to end with `REVIEW_VERDICT: CLEAN` or `REVIEW_VERDICT: ISSUES <n>`. An unparseable verdict is retried once, then escalated — the driver **never auto-merges on an unknown verdict**.

## Safety

- **Auto-merge is gated on a clean review AND green CI.** A failing check leaves the PR open for you. `--require-checks` additionally blocks merge when a repo has no CI.
- **A failed ticket cascades** to its not-yet-started dependents (marked failed, not retried), so a doomed branch can't hang the run. Dependents already in flight are left to settle.
- **Resume is idempotent.** State lives at `.scratch/dag-tickets/<run-id>/state.json`. Re-running `--resume <id>` skips merged tickets, restarts in-flight ones, and keeps failed ones failed.
- The driver never edits issue bodies; it only opens PRs, merges, and closes with a linking comment.

## Verify before trusting it

```bash
bun test                 # 34 unit tests: DAG, frontier, cascade, cycles, parsing, args
bun run typecheck        # tsc --noEmit
dag-tickets --dry-run --parent 42   # see the plan before any agent runs
```

## Design notes

- **Hybrid driver.** The script owns the deterministic skeleton (DAG, scheduling, PR, CI, merge). Only the implement↔review iteration is delegated to agents, bounded by `--max-fix-rounds`. No LLM is spent on orchestration itself.
- **Why no Orca orchestration.** The steps are mechanical; a deterministic CLI is debuggable, resumable, and token-free to run. Paseo worktrees give the isolation Orca would.
- **Worktrees persist in Paseo** after each step (named `dag-<n>`), so you can inspect or kill them in the Paseo UI. The driver does not auto-archive — you stay in control of the machines.
