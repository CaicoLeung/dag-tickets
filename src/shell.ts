/**
 * Thin shell helper around Bun.spawn. Captures stdout/stderr + exit code,
 * supports stdin and a hard timeout (long agent runs can hang).
 */
export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  /**
   * Per-step progress watchdog: if the process produces no stdout/stderr output
   * for this many ms, kill it and return `timedOut: true`. Resets each time new
   * output arrives. Default: none (watchdog disabled).
   */
  watchdogTimeoutMs?: number;
  /** #43: external kill signal. When aborted the process is killed and the
   *  result carries `aborted: true`. The caller uses this to inject a
   *  per-step progress watchdog without changing the blocking call shape. */
  signal?: AbortSignal;
  /** Extra env merged into the child environment. */
  env?: Record<string, string>;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  /** True if the process was killed by the timeout. */
  timedOut: boolean;
  /** #43: True if the process was killed by an external AbortSignal. */
  aborted: boolean;
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    stdin: opts.input !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Always overlay onto a *live* snapshot of process.env rather than
    // passing `undefined`. Bun.spawn({ env: undefined }) inherits the env the
    // bun process *started with* (a startup snapshot), silently ignoring any
    // runtime mutation of process.env — so a caller that rewrites PATH (e.g.
    // the e2e harness installing gh/paseo shims, or a wrapper adjusting PATH)
    // would see its override dropped. Spreading process.env here makes both
    // branches (opts.env present or absent) behave identically. In prod
    // nothing mutates process.env at runtime, so this is a no-op there.
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  let timedOut = false;
  let aborted = false;
  let timer: Timer | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    }, opts.timeoutMs);
  }
  // #43: external kill signal — the watchdog fires this when it detects no
  // progress for progressTimeoutMs. Distinct from the total --wait-timeout so
  // a stuck agent is killed at 10min instead of burning the full 60min slot.
  if (opts.signal) {
    const onAbort = () => {
      aborted = true;
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    };
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }

  const watchdogMs = opts.watchdogTimeoutMs;
  // When signal is set (the orchestrator's paseo.ts watchdog path), don't
  // use runWithWatchdog — let the signal callback handle the kill.
  if (watchdogMs && watchdogMs > 0 && !opts.signal) {
    const overallMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
    const result = await runWithWatchdog(proc, overallMs, watchdogMs);
    clearTimeout(timer);
    return result;
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { ok: !timedOut && !aborted && code === 0, stdout, stderr, code, timedOut, aborted };
}

/**
 * Read stdout + stderr incrementally from a spawned process. Two independent
 * timers guard the process:
 *  - overallTimeoutMs: absolute wall ceiling — fires once, kills the process,
 *    and sets `timedOut: true`.
 *  - progressTimeoutMs: per-step progress watchdog — resets each time new data
 *    arrives on either stream; fires if no data arrives for this long, kills
 *    the process, and also sets `timedOut: true` (both timer types signal a
 *    transient retry-eligible failure).
 */
async function runWithWatchdog(
  proc: ReturnType<typeof Bun.spawn>,
  overallTimeoutMs: number | undefined,
  progressTimeoutMs: number,
): Promise<RunResult> {
  let timedOut = false;

  // Overall wall timeout: absolute ceiling — fires once, kills the process.
  if (overallTimeoutMs && overallTimeoutMs > 0) {
    setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    }, overallTimeoutMs);
  }

  // Watchdog: reset on each chunk, kill on expiry.
  let watchdog: Timer = setTimeout(() => {}, 0); // initialised immediately below
  clearTimeout(watchdog);
  const resetWatchdog = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    }, progressTimeoutMs);
  };
  resetWatchdog();

  const readTo = async (
    stream: ReadableStream<Uint8Array>,
    buf: { s: string },
  ): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          resetWatchdog();
          buf.s += decoder.decode(value, { stream: true });
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  const stdoutBuf = { s: "" };
  const stderrBuf = { s: "" };

  await Promise.all([
    readTo(proc.stdout as ReadableStream<Uint8Array>, stdoutBuf),
    readTo(proc.stderr as ReadableStream<Uint8Array>, stderrBuf),
  ]);
  const code = await proc.exited;

  clearTimeout(watchdog);
  return { ok: !timedOut && code === 0, stdout: stdoutBuf.s, stderr: stderrBuf.s, code, timedOut, aborted: false };
}

/** Run and throw a formatted error on non-zero exit. */
export async function mustRun(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(cmd, opts);
  if (!r.ok) {
    throw new Error(
      `command failed (${r.code}${r.timedOut ? " timed-out" : ""}): ${cmd.join(" ")}\n${r.stderr}`,
    );
  }
  return r;
}
