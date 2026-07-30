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
 * 0.2.0 feedback C1: a soft serialisation edge parsed from a `Coordinate with` /
 *  `Conflicts with` block OR a `coordinate:` / `conflict:` label. Unlike
 *  `Blocked by` (a hard dependency), this is a scheduling hint — two tickets
 *  that touch the same code shouldn't run concurrently. Returns just the
 *  `#NN` numbers (titles aren't useful for a soft edge). Handles inline and
 *  section forms in the body, plural and singular, the `Avoid conflicting
 *  edits with` phrasing, AND the label form (`coordinate:464`,
 *  `conflicts:12,15`) the spec called out as "(or label)".
 */
export function parseCoordinateRefs(
  body: string | null | undefined,
  labels: string[] = [],
): number[] {
  const numbers = new Set<number>();
  // Body refs carry `#NN`; label refs (`coordinate:464`) carry bare NN.
  const harvestHashed = (text: string): void => {
    for (const m of text.matchAll(/#(\d+)/g)) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0) numbers.add(n);
    }
  };
  const harvestBare = (text: string): void => {
    for (const m of text.matchAll(/(\d+)/g)) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0) numbers.add(n);
    }
  };
  // Label form: `coordinate:464`, `coordinate-with:464`, `conflicts:12,15`.
  // The prefix is anchored + requires a `:` so a label like
  // `coordinate-with-popover` (no number) can't false-harvest.
  const labelRe = /^(?:coordinate(?:-with)?|conflicts?)\s*:\s*(.+)$/i;
  for (const label of labels ?? []) {
    const m = label.match(labelRe);
    if (m) harvestBare(m[1]!);
  }
  if (body) {
    const lines = body.split(/\r?\n/);
    let inSection = false;
    // Section heading: `## Coordinate with` / `## Conflicts with` / `## Coordination`.
    const sectionRe = /^#{1,6}\s+(coordinate(s)? with|conflicts? with|coordination( notes)?)\s*$/i;
    // Inline: `**Coordinate with:** #464` / `- Conflicts with: #12, #15`.
    const inlineRe = /^\s*(?:[-*]\s+)?\*{0,2}\s*(coordinate(s)? with|conflicts? with|avoid conflicting edits with)\*{0,2}\s*:?\s*(.*)$/i;
    for (const line of lines) {
      if (sectionRe.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection && /^#{1,6}\s/.test(line)) inSection = false;
      if (inSection) {
        harvestHashed(line.replace(/^\s*[-*]\s*/, ""));
      } else if (inlineRe.test(line)) {
        // The #NN refs sit after the marker; harvesting the whole line is safe —
        // the marker phrase itself contains no #NN.
        harvestHashed(line);
      }
    }
  }
  return [...numbers].sort((a, b) => a - b);
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

  // A matched verdict: the word (CLEAN/ISSUES), optional count, and the end
  // index of the match in `tail` (for slicing the findings body the fixer reads).
  let word: string | null = null;
  let count: string | undefined;
  let endIndex = 0;

  // Tier 1: line-anchored match — the agent's standalone verdict line. Take the
  // LAST (the agent sometimes deliberates mid-output before the final).
  const re = /^\s*REVIEW_VERDICT:\s*(CLEAN|ISSUES)\b(?:\s+(\d+))?/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    word = m[1]!;
    count = m[2];
    endIndex = m.index + m[0].length;
  }

  // Tier 2: the agent often ends mid-deliberation, embedding the verdict token
  // in its closing prose ("...formats. REVIEW_VERDICT: ISSUES 1.") instead of a
  // standalone line. Search only the last 2KB — the agent's closing output. The
  // [User] prompt (which echoes REVIEW_VERDICT in backticked instructions) sits
  // at the top of the log and is excluded by this window.
  if (!word) {
    const win = tail.slice(-2000);
    const offset = tail.length - win.length;
    const re2 = /REVIEW_VERDICT[:]?\s*[`*]*\s*(CLEAN|ISSUES)\b(?:\s+(\d+))?/gi;
    while ((m = re2.exec(win)) !== null) {
      word = m[1]!;
      count = m[2];
      endIndex = m.index + m[0].length + offset;
    }
  }

  if (!word) {
    return { kind: "unknown", issueCount: 0, raw: tail.slice(-800) };
  }
  const w = word.toUpperCase();
  const raw = tail.slice(0, endIndex).slice(-4000);
  if (w === "CLEAN") return { kind: "clean", issueCount: 0, raw };
  const n = count ? parseInt(count, 10) : 1;
  return { kind: "issues", issueCount: Number.isFinite(n) ? n : 1, raw };
}
