import type { ReviewVerdict } from "./types.ts";

/**
 * Pure parsing helpers — no I/O. Unit-tested.
 *
 * Two concerns:
 *  1. `Blocked by` edges — the `to-tickets` skill writes them inline
 *     (`**Blocked by:** #12, #15`) or as a `## Blocked by` section with
 *     bullets. Blockers may be `#NN` references OR title references (e.g.
 *     "T2 — Ticket-type labels + routing dispatch"); we extract both, and the
 *     graph layer resolves titles to numbers within the batch.
 *  2. Review verdicts — the code-review agent is prompted to end its output
 *     with a machine-parseable line so the driver can branch the fix-loop.
 */

const NONE_RE = /\b(none|n\/a|nothing|can start immediately|no dependencies?)\b/i;

export interface BlockedByRefs {
  numbers: number[];
  /** Raw textual references (titles or prose) that couldn't be parsed as #NN. */
  titleRefs: string[];
}

/**
 * Extract every reference under a `Blocked by` marker — both `#NN` numbers and
 * free-text title references. Handles inline and section forms.
 */
export function parseBlockedByRefs(body: string | null | undefined): BlockedByRefs {
  if (!body) return { numbers: [], titleRefs: [] };
  const lines = body.split(/\r?\n/);
  const numbers = new Set<number>();
  const titleRefs: string[] = [];

  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+blocked\s+by\s*$/i);
    if (heading) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s/.test(line)) inSection = false;

    const inline = line.match(/^\s*(?:[-*]\s+)?\*{0,2}\s*blocked\s+by\*{0,2}\s*:?\s*(.*)$/i);

    if (inSection) {
      const text = line.replace(/^\s*[-*]\s*/, "");
      absorb(text, numbers, titleRefs);
    } else if (inline) {
      const rest = inline[1] ?? "";
      if (NONE_RE.test(rest)) continue;
      absorb(rest, numbers, titleRefs);
    }
  }

  return {
    numbers: [...numbers].sort((a, b) => a - b),
    titleRefs: dedup(titleRefs),
  };
}

function absorb(text: string, numbers: Set<number>, titleRefs: string[]): void {
  for (const m of text.matchAll(/#(\d+)/g)) {
    const n = parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > 0) numbers.add(n);
  }
  // Drop the #NN tokens, then split the remainder on commas / "and" — each
  // non-empty, non-"none" piece is a title reference.
  const deNumd = text.replace(/#\d+/g, " ");
  for (const part of deNumd.split(/[,;]|\band\b/i)) {
    const t = part.trim().replace(/^[-*.:]\s*/, "").replace(/[.,;:\s]+$/, "").trim();
    if (!t || NONE_RE.test(t)) continue;
    titleRefs.push(t);
  }
}

function dedup(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/**
 * Parse the code-review agent's verdict line.
 *
 * The review prompt instructs the agent to emit, as its final non-empty line:
 *   REVIEW_VERDICT: CLEAN
 *   REVIEW_VERDICT: ISSUES 3
 *
 * The regex is line-anchored (`^\\s*REVIEW_VERDICT:`) so it matches ONLY the
 * agent's standalone verdict line. The review prompt echoes the tokens inside
 * backticked list items (`` - `REVIEW_VERDICT: CLEAN` ``) and the agent's own
 * reasoning often quotes the token mid-sentence ("I'll emit REVIEW_VERDICT:
 * ISSUES 4"); neither sits at line-start, so neither can false-match. We take
 * the LAST line-anchored match. No match at all → `unknown`, so the driver
 * escalates rather than silently auto-merging.
 *
 * `raw` is the review body the fixer acts on. It is the text UP TO AND
 * INCLUDING the verdict line — i.e. the findings report — not the whole tail:
 * the agent often emits its findings + verdict, then keeps "thinking"
 * (vote-counting, meta-reasoning) which is useless to the fixer. Slicing the
 * last N chars of the whole tail handed the fixer that deliberation instead of
 * the findings, so fix rounds couldn't converge.
 */
export function parseReviewVerdict(output: string): ReviewVerdict {
  const tail = (output ?? "").trim();
  const re = /^\s*REVIEW_VERDICT:\s*(CLEAN|ISSUES)\b(?:\s+(\d+))?/gim;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(tail)) !== null) last = m;
  if (!last) {
    return { kind: "unknown", issueCount: 0, raw: tail.slice(-800) };
  }
  const word = last[1]!.toUpperCase();
  const findingsBody = tail.slice(0, last.index + last[0].length);
  const raw = findingsBody.slice(-4000);
  if (word === "CLEAN") return { kind: "clean", issueCount: 0, raw };
  const count = last[2] ? parseInt(last[2], 10) : 1;
  return { kind: "issues", issueCount: Number.isFinite(count) ? count : 1, raw };
}
