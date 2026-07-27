import { test, expect } from "bun:test";
import { parseArgs } from "../src/cli.ts";

test("--version / -V set the version flag", () => {
  expect(parseArgs(["--version"]).version).toBe(true);
  expect(parseArgs(["-V"]).version).toBe(true);
});

test("version flag defaults to false", () => {
  expect(parseArgs([]).version).toBe(false);
  expect(parseArgs(["--frontier"]).version).toBe(false);
});

test("unknown argument still throws regardless of version flag", () => {
  expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
});
