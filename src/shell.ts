/**
 * Thin shell helper around Bun.spawn. Captures stdout/stderr + exit code,
 * supports stdin and a hard timeout (long agent runs can hang).
 */
export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
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

  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { ok: !timedOut && code === 0, stdout, stderr, code, timedOut };
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
