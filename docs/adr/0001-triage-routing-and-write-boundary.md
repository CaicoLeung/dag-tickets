# Triage routing keys on state (and stateless category); unattended writes stop short of close/wontfix

**Status**: proposed

The CLI dispatches issues to skills by label. mattpocock/skills defines seven
triage roles — two **category** (`bug`, `enhancement`) and five **state**
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`),
with the rule "exactly one category + one state." Triage is triggered by the
`needs-triage` *state*, and the `/triage` skill itself is interactive
("wait for direction", "ask before proceeding").

We decide two things:

1. **Route on state, not category.** `ready-for-agent` → `/implement`;
   `needs-triage` → `/triage`. A category role present with *no* state role
   (an orphan, e.g. `[bug]` alone) is treated as `needs-triage`-equivalent and
   routed to `/triage` — the canonical "unlabeled → needs-triage" rule extended
   to category-labeled-but-stateless. Category is never a trigger on its own, so
   `[bug, ready-for-agent]` still routes to `/implement` and `[bug, needs-info]`
   is not re-triaged.

2. **Unattended `/triage` stops at the write boundary.** The agent may apply
   non-destructive transitions (`needs-info`, `ready-for-agent`) and post
   briefs/comments, but **must not close an issue or apply `wontfix`** — those
   are irreversible and require a human.

## Considered options

- **Category as trigger** (add `bug`/`enhancement` to `triageLabels`). Rejected:
  it would re-triage `[bug, needs-info]` (waiting on the reporter) and deviate
  from the two-axis model.
- **Fix the workflow only, don't touch the CLI** (require every issue to carry a
  state label at filing time). Rejected: the tracker already shows the
  discipline breaks — four open `[bug]`-only issues (#41–#44) sat unrouted.
  Relying on filing discipline leaves the CLI fragile to the observed reality.
- **Fully autonomous triage** (let the unattended agent close / wontfix).
  Rejected: contradicts the skill's "ask before proceeding" and risks silently
  closing a real bug with no human check.

## Consequences

- The CLI gains a "state role set" so it can detect "category present, no state"
  and intentional skips. This set is flag-overridable like the existing
  `--impl-label` / `--triage-label` lists.
- The `needs-info` → `needs-triage` re-triage loop (reporter replies) stays
  manual / interactive — judging whether a reply is substantive is not
  automatable reliably.
- `ready-for-human` and `wontfix` (open) become *intentional* skips with a clear
  signal, not the misleading `unknown-kind` warning.
