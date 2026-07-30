import { test, expect, describe } from "bun:test";
import { parseBlockedByRefs, parseCoordinateRefs, parseReviewVerdict } from "../src/parse.ts";

const nums = (body: string | null | undefined) => parseBlockedByRefs(body).numbers;
const titles = (body: string | null | undefined) => parseBlockedByRefs(body).titleRefs;

test("inline bold with hash refs", () => {
  expect(nums("**Blocked by:** #12, #15")).toEqual([12, 15]);
});

test("list item form", () => {
  expect(nums("- Blocked by: #7 and #9")).toEqual([7, 9]);
});

test("explicit none variants", () => {
  expect(nums("**Blocked by:** None — can start immediately")).toEqual([]);
  expect(nums("Blocked by: N/A")).toEqual([]);
  expect(nums("Blocked by: no dependencies")).toEqual([]);
});

test("heading section with bullets", () => {
  const body = ["Some intro", "", "## Blocked by", "- #3", "- #4", "", "## Acceptance", "- foo"].join("\n");
  expect(nums(body)).toEqual([3, 4]);
});

test("heading section ends at next heading", () => {
  const body = ["## Blocked by", "- #1", "## Something else", "- #99"].join("\n");
  expect(nums(body)).toEqual([1]);
});

test("dedupes and sorts", () => {
  expect(nums("Blocked by: #5, #5, #2")).toEqual([2, 5]);
});

test("ignores bare numbers without hash", () => {
  expect(nums("Blocked by: see ticket 42")).toEqual([]);
});

test("empty / null body", () => {
  expect(nums("")).toEqual([]);
  expect(nums(null)).toEqual([]);
  expect(nums(undefined)).toEqual([]);
});

describe("title references", () => {
  test("extracts title refs the user actually writes", () => {
    const body = "## Blocked by\n- T2 — Ticket-type labels + routing dispatch\n- T3 — review-verdict enforcement";
    expect(titles(body)).toEqual([
      "T2 — Ticket-type labels + routing dispatch",
      "T3 — review-verdict enforcement",
    ]);
  });

  test("mixed #NN and title on one inline line", () => {
    const { numbers, titleRefs } = parseBlockedByRefs("Blocked by: #25, T2 — routing dispatch");
    expect(numbers).toEqual([25]);
    expect(titleRefs).toEqual(["T2 — routing dispatch"]);
  });

  test("none-suppressed lines yield no title refs", () => {
    expect(titles("Blocked by: None — can start immediately")).toEqual([]);
  });
});

test("parseReviewVerdict: clean", () => {
  const v = parseReviewVerdict("...report...\nREVIEW_VERDICT: CLEAN");
  expect(v.kind).toBe("clean");
  expect(v.issueCount).toBe(0);
});

test("parseReviewVerdict: issues with count", () => {
  const v = parseReviewVerdict("found stuff\nREVIEW_VERDICT: ISSUES 3");
  expect(v.kind).toBe("issues");
  expect(v.issueCount).toBe(3);
});

test("parseReviewVerdict: issues without count defaults to 1", () => {
  const v = parseReviewVerdict("REVIEW_VERDICT: ISSUES");
  expect(v.kind).toBe("issues");
  expect(v.issueCount).toBe(1);
});

test("parseReviewVerdict: missing verdict is unknown (never auto-merge)", () => {
  const v = parseReviewVerdict("the agent just rambled with no verdict line");
  expect(v.kind).toBe("unknown");
});

test("parseReviewVerdict: last verdict wins when reasoning quotes the token", () => {
  const text = [
    "I'll emit REVIEW_VERDICT: ISSUES 4.",
    "",
    "## Standards",
    "found stuff",
    "REVIEW_VERDICT: ISSUES 4",
  ].join("\n");
  const v = parseReviewVerdict(text);
  expect(v.kind).toBe("issues");
  expect(v.issueCount).toBe(4);
});

test("parseReviewVerdict: a leaked prompt instruction does not override the real verdict", () => {
  // Simulates [User]-stripping having missed a prompt line: the prompt's CLEAN
  // instruction appears first, but the agent's own ISSUES verdict is last.
  const text = [
    "Emit one of: REVIEW_VERDICT: CLEAN  or  REVIEW_VERDICT: ISSUES <n>",
    "the agent did the review",
    "REVIEW_VERDICT: ISSUES 2",
  ].join("\n");
  const v = parseReviewVerdict(text);
  expect(v.kind).toBe("issues");
  expect(v.issueCount).toBe(2);
});

test("parseReviewVerdict: line-anchored — ignores backticked prompt examples and mid-sentence reasoning", () => {
  // Mirrors real `paseo logs --filter text`: prompt bullets in backticks, the
  // agent's verdict as a standalone line, plus reasoning quoting the token
  // mid-sentence. Only the standalone line should match.
  const text = [
    "[User] You are reviewing...",
    "## Verdict (required)",
    "- `REVIEW_VERDICT: CLEAN`           — no actionable findings",
    "- `REVIEW_VERDICT: ISSUES <n>`      — n actionable findings remain",
    "## Standards",
    "found the ADR miscite",
    "REVIEW_VERDICT: ISSUES 3",
    "Actually simplest: Verdict: REVIEW_VERDICT: ISSUES 3. Now write report.",
  ].join("\n");
  const v = parseReviewVerdict(text);
  expect(v.kind).toBe("issues");
  expect(v.issueCount).toBe(3);
});

test("parseReviewVerdict: raw carries the findings body, not post-verdict deliberation", () => {
  // The agent emits findings + verdict, then keeps "thinking" (vote-counting).
  // The fixer needs the findings, not the deliberation tail.
  const text = [
    "## Standards",
    "HARD: ADR-0029 citation wrong at study-word-tap.ts:32.",
    "## Spec",
    "Missing { passive: false } on the click listener (latent preventDefault no-op).",
    "REVIEW_VERDICT: ISSUES 2",
    "[Thought] hmm, is it 2 or 3? Let me recount. I'll go with 2. Now write report.",
  ].join("\n");
  const v = parseReviewVerdict(text);
  expect(v.kind).toBe("issues");
  expect(v.issueCount).toBe(2);
  expect(v.raw).toContain("ADR-0029");
  expect(v.raw).toContain("passive: false");
  expect(v.raw).not.toContain("Let me recount");
});

test("parseReviewVerdict: tier-2 catches verdict embedded in closing prose (real field case)", () => {
  // The agent ended mid-deliberation — the verdict token sits in its final
  // sentence, not on a standalone line. This is the exact output from the
  // fix-round review that returned 'unknown' before the tail-search fallback.
  const text = [
    "## Standards",
    "resolveStudyWordTap speculative export — candidate to cut.",
    "## Spec",
    "Spec axis clean.",
    "Final verdict line must be exactly one of the two formats. REVIEW_VERDICT: ISSUES 1.",
  ].join("\n");
  const v = parseReviewVerdict(text);
  expect(v.kind).toBe("issues");
  expect(v.issueCount).toBe(1);
});

test("parseReviewVerdict: tier-2 catches verdict in markdown bold", () => {
  const v = parseReviewVerdict("Report done.\n**REVIEW_VERDICT: CLEAN**");
  expect(v.kind).toBe("clean");
});

test("parseReviewVerdict: tier-2 window excludes the [User] prompt", () => {
  // The prompt's REVIEW_VERDICT instructions sit at the top. When the agent's
  // own closing output has no verdict, tier-2 must NOT fall back to the prompt.
  const longFiller = "x".repeat(2500);
  const text = [
    "[User] You are reviewing...",
    "- `REVIEW_VERDICT: CLEAN` — no findings",
    longFiller,
    "The agent reviewed but forgot to emit a verdict line.",
  ].join("\n");
  const v = parseReviewVerdict(text);
  expect(v.kind).toBe("unknown");
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback C1 — parseCoordinateRefs: soft serialisation peers from a
// `Coordinate with` / `Conflicts with` block (inline or section). NOT a
// dependency — both tickets run, just not concurrently.
// ---------------------------------------------------------------------------
describe("parseCoordinateRefs (C1)", () => {
  test("inline '**Coordinate with:** #464'", () => {
    expect(parseCoordinateRefs("**Coordinate with:** #464")).toEqual([464]);
  });

  test("inline plural + multiple refs", () => {
    expect(parseCoordinateRefs("- Conflicts with: #12, #15 and #18")).toEqual([12, 15, 18]);
  });

  test("section form with bullets", () => {
    const body = "## Coordinate with\n- #464 (Popover attach code)\n- avoid landing the same day as #470\n";
    expect(parseCoordinateRefs(body)).toEqual([464, 470]);
  });

  test("'Avoid conflicting edits with' phrasing", () => {
    expect(parseCoordinateRefs("Avoid conflicting edits with #51.")).toEqual([51]);
  });

  test("out-of-section heading terminates the harvest", () => {
    const body = "## Coordinate with\n- #5\n## Notes\n- #6 here\n";
    expect(parseCoordinateRefs(body)).toEqual([5]);
  });

  test("no marker → empty", () => {
    expect(parseCoordinateRefs("Blocked by: #12\nRandom #99 mention")).toEqual([]);
  });

  test("null/empty body → empty", () => {
    expect(parseCoordinateRefs(null)).toEqual([]);
    expect(parseCoordinateRefs("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 0.2.0 feedback C1 (the "or label" half the body-only parser dropped): a
// `coordinate:464` / `conflicts:12,15` label is also a soft serialisation edge.
// The spec said "(or label)"; these pin the label harvest.
// ---------------------------------------------------------------------------
describe("parseCoordinateRefs — label form (C1)", () => {
  test("a `coordinate:464` label yields 464 (no body needed)", () => {
    expect(parseCoordinateRefs(null, ["coordinate:464"])).toEqual([464]);
    expect(parseCoordinateRefs("", ["coordinate:464"])).toEqual([464]);
  });

  test("`conflicts:12,15` yields both, sorted", () => {
    expect(parseCoordinateRefs(null, ["conflicts:12,15"])).toEqual([12, 15]);
  });

  test("`coordinate-with:464` (hyphenated) is accepted", () => {
    expect(parseCoordinateRefs(null, ["coordinate-with:464"])).toEqual([464]);
  });

  test("label + body refs merge + dedupe", () => {
    expect(parseCoordinateRefs("Coordinate with #464", ["conflicts:470"])).toEqual([464, 470]);
  });

  test("a label with no number after the prefix harvests nothing", () => {
    expect(parseCoordinateRefs(null, ["coordinate-with-popover"])).toEqual([]);
  });

  test("a bare `coordinate` label (no colon) is NOT treated as a soft edge", () => {
    expect(parseCoordinateRefs(null, ["coordinate"])).toEqual([]);
  });

  test("label case-insensitive prefix", () => {
    expect(parseCoordinateRefs(null, ["Coordinate: 51"])).toEqual([51]);
  });
});
