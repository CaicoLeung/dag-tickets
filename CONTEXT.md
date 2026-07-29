# dag-tickets — issue triage domain

`dag-tickets` is an AFK batch driver that dispatches GitHub issues to
[mattpocock/skills](https://github.com/mattpocock/skills) skills (`/implement`,
`/triage`, `/research`) based on their labels. This glossary pins the triage
vocabulary the routing logic speaks in.

## Language

**Category role**:
One of two labels that classifies *what kind* of work an issue is — `bug` (something is broken) or `enhancement` (new feature or improvement). Purely descriptive; never a routing trigger on its own.
_Avoid_: type, kind label

**State role**:
One of five labels that says *where the issue is in the triage state machine* — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. The state role is what the CLI routes on.
_Avoid_: status, triage label (ambiguous — see below)

**Triage label** (ambiguous):
In `config.ts` this means specifically the `needs-triage` state — the trigger for `/triage`. In `triage-labels.md` it loosely means any triage role. Prefer the precise **state role** / **category role** terms and reserve "triage label" for the `needs-triage` trigger.

**Orphan**:
An open issue that carries a category role but no state role (e.g. `[bug]` with no state). Per the canonical model these are the same bucket as unlabeled issues and should be triaged. Until the routing fix lands they fall through to `unknown` and are skipped.

**Routing**:
The CLI's label → skill dispatch: `ready-for-agent` → `/implement`, `needs-triage` (+ orphans) → `/triage`, research labels → `/research`. Batch and unattended — distinct from `/triage` the skill, which is interactive and maintainer-in-the-loop.

**Write boundary**:
The line an unattended `/triage` dispatch may not cross: it may apply *non-destructive* transitions (`needs-info`, `ready-for-agent`) and post briefs/comments, but it must not close an issue or apply `wontfix` — those are destructive and require a human.
