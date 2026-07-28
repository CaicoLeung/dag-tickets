import { mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Repo-wide cross-run lock.
 *
 * Two `dag-tickets` runs on the same checkout would fight over the shared
 * `dag-<n>` Paseo worktree slugs (see {@link PaseoAgent}) and the `loop/<n>`
 * branches, so the second run must fail fast instead of corrupting worktrees.
 * This module owns that contract with a single lockfile under
 * `.scratch/dag-tickets/run.lock`:
 *
 *  - **Acquire** is an atomic *create* (`O_EXCL|O_CREAT`, the `wx` flag): the
 *    file's existence is the lock, so only one process can create it. If it
 *    exists we inspect the holder: a *live* pid ⇒ fail fast with a clear
 *    message; a *dead* pid ⇒ the prior run died without releasing, so we
 *    reclaim the stale lock and proceed. A present-but-unparseable file is
 *    either another run mid-write (its create already won, so it will become
 *    readable shortly) or a crashed write — we back off briefly before
 *    treating it as stale, so we never clobber a legitimate writer.
 *  - **Release** is idempotent and only unlinks the lock if it is still ours
 *    (pid + nonce match), so a late release after the lock was recovered
 *    and re-acquired by a later run can't clobber the new owner.
 *
 * Stale recovery is best-effort over pid liveness (`process.kill(pid, 0)`):
 * pid reuse by an unrelated process is the accepted residual risk.
 */

/** What we persist on disk so a holder can be identified and liveness-checked. */
export interface LockInfo {
  /** OS pid of the holding process. */
  pid: number;
  /** Parent pid, for diagnostics when the holder is an agent subprocess. */
  ppid?: number;
  /** dag-tickets run-id, if known. */
  runId?: string;
  /** ISO timestamp the lock was taken. */
  startedAt: string;
  /** Hostname, so a lock left on one host is legible on another. */
  hostname: string;
  /** Head of argv, for human-readable diagnostics. */
  argv?: string[];
  /** Per-acquisition UUID; lets release prove the on-disk lock is still ours. */
  nonce: string;
}

/** Raised when a live holder already owns the lock. `.info` describes it. */
export class LockHeldError extends Error {
  constructor(public readonly info: LockInfo) {
    super(formatHolder(info));
    this.name = "LockHeldError";
  }
}

/** Owned lock: call `release()` from a `finally` and a SIGINT/SIGTERM handler. */
export interface LockHandle {
  info: LockInfo;
  /** Idempotent. Only unlinks the lock if it is still ours. Never throws. */
  release(): Promise<void>;
}

/** `.scratch/dag-tickets/run.lock`, joined under `cwd` when given. */
export function lockPath(cwd?: string): string {
  const rel = ".scratch/dag-tickets/run.lock";
  return cwd ? join(cwd.replace(/\/$/, ""), rel) : rel;
}

/**
 * Is `pid` a live process? Signal 0 is a liveness probe: success ⇒ alive;
 * EPERM ⇒ exists but we can't signal it ⇒ still alive; ESRCH ⇒ gone.
 * Non-positive / non-finite pids are treated as dead (invalid holder).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the current holder, or null if absent / corrupt. */
export async function readLock(cwd?: string): Promise<LockInfo | null> {
  const s = await inspectLock(cwd);
  return s.present ? s.info : null;
}

type LockState = { present: false } | { present: true; info: LockInfo | null };

/**
 * Distinguish "no lockfile" from "lockfile present but unparseable". The
 * latter is either a write in progress (another acquirer just created it) or a
 * crashed/corrupt write — the acquire loop treats the two differently.
 */
async function inspectLock(cwd?: string): Promise<LockState> {
  const f = Bun.file(lockPath(cwd));
  if (!(await f.exists())) return { present: false };
  try {
    return { present: true, info: (await f.json()) as LockInfo };
  } catch {
    return { present: true, info: null };
  }
}

const MAX_ATTEMPTS = 8;
/** Backoff rounds while a present-but-unparseable lock may be mid-write. */
const CORRUPT_BACKOFFS = 4;
const CORRUPT_DELAY_MS = 3;

/**
 * Atomically take the repo-wide lock. Throws {@link LockHeldError} if a live
 * holder already owns it (fail fast). Recovers a stale lock (dead/corrupt
 * holder) transparently. Bounded retries guard against a pathological race
 * where two recoverers keep trading the lock.
 */
export async function acquireLock(opts: { cwd?: string; runId?: string } = {}): Promise<LockHandle> {
  const path = lockPath(opts.cwd);
  await mkdir(dirname(path), { recursive: true });

  const info: LockInfo = {
    pid: process.pid,
    ppid: process.ppid,
    runId: opts.runId,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    argv: process.argv.slice(0, 6),
    nonce: randomUUID(),
  };
  const payload = JSON.stringify(info, null, 2) + "\n";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Atomic EXCLUSIVE creation. The file's existence is the lock; only one
    // process can create it. The payload write that follows is not atomic
    // against a racing reader, so a concurrent acquirer may see the file exist
    // but fail to parse it — handled below as "write in progress".
    try {
      await writeFile(path, payload, { flag: "wx" });
      return makeHandle(path, info, opts.cwd);
    } catch (e) {
      // Anything other than "already exists" is unexpected — surface it.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    const state = await inspectLock(opts.cwd);
    if (!state.present) continue; // a racing recoverer removed it — retry wx

    if (state.info) {
      // A readable holder: live ⇒ fail fast (serialize); dead ⇒ stale, reclaim.
      if (isProcessAlive(state.info.pid)) throw new LockHeldError(state.info);
      await safeUnlink(path);
      continue;
    }

    // Present but unparseable: another run may be mid-write (its wx already
    // won, so ours keeps failing EEXIST) or the write crashed. Back off a few
    // times before reclaiming, so we never clobber a legitimate writer. If the
    // holder becomes readable+alive during the wait, waitForReadableHolder
    // throws LockHeldError itself.
    await waitForReadableHolder(opts.cwd, CORRUPT_BACKOFFS, CORRUPT_DELAY_MS);
    await safeUnlink(path);
  }

  // Couldn't settle inside the loop (e.g. a live holder kept appearing) —
  // report the last known holder rather than silently proceeding.
  const state = await inspectLock(opts.cwd);
  const finalHolder = state.present ? state.info : null;
  throw new LockHeldError(
    finalHolder ?? { pid: 0, startedAt: new Date().toISOString(), hostname: hostname(), nonce: "unknown" },
  );
}

/** Unlink, swallowing a "already gone" from a racing recoverer. */
async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* a racing recoverer already removed it; the next wx attempt settles it */
  }
}

/**
 * Poll a present-but-unparseable lock for a few rounds. Returns once the holder
 * is readable (dead) or absent — leaving the caller to reclaim it — or throws
 * {@link LockHeldError} if it becomes readable and alive. Stays silent if it
 * stays unparseable (caller treats that as stale-corrupt).
 */
async function waitForReadableHolder(
  cwd: string | undefined,
  rounds: number,
  ms: number,
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setTimeout(r, ms));
    const s = await inspectLock(cwd);
    if (!s.present) return; // disappeared — caller's wx will win
    if (s.info) {
      if (isProcessAlive(s.info.pid)) throw new LockHeldError(s.info);
      return; // readable + dead → caller reclaims
    }
  }
}

function makeHandle(path: string, info: LockInfo, cwd?: string): LockHandle {
  let released = false;
  return {
    info,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Only remove the lock if it is still ours. After a stale recovery the
      // on-disk lock may have been re-acquired by a different run; deleting that
      // would let a third run barge in. pid + nonce together uniquely identify
      // our acquisition (the nonce rules out a same-ms startedAt collision and
      // a pid-reuse collision with a later run on the same pid).
      const cur = await readLock(cwd);
      if (cur && cur.pid === info.pid && cur.nonce === info.nonce) {
        try {
          await unlink(path);
        } catch {
          /* already gone — nothing to do */
        }
      }
    },
  };
}

function formatHolder(info: LockInfo): string {
  const lines = ["dag-tickets: another run is active on this repository."];
  if (info.pid > 0) lines.push(`  holder pid:  ${info.pid}`);
  if (info.runId) lines.push(`  run-id:       ${info.runId}`);
  if (info.startedAt) lines.push(`  started:      ${info.startedAt}`);
  if (info.hostname) lines.push(`  host:         ${info.hostname}`);
  lines.push("");
  lines.push(
    "Concurrent runs would collide on the shared dag-<n> worktrees, so this run aborts.",
  );
  lines.push(
    "If the holder is already dead, just re-run dag-tickets — it recovers the stale lock automatically.",
  );
  return lines.join("\n");
}
