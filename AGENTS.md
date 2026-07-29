# AGENTS.md

Operating rules for any agent (or human) making changes in this repository.

## Commits MUST go through `aic` (hard requirement)

**Every commit in this repo must be produced by the [`aic`](https://github.com/CaicoLeung/aic) CLI. Hand-written commit messages are not allowed.**

Process:

1. Stage exactly the files that belong in one logical change: `git add <paths>` (or `git add -p`).
2. Run `aic`. It diffs the staged changes, generates a Conventional Commits message, and creates the commit for you.
3. With nothing staged, `aic` instead batches all unstaged changes into logical commits automatically — prefer explicit staging so you control commit boundaries.

Rules:

- Never run `git commit -m`, `git commit -F`, or otherwise bypass `aic`.
- If `aic` is missing, misconfigured, or errors out, **stop and fix the tooling** — do not fall back to a manual commit. Run `aic setup` to configure the provider/model, or `aic list` to inspect the resolved config.
- One logical change per commit; let `aic` shape the message.

This is non-negotiable and applies to every contributor and agent.

## Project basics

- **Runtime:** Bun ≥ 1.1, TypeScript (`"type": "module"`).
- **Typecheck:** `bun run typecheck` (`tsc --noEmit`).
- **Tests:** `bun test`.
- **Entry:** `bin/dag-tickets.ts` → `src/cli.ts`.

## Agent skills

### Issue tracker

Issues for this repo live as GitHub issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Seven canonical triage roles — two **category** (`bug`, `enhancement`) and five
**state** (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
