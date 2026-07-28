import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireLock,
  isProcessAlive,
  lockPath,
  readLock,
  LockHeldError,
  type LockInfo,
} from "../src/lock.ts";

// Each test gets its own empty cwd so the repo-wide run.lock never leaks
// between tests (or into the real checkout). mkdtemp gives an absolute path,
// which is what acquireLock joins the relative .scratch path under.
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "dag-lock-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Write a lockfile directly (mkdir parent first) to simulate a prior run. */
async function writeLockRaw(dir: string, info: LockInfo): Promise<void> {
  const path = lockPath(dir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(info) + "\n", "utf8");
}

/** Spawn a short-lived child, wait for it to exit, return its (now dead) pid. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "process.exit(0)"],
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid!;
};

describe("lockPath", () => {
  test("relative path when no cwd", () => {
    expect(lockPath()).toBe(".scratch/dag-tickets/run.lock");
  });

  test("joined under cwd, trailing slash tolerated", () => {
    expect(lockPath("/repo")).toBe("/repo/.scratch/dag-tickets/run.lock");
    expect(lockPath("/repo/")).toBe("/repo/.scratch/dag-tickets/run.lock");
  });
});

describe("isProcessAlive", () => {
  test("the current process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("a reaped child pid is dead", async () => {
    expect(isProcessAlive(await deadPid())).toBe(false);
  });

  test("non-positive / invalid pid is treated as dead", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
  });
});

describe("acquireLock", () => {
  test("writes a lockfile with the holder pid and runId", async () => {
    const h = await acquireLock({ cwd, runId: "run-1" });
    expect(h.info.pid).toBe(process.pid);
    expect(h.info.runId).toBe("run-1");
    expect(h.info.startedAt).toBeTruthy();
    expect(h.info.hostname).toBeTruthy();

    const onDisk = await readLock(cwd);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.pid).toBe(process.pid);
    expect(onDisk!.runId).toBe("run-1");
  });

  test("creates the .scratch/dag-tickets/ directory if absent", async () => {
    // cwd is empty — the dir does not exist yet.
    await acquireLock({ cwd });
    const f = Bun.file(lockPath(cwd));
    expect(await f.exists()).toBe(true);
  });

  test("a second acquire while the holder is alive fails fast (serialize)", async () => {
    const first = await acquireLock({ cwd, runId: "first" });
    try {
      await expect(acquireLock({ cwd, runId: "second" })).rejects.toBeInstanceOf(LockHeldError);
      try {
        await acquireLock({ cwd, runId: "second" });
      } catch (e) {
        expect(e).toBeInstanceOf(LockHeldError);
        // Holder info points back at the live run, not the second.
        expect((e as LockHeldError).info.pid).toBe(first.info.pid);
        expect((e as LockHeldError).info.runId).toBe("first");
      }
    } finally {
      await first.release();
    }
  });

  test("error message tells the human another run is active", async () => {
    const first = await acquireLock({ cwd, runId: "first" });
    try {
      await acquireLock({ cwd, runId: "second" });
    } catch (e) {
      expect(e).toBeInstanceOf(LockHeldError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/another.*run.*active/i);
      expect(msg).toContain(String(process.pid));
    } finally {
      await first.release();
    }
  });

  test("recovers a stale lock left by a dead process", async () => {
    // Simulate a killed run: write a lockfile owned by a now-dead pid.
    const stale: LockInfo = {
      pid: await deadPid(),
      runId: "dead-run",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      hostname: "dead-host",
      nonce: "stale",
    };
    await writeLockRaw(cwd, stale);

    // acquireLock should detect the dead holder, reclaim, and succeed.
    const h = await acquireLock({ cwd, runId: "recovered" });
    expect(h.info.pid).toBe(process.pid);
    expect(h.info.runId).toBe("recovered");

    const onDisk = await readLock(cwd);
    expect(onDisk!.pid).toBe(process.pid);
    expect(onDisk!.runId).toBe("recovered");
  });

  test("recovers a corrupt lockfile as if stale", async () => {
    await mkdir(dirname(lockPath(cwd)), { recursive: true });
  await writeFile(lockPath(cwd), "{not json", "utf8");
    const h = await acquireLock({ cwd, runId: "after-corrupt" });
    expect(h.info.pid).toBe(process.pid);
  });

  test("release removes the lock so a subsequent acquire succeeds", async () => {
    const h = await acquireLock({ cwd });
    await h.release();
    // second acquire with no holder present must work again
    const h2 = await acquireLock({ cwd });
    expect(h2.info.pid).toBe(process.pid);
    await h2.release();
  });

  test("release is idempotent", async () => {
    const h = await acquireLock({ cwd });
    await h.release();
    await expect(h.release()).resolves.toBeUndefined();
  });

  test("release does not clobber a lock taken over by a later process", async () => {
    // Our handle, but the on-disk lock now belongs to someone else (e.g. our
    // process died, the lock was recovered, and our stale handle.release fires
    // late). We must NOT delete the new owner's lock.
    const ours = await acquireLock({ cwd });
    const someoneElse: LockInfo = {
      pid: process.pid, // alive
      startedAt: new Date().toISOString(),
      hostname: "other",
      runId: "reborn",
      nonce: "reborn",
    };
    // overwrite the lockfile directly (simulating recovery + re-acquire)
    await writeLockRaw(cwd, someoneElse);
    await ours.release(); // must refuse to unlink (nonce differs)
    const onDisk = await readLock(cwd);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.runId).toBe("reborn");
  });

  test("release guards on nonce, NOT startedAt (same pid + nonce, new startedAt still releases)", async () => {
    // Pins the real invariant: release deletes iff pid + nonce match. A changed
    // startedAt alone must NOT keep us from releasing our own lock.
    const ours = await acquireLock({ cwd });
    // Same pid + same nonce, but a mutated startedAt (e.g. someone rewrote the
    // timestamp) — the lock is still recognisably ours, so release unlinks it.
    const rewritten: LockInfo = { ...ours.info, startedAt: "1970-01-01T00:00:00.000Z" };
    await writeLockRaw(cwd, rewritten);
    await ours.release();
    expect(await readLock(cwd)).toBeNull();
  });
});
