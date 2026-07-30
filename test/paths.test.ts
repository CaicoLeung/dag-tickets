import { test, expect, describe } from "bun:test";
import { resolveUnder } from "../src/paths.ts";

// resolveUnder is the single source of the "prefix a repo-relative path with an
// optional --cwd" dance the 0.2.0 review flagged as Duplicated Code (events /
// state / cli each re-implemented `cwd.replace(/\/$/,"")` + `${cwd}/${rel}`).

describe("resolveUnder", () => {
  test("cwd absent → the relative path unchanged (the default checkout)", () => {
    expect(resolveUnder(".scratch/dag-tickets/r/state.json")).toBe(
      ".scratch/dag-tickets/r/state.json",
    );
  });

  test("cwd present → `${cwd}/${rel}`", () => {
    expect(resolveUnder(".scratch/dag-tickets/r/state.json", "/repo")).toBe(
      "/repo/.scratch/dag-tickets/r/state.json",
    );
  });

  test("trims a trailing slash on cwd so the path never doubles it", () => {
    expect(resolveUnder("x", "/repo/")).toBe("/repo/x");
    expect(resolveUnder("x", "/repo//")).toBe("/repo/x");
  });

  test("relative cwd is respected (not forced absolute)", () => {
    expect(resolveUnder("x", "repo")).toBe("repo/x");
    expect(resolveUnder("x", "repo/")).toBe("repo/x");
  });

  test("empty rel under a cwd still prefixes (edge case, no crash)", () => {
    expect(resolveUnder("", "/repo")).toBe("/repo/");
  });
});
