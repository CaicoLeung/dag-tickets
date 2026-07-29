/**
 * Subprocess smoke test for the bin wrapper.
 *
 * The in-process main() tests cover everything from parseArgs onward; this
 * file covers the one thing they can't — the `bin/dag-tickets.ts` entry point
 * itself (the unhandled-rejection handlers + `process.exit(code)` wiring) — by
 * spawning the real binary as a child process.
 */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "..", "bin", "dag-tickets.ts");
const REPO_ROOT = join(__dirname, "..", "..");

function runBin(args: string[]): { code: number; stdout: string; stderr: string } {
  // process.execPath is the bun binary running these tests; reusing it avoids
  // depending on `bun` being on the child's PATH.
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("bin: --version prints the package version and exits 0", () => {
  const { code, stdout } = runBin(["--version"]);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe(`dag-tickets ${pkg.version}`);
});

test("bin: --help prints usage and exits 0", () => {
  const { code, stdout } = runBin(["--help"]);
  expect(code).toBe(0);
  expect(stdout).toContain("USAGE");
  expect(stdout).toContain("--concurrency");
});

test("bin: unknown argument exits 2 with a usage error", () => {
  const { code, stderr } = runBin(["--totally-bogus"]);
  expect(code).toBe(2);
  expect(stderr).toContain("unknown argument");
});
