import { test, expect, describe } from "bun:test";
import { withLog } from "../src/ports.ts";

// withLog is the single helper that threads an optional logPath onto a result
// object, replacing ~7 inline `...(r.logPath ? { logPath: r.logPath } : {})`
// copies the 0.2.0 review flagged as Duplicated Code. A clean result must OMIT
// the key (not carry it present-as-undefined) so state.json / event payloads
// stay clean.

describe("withLog", () => {
  test("source with a logPath → returns { logPath }", () => {
    expect(withLog({ logPath: "/run/logs/1-implement.log" })).toEqual({
      logPath: "/run/logs/1-implement.log",
    });
  });

  test("source with undefined logPath → returns {} (key omitted, not present-as-undefined)", () => {
    const out = withLog({ logPath: undefined });
    expect(out).toEqual({});
    expect("logPath" in out).toBe(false); // the key is genuinely absent
  });

  test("source with no logPath field → returns {}", () => {
    expect(withLog({})).toEqual({});
  });

  test("spreads cleanly onto a base object (the call-site shape)", () => {
    const r = { ok: false, commits: 0, reason: "failed" as const, ...withLog({ logPath: "/x.log" }) };
    expect(r).toEqual({ ok: false, commits: 0, reason: "failed", logPath: "/x.log" });
    const clean = { ok: true, commits: 3, ...withLog({}) };
    expect(clean).toEqual({ ok: true, commits: 3 });
    expect("logPath" in clean).toBe(false);
  });
});
