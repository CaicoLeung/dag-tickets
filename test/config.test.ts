import { test, expect, describe } from "bun:test";
import { resolveKind, DEFAULT_ROUTING } from "../src/config.ts";

/** resolveKind encodes the seven-role triage model (ADR-0001): route on state,
 *  rescue orphans (category present, no state) -> triage, and intentionally
 *  skip the non-batch states. These pin every branch of that decision. */
describe("resolveKind — seven-role routing (ADR-0001)", () => {
  const k = (labels: string[]) => resolveKind(labels, DEFAULT_ROUTING);

  test("state triggers route to their skill", () => {
    expect(k(["ready-for-agent"])).toBe("implement");
    expect(k(["needs-triage"])).toBe("triage");
    expect(k(["research"])).toBe("research");
  });

  test("orphan: a category role with no state role is triaged", () => {
    expect(k(["bug"])).toBe("triage");
    // bug and enhancement are both category roles, so both are orphans when
    // they appear without a state role.
    expect(k(["enhancement"])).toBe("triage");
  });

  test("a category role never overrides an explicit state", () => {
    expect(k(["bug", "ready-for-agent"])).toBe("implement");
    expect(k(["enhancement", "needs-triage"])).toBe("triage");
  });

  test("non-batch states settle as an intentional skip", () => {
    expect(k(["needs-info"])).toBe("skip");
    expect(k(["ready-for-human"])).toBe("skip");
    expect(k(["wontfix"])).toBe("skip");
  });

  test("category + needs-info is NOT re-triaged (needs-info stays manual)", () => {
    expect(k(["bug", "needs-info"])).toBe("skip");
    expect(k(["bug", "wontfix"])).toBe("skip");
  });

  test("truly unlabeled falls through to unknown (the CLI does not hunt unlabeled)", () => {
    expect(k([])).toBe("unknown");
    expect(k(["some-custom-label"])).toBe("unknown");
  });
});
