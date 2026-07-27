import { test, expect, describe } from "bun:test";
import { parseBlockedByRefs, parseReviewVerdict } from "../src/parse.ts";

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
