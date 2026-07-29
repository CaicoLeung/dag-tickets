# Triage Labels

The mattpocock/skills triage model speaks in terms of **seven** canonical roles —
two **category** roles and five **state** roles. This file maps those roles to
the actual label strings used in this repo's issue tracker.

Every triaged issue should carry exactly one category role and one state role.

## Category roles (what kind of work)

| Role in mattpocock/skills | Label in our tracker | Meaning                    |
| ------------------------- | -------------------- | -------------------------- |
| `bug`                     | `bug`                | Something is broken        |
| `enhancement`             | `enhancement`        | New feature or improvement |

Category roles are descriptive — they never trigger routing on their own.

## State roles (where in the triage state machine)

| Role in mattpocock/skills | Label in our tracker | Meaning                                  |
| ------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`            | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`              | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`         | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`         | `ready-for-human`    | Requires human implementation            |
| `wontfix`                 | `wontfix`            | Will not be actioned                     |

## How `dag-tickets` routes them

The driver routes on the **state** role. Any list is flag-overridable
(`--impl-label` / `--triage-label` / `--research-label` / `--category-label` /
`--skip-label`, the last two repeatable / comma-separated):

- `ready-for-agent` → `/implement` (PR + merge)
- `needs-triage` → `/triage` (single-shot, no PR)
- research labels → `/research` (single-shot, writes a markdown asset)
- **Orphan** — an issue with a category role but *no* state role (e.g. `[bug]`
  alone) → `/triage`. This extends the canonical "unlabeled → needs-triage" rule
  to category-labeled-but-stateless issues (ADR-0001).
- `needs-info` / `ready-for-human` / `wontfix` → **intentional skip**: not for a
  batch agent, left for a human / interactive `/triage`. The `needs-info` →
  re-triage loop on a reporter reply stays manual — judging a substantive reply
  is an interactive call.

## Write boundary for unattended `/triage`

When the driver runs `/triage` unattended (no maintainer in the loop), the agent
is fenced at the write boundary: it may apply non-destructive transitions
(`needs-info`, `ready-for-agent`) and post comments/briefs, but it **must not
close an issue or apply `wontfix`** — those are irreversible and need a human
(ADR-0001).

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding label string from the tables above. Edit the right-hand columns to
match whatever vocabulary you actually use.
