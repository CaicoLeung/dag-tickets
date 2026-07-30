/**
 * Repo-relative path resolution under an optional `--cwd` checkout.
 *
 * The run's state (`state.json`), event stream (`events.jsonl`), and per-step
 * agent logs (`logs/`) all live under `.scratch/dag-tickets/<run-id>/`. With
 * `--cwd <path>` the same paths must resolve against that checkout. This is the
 * single place that trims a trailing slash and prefixes the cwd — previously
 * `events.ts` / `state.ts` / `cli.ts` each re-implemented the
 * `cwd.replace(/\/$/,"")` + `${cwd}/${rel}` dance (the Duplicated-Code smell the
 * 0.2.0 review flagged). One helper, one source of truth.
 */

/** Resolve a repo-relative path against an optional checkout `cwd`.
 *
 *  - `cwd` absent → the relative path as-is (the default checkout).
 *  - `cwd` present → `${cwd-trimmed}/${rel}`.
 *
 *  A trailing slash on `cwd` is trimmed so `${cwd}/.scratch/...` never produces
 *  a doubled separator. Pure; no filesystem access. */
export function resolveUnder(rel: string, cwd?: string): string {
  return cwd ? `${cwd.replace(/\/+$/, "")}/${rel}` : rel;
}
